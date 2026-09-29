// xyOps API Layer - Extensions
// Copyright (c) 2019 - 2026 PixlCore LLC
// Released under the BSD 3-Clause License.
// See the LICENSE.md file in this repository.

const fs = require('fs');
const Path = require('path');
const cp = require('child_process');
const os = require('os');
const async = require('async');
const Tools = require("pixl-tools");

class Extensions {
	
	api_ext(args, callback) {
		// route api request to named extension
		// e.g. /api/app/ext/pixlcore-xyext-test/mycommand
		var self = this;
		var req = args.request;
		
		var matches = req.url.match(/\bext\/([\w\-]+)/);
		if (!matches) return this.doError('api', "Invalid request: " + req.url, callback);
		
		var ext_id = matches[1];
		var ext = Tools.findObject( this.extensions, { id: ext_id } );
		if (!ext) return this.doError('api', "Unknown extension: " + ext_id, callback);
		if (!ext.obj.handleRequest) return this.doError('api', "Extension does not accept web requests: " + ext_id, callback);
		
		this.logExt(8, "Routing request to extension: " + req.url, { ext_id, req_id: args.id });
		ext.obj.handleRequest(args, callback);
	}
	
	api_ext_install(args, callback) {
		// install, upgrade or delete extension from the marketplace
		// must specify the marketpace ID here (i.e. OWNER/REPO)
		// params: { id, version, restart? }
		var self = this;
		var params = Tools.mergeHashes( args.params, args.query );
		var ext_config = this.config.get('extensions') || {};
		if (!this.requireMaster(args, callback)) return;
		
		if (!this.requireParams(params, {
			id: /^[\w\-\/\.]+$/, // marketplace id
			version: /^(v\d+\.\d+\.\d+|delete)$/
		}, callback)) return;
		
		var mkt_id = params.id;
		var ext_id = mkt_id.replace(/\W+/g, '-').toLowerCase();
		var pkg_id = '@' + mkt_id;
		
		var pkg_ver = params.version.replace(/^v/, '');
		var is_delete = (pkg_ver == 'delete');
		
		this.loadSession(args, function (err, session, user) {
			if (err) return self.doError('session', err.message, callback);
			if (!self.requireAdmin(session, user, callback)) return;
			
			self.getMarketplaceMetadata( function(err, metadata) {
				if (err) return self.doError('ext', '' + err, callback);
				
				// make sure we have npm on the conductor server
				var npm_bin = Tools.findBinSync('npm');
				if (!npm_bin) return self.doError('ext', "Extension system failure: NPM executable not found", callback);
				
				// only install supported extensions and versions
				var product = Tools.findObject( metadata.rows, { id: mkt_id } );
				if (!product || (product.type != 'extension')) {
					return self.doError('ext', 'Extension not found on marketplace: ' + mkt_id, callback);
				}
				if (!is_delete && !product.versions.includes(params.version)) {
					return self.doError('ext', 'Extension version not found on marketplace: ' + mkt_id + ': ' + params.version, callback);
				}
				
				// only one maint job allowed at a time
				if (self.findInternalJobs({ type: 'maint' }).length) {
					return self.doError('ext', "Another maintenance job is already running.", callback);
				}
				
				// run in background (npm may be slow)
				self.logExt(4, is_delete ? `Deleting extension: ${pkg_id}` : `Installing extension: ${pkg_id}@${pkg_ver}` );
				
				// create base directory for npm to work in
				var ext_base_dir = Path.join( 'data', 'extensions' );
				if (!fs.existsSync(ext_base_dir)) {
					try { Tools.mkdirp.sync(ext_base_dir); }
					catch (err) { return self.doError('ext', "Failed to create extension base directory: " + err, callback); }
				}
				
				// load existing package.json file, or create new one
				var ext_pkg_file = Path.join( ext_base_dir, 'package.json' );
				var old_meta = Tools.copyHash( self.extMeta, true );
				var ext_pkg = self.extMeta;
				
				// update package.json file
				if (is_delete) delete ext_pkg.dependencies[ pkg_id ];
				else ext_pkg.dependencies[ pkg_id ] = pkg_ver;
				
				try { fs.writeFileSync( ext_pkg_file, JSON.stringify(ext_pkg, null, "\t") + "\n" ); }
				catch (err) {
					self.extMeta = old_meta;
					return self.doError('ext', "Failed to write extension package file: " + err, callback);
				}
				
				// send response so user isn't waiting
				callback({ code: 0 });
				
				// track install using internal job
				var job = self.startInternalJob({ 
					title: is_delete ? `Delete extension: ${mkt_id}`: `Install extension: ${mkt_id} v${pkg_ver}`, 
					username: user.username || user.id, 
					email: user.email || '', // for report
					type: 'maint'
				});
				
				var child_opts = {
					cwd: ext_base_dir,
					env: Object.assign( {}, self.cleanEnv() ),
					timeout: (ext_config.timeout || 300) * 1000
				};
				
				cp.exec( npm_bin + ' install --no-update-notifier --no-fund', child_opts, function(err, stdout, stderr) {
					// compose job report (details) for email
					job.details = '';
					job.details += "### Extension " + (is_delete ? 'Removal' : 'Installation') + " " + (err ? 'Failed' : 'Completed') + "\n";
					
					job.details += "\n";
					job.details += "- **Extension ID**: `" + ext_id + "`\n";
					job.details += "- **Marketplace ID**: `" + mkt_id + "`\n";
					job.details += "- **Package Name**: `" + pkg_id + "`\n";
					job.details += "- **Title**: " + product.title + "\n";
					if (!is_delete) job.details += "- **Version**: " + pkg_ver + "\n";
					job.details += "- **Publisher**: " + product.author + "\n";
					job.details += "- **Description**: " + product.description + "\n";
					
					// error details
					if (err) {
						job.details += "\n### Error Details\n";
						job.details += "\n";
						job.details += "- **Message**: `" + (err.message || err) + "`\n";
						job.details += "- **Code**: `" + (err.code || 0) + "`\n";
						job.details += "- **Signal**: `" + (err.signal || 0) + "`\n";
						
						// restore extMeta
						self.extMeta = old_meta;
						
						// restore package.json file
						try { fs.writeFileSync( ext_pkg_file, JSON.stringify(old_meta, null, "\t") + "\n" ); }
						catch (err) {
							self.logError('ext', "Failed to restore extension package file: " + err);
						}
					}
					
					job.details += "\n### Command Output\n";
					job.details += "\n```\n" + String(stdout + stderr).trim() + "\n```\n";
					
					job.finish();
					
					if (!err) {
						// sync extensions to all peers on successful install
						self.masterSyncExtensions();
						
						// optionally restart conductor after short delay
						if (params.restart) setTimeout( function() {
							self.doMasterCommand( null, { commands: [ 'restart' ] } );
						}, 5000 );
					}
					
				}); // cp.exec
			} ); // getMarketplaceMetadata
		}); // loadSession
	}
	
	api_create_extension(args, callback) {
		return this.api_ext_install(args, callback);
	}
	
	api_update_extension(args, callback) {
		return this.api_ext_install(args, callback);
	}
	
	api_delete_extension(args, callback) {
		args.params.version = 'delete';
		return this.api_ext_install(args, callback);
	}
	
}; // class

module.exports = Extensions;
