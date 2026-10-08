const assert = require('node:assert/strict');
const Tools = require('pixl-tools');

exports.tests = [

	async function test_api_get_active_servers(test) {
		// list all active servers
		let { data } = await this.request.json( this.api_url + '/app/get_active_servers/v1', {} );
		assert.ok( data.code === 0, 'successful api response' );
		assert.ok( Array.isArray(data.rows), 'expected rows array' );
		assert.ok( data.list && (data.list.length >= 0), 'expected list metadata' );
		assert.ok( Tools.findObject(data.rows, { id: 'satunit1' }), 'expected satunit1 in active servers' );
	},

	async function test_api_get_active_server_missing_param(test) {
		// fetch active server with missing id
		let { data } = await this.request.json( this.api_url + '/app/get_active_server/v1', {} );
		assert.ok( !!data.code, 'expected error for missing id' );
	},

	async function test_api_get_active_server_missing(test) {
		// fetch non-existent active server
		let { data } = await this.request.json( this.api_url + '/app/get_active_server/v1', { id: 'nope' } );
		assert.ok( !!data.code, 'expected error for missing active server' );
	},

	async function test_api_get_active_server(test) {
		// fetch single active server by id
		let { data } = await this.request.json( this.api_url + '/app/get_active_server/v1', { id: 'satunit1' } );
		assert.ok( data.code === 0, 'successful api response' );
		assert.ok( data.server && data.server.id === 'satunit1', 'unexpected server id' );
	},
	
	async function test_satellite_install_preserves_external_port(test) {
		// Generate a normal temporary installer token through the same API used by
		// the Add Server dialog.
		let { data: token_data } = await this.request.json( this.api_url + '/app/get_satellite_token/v1', {} );
		assert.ok( token_data.code === 0, 'successful satellite token response' );
		assert.ok( !!token_data.token, 'expected satellite installer token' );
		
		// Simulate Docker forwarding external port 7552 to the test server's
		// internal port.  The generated script must retain the external port.
		let install_url = this.api_url + '/app/satellite/install?t=' + token_data.token;
		let { resp, data: script } = await this.request.get( install_url, {
			headers: { Host: 'workers.example.test:7552' }
		} );
		
		assert.ok( resp.statusCode === 200, 'successful satellite installer response' );
		assert.match( script.toString(), /^BASE_URL="http:\/\/workers\.example\.test:7552"$/m );
	},
	
	async function test_satellite_install_api_key_with_legacy_support_disabled(test) {
		// Satellite bootstrap deliberately accepts API keys through its t URL token.
		// Create a dedicated key with the privilege required by this exception.
		let { data: key_data } = await this.request.json( this.api_url + '/app/create_api_key/v1', {
			title: 'Unit Test Satellite Install API Key',
			active: 1,
			privileges: { add_servers: 1 }
		});
		assert.equal( key_data.code, 0, 'successful satellite API key creation' );
		
		var config = this.xy.config.get();
		var had_legacy = Object.prototype.hasOwnProperty.call(config, 'legacy_api_key_support');
		var saved_legacy = config.legacy_api_key_support;
		
		try {
			config.legacy_api_key_support = false;
			var install_url = this.api_url + '/app/satellite/install?t=' + encodeURIComponent(key_data.plain_key);
			
			// Clear session credentials so only the API key in t can authenticate.
			// Fetch the script without executing or installing anything.
			let { resp, data: script } = await this.request.get( install_url, {
				headers: { 'X-Session-ID': '', Cookie: '' }
			} );
			assert.equal( resp.statusCode, 200, 'successful satellite installer response' );
			assert.ok( script.toString().includes('AUTH_TOKEN="' + key_data.plain_key + '"'), 'installer retains the API key bootstrap token' );
			
			// The URL exception must still enforce the add_servers privilege.
			let { data: updated } = await this.request.json( this.api_url + '/app/update_api_key/v1', {
				id: key_data.api_key.id,
				privileges: {}
			});
			assert.equal( updated.code, 0, 'successful removal of satellite install privilege' );
			
			let { data } = await this.request.json( install_url, false, {
				headers: { 'X-Session-ID': '', Cookie: '' }
			} );
			assert.equal( data.code, 'access', 'satellite URL API key still requires add_servers' );
		}
		finally {
			// Restore the config and remove the fixture even if an assertion fails.
			if (had_legacy) config.legacy_api_key_support = saved_legacy;
			else delete config.legacy_api_key_support;
			
			let { data } = await this.request.json( this.api_url + '/app/delete_api_key/v1', { id: key_data.api_key.id } );
			assert.equal( data.code, 0, 'successful satellite API key cleanup' );
		}
	},
	
	async function test_satellite_upgrade_preserves_external_https_port(test) {
		// xySat authenticates upgrade requests using its server ID and auth token.
		var server_id = 'satunit1';
		var auth_token = Tools.digestHex( server_id + this.server.config.get('secret_key'), 'sha256' );
		var upgrade_url = this.api_url + '/app/satellite/upgrade?s=' + server_id + '&t=' + auth_token;
		
		// Simulate a TLS-terminating proxy on a nonstandard public port.  The web
		// server detects HTTPS from this forwarded header.
		let { resp, data: script } = await this.request.get( upgrade_url, {
			headers: {
				Host: 'workers.example.test:8443',
				'X-Forwarded-Proto': 'https'
			}
		} );
		
		assert.ok( resp.statusCode === 200, 'successful satellite upgrade response' );
		assert.match( script.toString(), /^BASE_URL="https:\/\/workers\.example\.test:8443"$/m );
	},

	async function test_api_get_server_missing_param(test) {
		// fetch server with missing id
		let { data } = await this.request.json( this.api_url + '/app/get_server/v1', {} );
		assert.ok( !!data.code, 'expected error for missing id' );
	},

	async function test_api_get_server_missing(test) {
		// fetch non-existent server
		let { data } = await this.request.json( this.api_url + '/app/get_server/v1', { id: 'nope' } );
		assert.ok( !!data.code, 'expected error for missing server' );
	},

	async function test_api_get_server(test) {
		// fetch server by id, include data + online flag
		let { data } = await this.request.json( this.api_url + '/app/get_server/v1', { id: 'satunit1' } );
		assert.ok( data.code === 0, 'successful api response' );
		assert.ok( data.server && data.server.id === 'satunit1', 'unexpected server id' );
		assert.ok( typeof data.online === 'boolean', 'expected online boolean' );
		assert.ok( data.data && (typeof data.data === 'object'), 'expected data object' );
	},

	async function test_api_update_server_missing_id(test) {
		// update without id should error
		let { data } = await this.request.json( this.api_url + '/app/update_server/v1', { title: 'oops' } );
		assert.ok( !!data.code, 'expected error for missing id' );
	},

	async function test_api_update_server(test) {
		// update server metadata (disable autoGroup to set explicit groups)
		let groupId = this.group_final_id; // created in groups suite
		let { data } = await this.request.json( this.api_url + '/app/update_server/v1', {
			id: 'satunit1',
			title: 'UT Server',
			enabled: true,
			icon: 'server',
			autoGroup: false,
			groups: groupId ? [ groupId ] : []
		});
		assert.ok( data.code === 0, 'successful api response' );
	},

	async function test_api_get_updated_server(test) {
		// verify updates took effect
		let { data } = await this.request.json( this.api_url + '/app/get_server/v1', { id: 'satunit1' } );
		assert.ok( data.code === 0, 'successful api response' );
		assert.ok( data.server && data.server.title === 'UT Server', 'unexpected server title' );
		assert.ok( data.server.icon === 'server', 'unexpected server icon' );
		if (this.group_final_id) {
			assert.ok( Array.isArray(data.server.groups), 'expected groups array' );
			assert.ok( data.server.groups.includes(this.group_final_id), 'expected server to include final group' );
		}
	},
	
	async function test_api_update_server_destination_groups(test) {
		// A group-limited user may update a server only while both its current
		// and proposed group lists remain visible under the any-match policy.
		let created = await this.request.json( this.api_url + '/app/create_api_key/v1', {
			title: 'Unit Test Restricted Server API Key',
			description: 'Created by server unit tests',
			active: 1,
			privileges: { update_servers: 1 },
			groups: [this.group_final_id]
		});
		assert.ok( created.data.code === 0, 'successful restricted api key creation' );
		
		var key_id = created.data.api_key.id;
		var key_opts = {
			headers: { 'X-Session-ID': '', 'X-API-Key': created.data.plain_key }
		};
		
		try {
			let replaced = await this.request.json( this.api_url + '/app/update_server/v1', {
				id: 'satunit1', autoGroup: false, groups: ['forbidden_group']
			}, key_opts );
			assert.ok( replaced.data.code === 'access', 'replacing with a forbidden group is rejected' );
			
			let cleared = await this.request.json( this.api_url + '/app/update_server/v1', {
				id: 'satunit1', autoGroup: false, groups: []
			}, key_opts );
			assert.ok( cleared.data.code === 'access', 'clearing all server groups is rejected' );
			
			let mixed = await this.request.json( this.api_url + '/app/update_server/v1', {
				id: 'satunit1', autoGroup: false, groups: [this.group_final_id, 'forbidden_group']
			}, key_opts );
			assert.ok( mixed.data.code === 0, 'one matching destination group grants access' );
			
			let restored = await this.request.json( this.api_url + '/app/update_server/v1', {
				id: 'satunit1', groups: [this.group_final_id]
			}, key_opts );
			assert.ok( restored.data.code === 0, 'server groups restored after destination test' );
		}
		finally {
			await this.request.json( this.api_url + '/app/delete_api_key/v1', { id: key_id } );
		}
	},

	async function test_api_update_server_revert(test) {
		// revert autoGroup and clear title/icon
		let { data } = await this.request.json( this.api_url + '/app/update_server/v1', {
			id: 'satunit1',
			title: '',
			icon: '',
			autoGroup: true
		});
		assert.ok( data.code === 0, 'successful api response' );
	},

	async function test_api_get_server_reverted(test) {
		// verify revert
		let { data } = await this.request.json( this.api_url + '/app/get_server/v1', { id: 'satunit1' } );
		assert.ok( data.code === 0, 'successful api response' );
		assert.ok( data.server && data.server.id === 'satunit1', 'unexpected server id' );
		assert.ok( data.server.autoGroup === true, 'expected autoGroup true' );
	},
	
	async function test_api_update_server_data(test) {
		// update server user data
		let { data } = await this.request.json( this.api_url + '/app/update_server_data/v1', {
			id: 'satunit1',
			data: { "foo": "bar1" }
		});
		assert.ok( data.code === 0, 'successful api response' );
	},
	
	async function test_api_get_updated_server_data(test) {
		// verify data updates took effect
		let { data } = await this.request.json( this.api_url + '/app/get_server/v1', { id: 'satunit1' } );
		assert.ok( data.code === 0, 'successful api response' );
		assert.ok( !!data.server, 'server object missing' );
		assert.ok( !!data.server.userData, 'userData object missing' );
		assert.ok( data.server.userData.foo == "bar1", 'unexpected result in user data' );
	},
	
	async function test_api_update_server_data_shallow_merge(test) {
		// update server user data
		let { data } = await this.request.json( this.api_url + '/app/update_server_data/v1', {
			id: 'satunit1',
			data: { "added": "zzz" }
		});
		assert.ok( data.code === 0, 'successful api response' );
	},
	
	async function test_api_get_updated_server_data_merged(test) {
		// verify data updates took effect
		let { data } = await this.request.json( this.api_url + '/app/get_server/v1', { id: 'satunit1' } );
		assert.ok( data.code === 0, 'successful api response' );
		assert.ok( !!data.server, 'server object missing' );
		assert.ok( !!data.server.userData, 'userData object missing' );
		assert.ok( data.server.userData.foo == "bar1", 'unexpected foo result in user data' );
		assert.ok( data.server.userData.added == "zzz", 'unexpected added result in user data' );
	},
	
	async function test_api_get_servers_admin_snapshot(test) {
		// admin endpoint: get snapshot of all connected servers + masters
		let { data } = await this.request.json( this.api_url + '/app/get_servers/v1', {} );
		assert.ok( data.code === 0, 'successful api response' );
		assert.ok( data.servers && typeof data.servers === 'object', 'expected servers object' );
		assert.ok( data.servers['satunit1'], 'expected satunit1 in servers' );
		assert.ok( data.masters && typeof data.masters === 'object', 'expected masters object' );
	},

	async function test_api_get_server_summaries(test) {
		// summaries across indexed servers
		let { data } = await this.request.json( this.api_url + '/app/get_server_summaries/v1', {} );
		assert.ok( data.code === 0, 'successful api response' );
		assert.ok( data.summaries && typeof data.summaries === 'object', 'expected summaries object' );
	},

	async function test_api_stub_watch_server(test) {
		// stubbed: skip watch_server
		assert.ok(true, 'stub watch_server');
	},

	async function test_api_stub_delete_server(test) {
		// stubbed: skip delete_server
		assert.ok(true, 'stub delete_server');
	},
	
	async function test_api_create_snapshot(test) {
		// take snapshot of server
		let { data } = await this.request.json( this.api_url + '/app/create_snapshot/v1', {
			server: 'satunit1'
		} );
		assert.ok( data.code === 0, 'successful api response' );
		assert.ok( !!data.id, 'found snap id in resp' );
		
		this.snapshot_id = data.id;
	},
	
	async function test_api_delete_snapshot(test) {
		// take snapshot of server
		let { data } = await this.request.json( this.api_url + '/app/delete_snapshot/v1', {
			id: this.snapshot_id
		} );
		assert.ok( data.code === 0, 'successful api response' );
		
		delete this.snapshot_id;
	},
	
	async function test_api_create_final_snapshot(test) {
		// take another snapshot of server, for searching later
		let { data } = await this.request.json( this.api_url + '/app/create_snapshot/v1', {
			server: 'satunit1'
		} );
		assert.ok( data.code === 0, 'successful api response' );
		assert.ok( !!data.id, 'found snap id in resp' );
		
		this.final_snapshot_id = data.id;
	},

];
