// xyOps System Hook Credential and Email Tests
// Copyright (c) 2019 - 2026 PixlCore LLC
// Released under the BSD 3-Clause License.
// See the LICENSE.md file in this repository.

const assert = require('node:assert/strict');
const fs = require('fs');
const cp = require('child_process');
const Tools = require('pixl-tools');
const PixlMail = require('pixl-mail');
const API = require('../../lib/api.js');
const Actions = require('../../lib/action.js');
const FancyMailer = require('../../lib/mailer.js');
const Util = require('../../lib/util.js');

function collectActivity(headers) {
	// Use synthetic credentials only, and retain a session ID as login activity
	// does internally for the "logout all sessions" feature.
	return new API().getClientInfo({
		ip: '127.0.0.1',
		ips: [ '127.0.0.1' ],
		request: { headers },
		user: { username: 'hook_tester' }
	}, { description: 'Synthetic activity', session_id: 'session-credential' });
}

function captureHook(action, data, hook) {
	// Capture every outgoing channel without making network requests, spawning
	// commands, storing tickets, or sending email.
	var outputs = {};
	var receiver = {
		config: {
			get: key => (key == 'hooks') ? { '*': hook } : null,
			getPath: () => null
		},
		server: { __version: 'test' },
		hostID: 'test-conductor',
		messageSub: Util.prototype.messageSub,
		logAction() {},
		logError() {},
		cleanEnv: () => ({}),
		request: {
			json(url, data, opts, callback) {
				outputs.url = url;
				outputs.webhook = Tools.copyHash(data, true);
				callback(null, { statusCode: 200, statusMessage: 'OK' }, {});
			}
		},
		fireWebHook(id, data) {
			outputs.configured_webhook = Tools.copyHash(data, true);
		},
		sendFancyMail(name, data, callback) {
			outputs.email = Tools.copyHash(data, true);
			callback(null, '', []);
		},
		loadMailTemplate(name, callback) {
			callback(null, '{{json}}\nSession: {{session_id}}');
		},
		getState: () => 1,
		unbase: {
			insert(opts, callback) {
				outputs.ticket = Tools.copyHash(opts.data, true);
				// Capture only; do not execute persistence side effects.
			}
		}
	};
	
	// Shell hooks share child_process with the application.  Restore the stub
	// synchronously before returning, even if an assertion or hook throws.
	var original_exec = cp.exec;
	try {
		cp.exec = function(command, opts, callback) {
			return { stdin: {
				on() {},
				write(text) { outputs.shell = JSON.parse(text); },
				end() {}
			} };
		};
		Actions.prototype.fireSystemHook.call(receiver, action, data);
	}
	finally {
		cp.exec = original_exec;
	}
	
	return outputs;
}

function renderMail(args, format) {
	// Exercise the real markdown mailer, pixl-mail parser, and MIME generator.
	// A custom in-memory transport captures the final message and cannot use SMTP.
	return new Promise((resolve, reject) => {
		var config = {
			email_from: 'xyops@example.com',
			base_app_url: 'https://example.invalid',
			client: { name: 'xyOps', company: 'PixlCore', logo_url: 'logo.png' },
			email_format: format,
			ui: { marked_config: {} }
		};
		var mime = '';
		var receiver = {
			config: {
				get: key => config[key],
				getPath: path => Tools.getPath(config, path)
			},
			server: { __version: 'test' },
			messageSub: Util.prototype.messageSub,
			fancyMailTemplate: '<html><body>{{markdown}}</body></html>',
			logDebug: function() {},
			loadMailTemplate(name, callback) {
				callback(null, fs.readFileSync('sample_conf/emails/activity.txt', 'utf8'));
			},
			sendEmail(message, args, callback) {
				var mailer = new PixlMail();
				mailer.setOptions({
					send(mail, done) {
						var chunks = [];
						var stream = mail.message.createReadStream();
						stream.on('data', chunk => chunks.push(chunk));
						stream.on('error', done);
						stream.on('end', function() {
							mime = Buffer.concat(chunks).toString();
							done(null, {});
						});
					}
				});
				mailer.send(message, args, callback);
			}
		};
		
		FancyMailer.prototype.sendFancyMail.call(receiver, 'activity', args, function(err, body) {
			if (err) reject(err);
			else resolve({ mime, body });
		});
	});
}

exports.tests = [
	
	async function test_activity_redacts_sensitive_headers(test) {
		// Node.js lowercases incoming HTTP header names.  Filtering must preserve
		// safe headers without modifying the original authentication request.
		var names = [ 'x-api-key', 'x-session-id', 'x-csrf-token', 'authorization', 'proxy-authorization', 'cookie' ];
		var headers = { 'content-type': 'application/json', 'user-agent': 'Hook Unit Tester' };
		names.forEach(function(name) {
			headers[name] = 'secret-' + name;
		});
		var original = Tools.copyHash(headers, true);
		var data = collectActivity(headers);
		
		assert.deepEqual(data.headers, { 'content-type': 'application/json', 'user-agent': 'Hook Unit Tester' });
		assert.deepEqual(headers, original, 'authentication request remains intact');
		data.headers['user-agent'] = 'Changed';
		assert.equal(headers['user-agent'], 'Hook Unit Tester', 'activity owns its header copy');
		assert.equal(data.session_id, 'session-credential', 'internal session management retains the ID');
		
		for (let headers of [ undefined, null, {} ]) {
			assert.deepEqual(collectActivity(headers).headers, {}, 'empty headers are supported');
		}
	},
	
	async function test_system_hooks_exclude_credentials(test) {
		var data = collectActivity({ 'content-type': 'application/json', 'x-csrf-token': 'secret-csrf', cookie: 'secret-cookie' });
		var original = Tools.copyHash(data, true);
		var outputs = captureHook('user_login', data, {
			url: 'https://example.invalid/hook?session={{session_id}}',
			web_hook: 'test_hook',
			shell_exec: 'test-command',
			email: 'notice@example.com',
			ticket: {}
		});
		
		assert.equal(outputs.url, 'https://example.invalid/hook?session=', 'URL expansion cannot access the session ID');
		for (let key of [ 'webhook', 'configured_webhook', 'shell', 'email', 'ticket' ]) {
			assert.ok(outputs[key], 'captured hook output: ' + key);
			assert.doesNotMatch(JSON.stringify(outputs[key]), /secret-|session-credential/, 'no credentials in ' + key);
		}
		assert.equal(outputs.email.headers, undefined, 'HTTP headers are excluded from MIME arguments');
		assert.equal(JSON.parse(outputs.email.json).headers['content-type'], 'application/json', 'safe HTTP headers remain in body data');
		assert.equal(outputs.webhook.headers['content-type'], 'application/json', 'safe webhook data is preserved');
		assert.deepEqual(data, original, 'hook processing preserves internal activity data');
	},
	
	async function test_activity_email_has_one_content_type(test) {
		// Check HTML and plain text, including the final MIME rather than just the
		// intermediate string passed into pixl-mail.
		for (let format of [ 'html', 'text' ]) {
			var data = collectActivity({ 'content-type': 'application/json', 'x-csrf-token': 'secret-csrf' });
			var outputs = captureHook('update_event', data, { email: 'notice@example.com' });
			var result = await renderMail(outputs.email, format);
			var mime_headers = result.mime.split(/\r?\n\r?\n/)[0];
			
			assert.equal((mime_headers.match(/^Content-Type:/gmi) || []).length, 1, 'one MIME Content-Type for ' + format);
			assert.doesNotMatch(mime_headers, /application\/json|x-csrf-token/i, 'no HTTP headers in MIME block');
			assert.doesNotMatch(result.body, /secret-|session-credential/, 'no credentials in email headers or body');
			assert.match(result.body, /application\/json/, 'sanitized activity data remains in the body');
		}
	},
	
	async function test_custom_email_mime_headers_remain_supported(test) {
		// send_email intentionally passes MIME headers using the documented headers
		// parameter.  The system-hook fix must preserve this contract.
		var result = await renderMail({
			email_to: 'notice@example.com',
			description: 'Custom email',
			json: '{}',
			headers: { Importance: 'High', 'X-Priority': '1' }
		}, 'html');
		var mime_headers = result.mime.split(/\r?\n\r?\n/)[0];
		
		assert.match(mime_headers, /^Importance: High$/mi);
		assert.match(mime_headers, /^X-Priority: 1$/mi);
	},
	
	async function test_job_system_hook_email_preserves_data(test) {
		// Internal job activity has no HTTP headers, and should still render its
		// existing metadata after the activity mail arguments are separated.
		var outputs = captureHook('job_success', { job: { id: 'test-job', code: 0 }, description: 'Job succeeded' }, { email: 'notice@example.com' });
		var result = await renderMail(outputs.email, 'text');
		
		assert.deepEqual(JSON.parse(outputs.email.json).job, { id: 'test-job', code: 0 });
		assert.match(result.body, /Job succeeded/);
		assert.match(result.body, /test-job/);
	}
	
];
