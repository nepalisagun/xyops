const assert = require('node:assert/strict');
const Tools = require('pixl-tools');
const API = require('../../lib/api.js');

// helper: sleep while waiting for an asynchronously launched job
async function sleep(ms) {
	await new Promise(res => setTimeout(res, ms));
}

// helper: poll active jobs until the specified job has completed
async function waitForJob(ctx, job_id, opts = {}) {
	const timeout = opts.timeout || 20000;
	const interval = opts.interval || 250;
	const start = performance.now();
	
	while (performance.now() - start < timeout) {
		let { data } = await ctx.request.json(ctx.api_url + '/app/get_active_jobs/v1', {});
		if (data.code !== 0) throw new Error('get_active_jobs failed');
		if (!data.rows.find(row => row.id === job_id)) return;
		await sleep(interval);
	}
	
	throw new Error('Timed out waiting for job to finish');
}

exports.tests = [

	async function test_api_get_events(test) {
		// list all events
		let { data } = await this.request.json( this.api_url + '/app/get_events/v1', {} );
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( Array.isArray(data.rows), "expected rows array" );
		assert.ok( data.list && (data.list.length >= 0), "expected list metadata" );
	},

	async function test_api_get_event_missing_param(test) {
		// missing id param
		let { data } = await this.request.json( this.api_url + '/app/get_event/v1', {} );
		assert.ok( !!data.code, "expected error for missing id" );
	},

	async function test_api_create_event_missing_plugin(test) {
		// create event missing plugin should error (non-workflow)
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', {
			"title": "Bad Event",
			"enabled": true,
			"category": this.category_final_id || 'general',
			"targets": ["main"]
		});
		assert.ok( !!data.code, "expected error for missing plugin" );
	},

	async function test_api_create_event_missing_targets(test) {
		// create event missing targets should error (non-workflow)
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', {
			"title": "Bad Event 2",
			"enabled": true,
			"category": this.category_final_id || 'general',
			"plugin": "shellplug"
		});
		assert.ok( !!data.code, "expected error for missing targets" );
	},

	async function test_api_create_event_invalid_limit(test) {
		// invalid limit (duration must be number for time)
		const category_id = this.category_final_id || 'general';
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', {
			"title": "Bad Event 3",
			"enabled": true,
			"category": category_id,
			"targets": ["main"],
			"plugin": "shellplug",
			"limits": [ { enabled: true, type: 'time', duration: 'nope' } ]
		});
		assert.ok( !!data.code, "expected error for invalid limit" );
	},
	
	async function test_api_validate_job_rate_limits(test) {
		// Exercise rate-specific validation directly so the test does not need to
		// create and delete several otherwise-valid events.
		var api = new API();
		var last_error = '';
		api.doError = function(code, msg) {
			last_error = msg;
			return false;
		};
		
		function validate(rate, window) {
			last_error = '';
			var result = api.requireValidLimits({
				limits: [ { type: 'job', enabled: true, amount: 1, rate: rate, window: window } ]
			}, function() {});
			return { result, error: last_error };
		}
		
		// Zero disables the rate while preserving a valid stored window.  All
		// supported fixed-window durations should pass validation.
		[ 1, 60, 3600, 86400 ].forEach( function(window) {
			var check = validate(1, window);
			assert.equal( check.result, true, "accepted fixed rate window: " + window );
			assert.equal( check.error, '', "valid rate window produced no error: " + window );
		} );
		assert.equal( validate(0, 1).result, true, "zero rate is accepted as disabled" );
		
		var fractional = validate(1.5, 60);
		var negative = validate(-1, 60);
		var zero_window = validate(1, 0);
		var custom_window = validate(1, 300);
		assert.equal( fractional.result, false, "fractional rate is rejected" );
		assert.match( fractional.error, /non-negative integer/, "fractional rate returns the expected validation error" );
		assert.equal( negative.result, false, "negative rate is rejected" );
		assert.match( negative.error, /non-negative integer/, "negative rate returns the expected validation error" );
		assert.equal( zero_window.result, false, "zero-length rate window is rejected" );
		assert.match( zero_window.error, /positive number/, "zero-length window returns the expected validation error" );
		assert.equal( custom_window.result, false, "unsupported custom rate window is rejected" );
		assert.match( custom_window.error, /1, 60, 3600, or 86400/, "unsupported window returns the expected validation error" );
	},

	async function test_api_create_event_invalid_action(test) {
		// invalid action (email requires users array or email string)
		const category_id = this.category_final_id || 'general';
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', {
			"title": "Bad Event 4",
			"enabled": true,
			"category": category_id,
			"targets": ["main"],
			"plugin": "shellplug",
			"actions": [ { enabled: true, condition: 'error', type: 'email' } ]
		});
		assert.ok( !!data.code, "expected error for invalid action" );
	},

	async function test_api_create_event(test) {
		// create new event (non-workflow)
		const category_id = this.category_final_id || 'general';
		const single_epoch = 2000000037;
		const range_start = 2000000098;
		const range_end = 2000003729;
		const blackout_start = 2000000159;
		const blackout_end = 2000007359;
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', {
			"title": "Unit Test Event",
			"enabled": true,
			"category": category_id,
			"targets": ["main"],
			"algo": "random",
			"plugin": "shellplug",
			"params": { "script": "#!/bin/bash\necho hello\n", "annotate": false, "json": false },
			"limits": [ { enabled: true, type: 'time', duration: 60 } ],
			"actions": [ { enabled: true, condition: 'error', type: 'email', users: ['admin'] } ],
			"triggers": [
				{ "type": "manual", "enabled": true },
				{ "type": "single", "enabled": true, "epoch": single_epoch },
				{ "type": "range", "enabled": true, "start": range_start, "end": range_end },
				{ "type": "blackout", "enabled": true, "start": blackout_start, "end": blackout_end }
			],
			"notes": "Created by unit tests"
		});
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.event && data.event.id, "expected event in response" );
		
		// Calendar boundary epochs should be floored to whole minutes on create.
		let single = Tools.findObject( data.event.triggers, { type: 'single' } );
		let range = Tools.findObject( data.event.triggers, { type: 'range' } );
		let blackout = Tools.findObject( data.event.triggers, { type: 'blackout' } );
		assert.equal( single.epoch, Math.floor(single_epoch / 60) * 60, "single shot epoch should be minute-aligned" );
		assert.equal( range.start, Math.floor(range_start / 60) * 60, "range start should be minute-aligned" );
		assert.equal( range.end, Math.floor(range_end / 60) * 60, "range end should be minute-aligned" );
		assert.equal( blackout.start, Math.floor(blackout_start / 60) * 60, "blackout start should be minute-aligned" );
		assert.equal( blackout.end, Math.floor(blackout_end / 60) * 60, "blackout end should be minute-aligned" );
		this.event_id = data.event.id;
	},
	
	async function test_api_create_wait_event(test) {
		// Create a dedicated Event with both Manual and Magic Link triggers so
		// the two synchronous API variants can share the same fixture.
		this.wait_event_id = 'wait_api_test';
		this.wait_magic_key = 'unit-test-wait-magic-key';
		
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', {
			id: this.wait_event_id,
			title: 'Wait API Test Event',
			enabled: true,
			category: this.category_final_id || 'general',
			targets: ['main'],
			algo: 'random',
			plugin: 'shellplug',
			params: { script: "#!/bin/bash\necho hello\n", annotate: false, json: false },
			limits: [],
			actions: [],
			triggers: [
				{ type: 'manual', enabled: true },
				{ type: 'magic', enabled: true, key: this.wait_magic_key }
			],
			notes: 'Created by wait API unit tests'
		});
		
		assert.equal( data.code, 0, 'successful wait Event creation' );
		assert.equal( data.event.id, this.wait_event_id, 'expected wait Event ID' );
		assert.ok( Tools.findObject(data.event.triggers, { type: 'magic' }).token, 'Magic Link key was hashed' );
	},
	
	async function test_api_run_event_wait(test) {
		// The /wait suffix should hold the request open and return the completed
		// Job instead of the usual background Job ID response.
		let { data } = await this.request.json( this.api_url + '/app/run_event/v1/wait', {
			id: this.wait_event_id,
			params: {
				duration: 1,
				caller: 'run_event',
				output_file: 'run-event-wait.txt'
			}
		});
		
		assert.equal( data.code, 0, 'successful run_event wait response' );
		assert.ok( data.job && data.job.id, 'response contains the completed Job' );
		assert.equal( data.job.event, this.wait_event_id, 'Job belongs to the requested Event' );
		assert.equal( data.job.params.caller, 'run_event', 'Event parameter override was preserved' );
		assert.equal( data.job.code, 0, 'Job completed successfully' );
		assert.equal( data.job.final, true, 'Job record is fully finalized' );
		assert.equal( data.job.data.num, 42, 'response includes Job output data' );
		assert.equal( data.job.files.length, 1, 'response includes Job output files' );
		assert.equal( data.job.files[0].filename, 'run-event-wait.txt', 'output filename is preserved' );
		assert.equal( data.job.files[0].path, 'files/jobs/' + data.job.id + '/unit-test/run-event-wait.txt', 'output file path is URL-ready' );
	},
	
	async function test_api_magic_204(test) {
		// Reuse the wait Event to verify empty HTTP 204 responses, both suffix
		// orders, and the different headers for background and completed Jobs.
		var base_url = this.api_url + '/app/magic/v1/' + encodeURIComponent(this.wait_magic_key);
		
		for (var suffix of ['/204', '/wait/204', '/204/wait']) {
			var do_wait = suffix.includes('/wait');
			
			// A query value containing /wait must remain an ordinary Job param.
			let { resp, data: raw_data } = await this.request.get(base_url + suffix + '?duration=1&caller=/wait');
			assert.equal( resp.statusCode, 204, suffix + ': HTTP 204 response' );
			assert.equal( raw_data.length, 0, suffix + ': empty response body' );
			
			var id = resp.headers['x-job-id'];
			assert.ok( id, suffix + ': Job ID header is present' );
			
			if (do_wait) {
				assert.equal( resp.headers['x-job-code'], '0', suffix + ': successful Job code header' );
				assert.equal( resp.headers['x-job-description'], 'Unit Test Job Complete', suffix + ': Job description header' );
				assert.equal( resp.headers['x-stream-token'], undefined, suffix + ': no background stream token' );
			}
			else {
				var stream_token = Tools.digestHex( 'stream' + id + this.xy.config.get('secret_key') );
				assert.equal( resp.headers['x-stream-token'], stream_token, suffix + ': valid stream token header' );
				assert.equal( resp.headers['x-job-code'], undefined, suffix + ': no completed Job code' );
				
				// Finish the background Job before the shared Event is deleted.
				await waitForJob(this, id);
			}
			
			// The waiting variants must already have a finalized Job when the
			// response arrives, and all variants must preserve query parameters.
			let { data } = await this.request.json( this.api_url + '/app/get_job/v1', { id: id } );
			assert.equal( data.code, 0, suffix + ': completed Job can be fetched' );
			assert.equal( data.job.final, true, suffix + ': Job is fully finalized' );
			assert.equal( data.job.event, this.wait_event_id, suffix + ': expected Event' );
			assert.equal( data.job.params.caller, '/wait', suffix + ': query parameter was preserved' );
		}
	},
	
	async function test_api_magic_wait(test) {
		// Magic Link parameters remain ordinary Event overrides, while /wait is
		// carried in the URL path and returns the same completed Job shape.
		var url = this.api_url + '/app/magic/v1/' + encodeURIComponent(this.wait_magic_key) + '/wait';
		url += '?duration=1&caller=magic&output_file=magic-wait.txt';
		
		let { data: raw_data } = await this.request.get(url);
		let data = JSON.parse( raw_data.toString('utf8') );
		
		assert.equal( data.code, 0, 'successful Magic Link wait response' );
		assert.ok( data.job && data.job.id, 'response contains the completed Magic Link Job' );
		assert.equal( data.job.event, this.wait_event_id, 'Magic Link launched the expected Event' );
		assert.equal( data.job.source, 'magic', 'Job records the Magic Link source' );
		assert.equal( data.job.params.caller, 'magic', 'Magic Link query parameter was preserved' );
		assert.equal( data.job.code, 0, 'Magic Link Job completed successfully' );
		assert.equal( data.job.final, true, 'Magic Link Job record is fully finalized' );
		assert.equal( data.job.data.num, 42, 'response includes Magic Link Job output data' );
		assert.equal( data.job.files.length, 1, 'response includes Magic Link Job output files' );
		assert.equal( data.job.files[0].filename, 'magic-wait.txt', 'Magic Link output filename is preserved' );
		assert.equal( data.job.files[0].path, 'files/jobs/' + data.job.id + '/unit-test/magic-wait.txt', 'Magic Link output file path is URL-ready' );
	},
	
	async function test_api_delete_wait_event(test) {
		// Clean up the dedicated wait fixture after both endpoint variants run.
		let { data } = await this.request.json( this.api_url + '/app/delete_event/v1', {
			id: this.wait_event_id
		});
		
		assert.equal( data.code, 0, 'successful wait Event deletion' );
		delete this.wait_event_id;
		delete this.wait_magic_key;
	},

	async function test_api_get_new_event(test) {
		// fetch our new event
		let { data } = await this.request.json( this.api_url + '/app/get_event/v1', { id: this.event_id } );
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.event && data.event.id === this.event_id, "event id unexpected" );
		assert.ok( Array.isArray(data.jobs) && typeof data.queued === 'number', "expected jobs and queued in response" );
		assert.ok( Array.isArray(data.event.limits) && data.event.limits.length === 1, "expected one limit" );
		assert.ok( data.event.limits[0].type === 'time' && data.event.limits[0].duration === 60, "unexpected limit content" );
		assert.ok( Array.isArray(data.event.actions) && data.event.actions.length === 1, "expected one action" );
		assert.ok( data.event.actions[0].type === 'email' && data.event.actions[0].enabled === true, "unexpected action content" );
		
		// Verify the normalized trigger epochs were actually persisted.
		let single = Tools.findObject( data.event.triggers, { type: 'single' } );
		let range = Tools.findObject( data.event.triggers, { type: 'range' } );
		let blackout = Tools.findObject( data.event.triggers, { type: 'blackout' } );
		assert.equal( single.epoch % 60, 0, "persisted single shot epoch should be minute-aligned" );
		assert.equal( range.start % 60, 0, "persisted range start should be minute-aligned" );
		assert.equal( range.end % 60, 0, "persisted range end should be minute-aligned" );
		assert.equal( blackout.start % 60, 0, "persisted blackout start should be minute-aligned" );
		assert.equal( blackout.end % 60, 0, "persisted blackout end should be minute-aligned" );
	},

	async function test_api_event_rejects_reserved_job_override(test) {
		// Reserved _xy_override_* params cannot alter launch context or force a
		// server, regardless of account privileges. Validation is shared by APIs.
		let event = Tools.findObject( this.xy.events, { id: this.event_id } );
		for (var key of ['_xy_override_uid', '_xy_override_server']) {
			let error = null;
			let valid = this.xy.requireValidEventData(
				Tools.mergeHashes(event, { params: { [key]: '0' } }),
				function(data) { error = data; }
			);
			
			assert.ok( valid === false, "reserved job override should fail validation" );
			assert.ok( error && error.code === 'api', "expected api validation error" );
			assert.ok( error.description.match(/reserved/), "expected reserved-key error" );
		}
		
		for (var api of ['create_event', 'update_event', 'run_event']) {
			let { data } = await this.request.json( this.api_url + '/app/' + api + '/v1', {
				...event, params: { _xy_override_server: 'outside_server' }
			});
			assert.equal( data.code, 'api', "administrator cannot supply reserved server parameter to " + api );
			assert.ok( data.description.match(/reserved/), "API reports the reserved parameter" );
		}
	},

	async function test_api_update_event_missing_id(test) {
		// update without id should error
		let { data } = await this.request.json( this.api_url + '/app/update_event/v1', { title: 'oops' } );
		assert.ok( !!data.code, "expected error for missing id" );
	},

	async function test_api_update_event(test) {
		// update our event
		const single_epoch = 2000100037;
		const range_start = 2000100098;
		const range_end = 2000103729;
		const blackout_start = 2000100159;
		const blackout_end = 2000107359;
		let { data } = await this.request.json( this.api_url + '/app/update_event/v1', {
			id: this.event_id,
			title: 'UTE v2',
			notes: 'updated by tests',
			triggers: [
				{ type: 'manual', enabled: true },
				{ type: 'single', enabled: true, epoch: single_epoch },
				{ type: 'range', enabled: true, start: range_start, end: range_end },
				{ type: 'blackout', enabled: true, start: blackout_start, end: blackout_end }
			]
		});
		assert.ok( data.code === 0, "successful api response" );
		
		// The same minute normalization must apply when replacing triggers on update.
		let single = Tools.findObject( data.event.triggers, { type: 'single' } );
		let range = Tools.findObject( data.event.triggers, { type: 'range' } );
		let blackout = Tools.findObject( data.event.triggers, { type: 'blackout' } );
		assert.equal( single.epoch, Math.floor(single_epoch / 60) * 60, "updated single shot epoch should be minute-aligned" );
		assert.equal( range.start, Math.floor(range_start / 60) * 60, "updated range start should be minute-aligned" );
		assert.equal( range.end, Math.floor(range_end / 60) * 60, "updated range end should be minute-aligned" );
		assert.equal( blackout.start, Math.floor(blackout_start / 60) * 60, "updated blackout start should be minute-aligned" );
		assert.equal( blackout.end, Math.floor(blackout_end / 60) * 60, "updated blackout end should be minute-aligned" );
	},

	async function test_api_update_event_invalid_limit(test) {
		// invalid limit on update (file.amount must be number)
		let { data } = await this.request.json( this.api_url + '/app/update_event/v1', {
			id: this.event_id,
			limits: [ { enabled: true, type: 'file', amount: 'nope' } ]
		});
		assert.ok( !!data.code, "expected error for invalid limit on update" );
	},

	async function test_api_update_event_invalid_action(test) {
		// invalid action on update (invalid condition)
		let { data } = await this.request.json( this.api_url + '/app/update_event/v1', {
			id: this.event_id,
			actions: [ { enabled: true, condition: 'nope', type: 'email', users: ['admin'] } ]
		});
		assert.ok( !!data.code, "expected error for invalid action on update" );
	},

	async function test_api_update_event_locked_script_non_admin_api_key(test) {
		// create a non-admin API key that can edit events, but cannot edit locked params
		let created = await this.request.json( this.api_url + '/app/create_api_key/v1', {
			title: 'Unit Test Event Edit API Key',
			description: 'Created by event unit tests',
			active: 1,
			privileges: { edit_events: 1 }
		});
		assert.ok( created.data.code === 0, "successful api key creation" );
		assert.ok( created.data.api_key && created.data.api_key.id, "expected api key in response" );
		assert.ok( created.data.plain_key, "expected plain api key" );
		
		let api_key_id = created.data.api_key.id;
		let plain_key = created.data.plain_key;
		let original_script = "#!/bin/bash\necho hello\n";
		let hostile_script = "#!/bin/bash\necho pwned\n";
		let api_headers = {
			'X-Session-ID': '',
			'X-API-Key': plain_key
		};
		
		try {
			// sparse updates may omit the params object entirely, even though the
			// existing plugin has administrator-locked parameters to preserve
			let sparse = await this.request.json( this.api_url + '/app/update_event/v1', {
				id: this.event_id,
				notes: 'updated by tests'
			}, {
				headers: api_headers
			} );
			assert.ok( sparse.data.code === 0, "successful sparse non-admin api response" );
			assert.ok( sparse.data.event.params.script === original_script, "sparse update should preserve locked script" );
			assert.ok( sparse.data.event.params.annotate === false, "sparse update should preserve unlocked params too" );
			
			// attempt to bypass the admin lock by omitting plugin and sending a new script
			let { data } = await this.request.json( this.api_url + '/app/update_event/v1', {
				id: this.event_id,
				title: 'UTE v3',
				params: {
					script: hostile_script,
					annotate: true,
					json: false
				}
			}, {
				headers: api_headers
			} );
			assert.ok( data.code === 0, "successful non-admin api response" );
			assert.ok( data.event && data.event.title === 'UTE v3', "expected unlocked event title update" );
			assert.ok( data.event.params.script === original_script, "locked script should remain unchanged" );
			assert.ok( data.event.params.script !== hostile_script, "locked script should reject non-admin override" );
			assert.ok( data.event.params.annotate === true, "unlocked param should still update" );
			
			// verify the persisted event too, not just the update_event response
			let fetched = await this.request.json( this.api_url + '/app/get_event/v1', { id: this.event_id } );
			assert.ok( fetched.data.code === 0, "successful get_event response" );
			assert.ok( fetched.data.event.params.script === original_script, "persisted locked script should remain unchanged" );
			assert.ok( fetched.data.event.params.script !== hostile_script, "persisted locked script should reject non-admin override" );
			assert.ok( fetched.data.event.params.annotate === true, "persisted unlocked param should still update" );
		}
		finally {
			// clean up the temporary key even if the security assertion fails
			await this.request.json( this.api_url + '/app/delete_api_key/v1', { id: api_key_id } );
		}
	},
	
	async function test_api_get_updated_event(test) {
		// verify updates
		let { data } = await this.request.json( this.api_url + '/app/get_event/v1', { id: this.event_id } );
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.event && data.event.title === 'UTE v3', "unexpected event title" );
		assert.ok( data.event.notes === 'updated by tests', "unexpected event notes" );
		assert.ok( data.event.params.script === "#!/bin/bash\necho hello\n", "locked script should remain unchanged" );
	},

	async function test_api_get_event_history(test) {
		// fetch history for our event
		let { data } = await this.request.json( this.api_url + '/app/get_event_history/v1', { id: this.event_id, limit: 50 } );
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( Array.isArray(data.rows), "expected rows array" );
		assert.ok( data.list && (data.list.length >= 1), "expected at least one history record" );
	},

	async function test_api_run_workflow_preserves_locked_event_script(test) {
		// Reproduce issue #397: A workflow Event Node inherits its locked Shell
		// script from the linked Event, rather than storing it as a node override.
		const category_id = this.category_final_id || 'general';
		const trigger_node_id = 'nlockedtrigger';
		const event_node_id = 'nlockedevent';
		const original_script = "#!/bin/bash\necho hello\n";
		const hostile_script = "#!/bin/bash\necho pwned\n";
		const plugin_default_script = "#!/bin/sh\n\n# Enter your shell script code here";
		
		let created_workflow = await this.request.json( this.api_url + '/app/create_event/v1', {
			title: 'Locked Script Workflow Test',
			enabled: true,
			category: category_id,
			type: 'workflow',
			params: {},
			fields: [],
			limits: [],
			actions: [],
			triggers: [ { id: trigger_node_id, type: 'manual', enabled: true } ],
			workflow: {
				nodes: [
					{ id: trigger_node_id, type: 'trigger', x: 100, y: 100 },
					{
						id: event_node_id,
						type: 'event',
						data: {
							event: this.event_id,
							params: {},
							targets: [],
							algo: '',
							tags: []
						},
						x: 300,
						y: 100
					}
				],
				connections: [
					{ id: 'clockedscript', source: trigger_node_id, dest: event_node_id }
				]
			}
		});
		assert.ok( created_workflow.data.code === 0, "successful workflow creation" );
		assert.ok( created_workflow.data.event && created_workflow.data.event.id, "expected workflow in response" );
		
		let workflow = created_workflow.data.event;
		let workflow_id = workflow.id;
		let created_key = await this.request.json( this.api_url + '/app/create_api_key/v1', {
			title: 'Unit Test Workflow Run API Key',
			description: 'Created by event unit tests',
			active: 1,
			privileges: { run_jobs: 1 }
		});
		assert.ok( created_key.data.code === 0, "successful api key creation" );
		assert.ok( created_key.data.api_key && created_key.data.api_key.id, "expected api key in response" );
		assert.ok( created_key.data.plain_key, "expected plain api key" );
		
		let api_key_id = created_key.data.api_key.id;
		let plain_key = created_key.data.plain_key;
		
		try {
			// Match the browser's manual-run behavior by posting a full copy of the
			// workflow.  Also inject a hostile locked override to verify that the
			// server restores the original node state, which here means inheritance.
			let run_payload = Tools.copyHash(workflow, true);
			let event_node = Tools.findObject(run_payload.workflow.nodes, { id: event_node_id });
			event_node.data.params.script = hostile_script;
			
			let { data } = await this.request.json( this.api_url + '/app/run_event/v1', run_payload, {
				headers: {
					'X-Session-ID': '',
					'X-API-Key': plain_key
				}
			});
			assert.ok( data.code === 0, "successful non-admin workflow run" );
			assert.ok( data.id, "expected workflow job id in response" );
			
			// Wait for both the parent workflow and its child Event job to finish,
			// then inspect the exact params delivered to the child job.
			await waitForJob(this, data.id);
			let { data:parent_data } = await this.request.json( this.api_url + '/app/get_job', { id: data.id } );
			assert.ok( parent_data.code === 0 && parent_data.job, "expected completed workflow job" );
			assert.ok( parent_data.job.code === 0, "workflow completed successfully" );
			assert.ok( parent_data.job.workflow.jobs[event_node_id], "expected child job for Event Node" );
			assert.ok( parent_data.job.workflow.jobs[event_node_id].length === 1, "expected exactly one child job" );
			
			let child_job_id = parent_data.job.workflow.jobs[event_node_id][0].id;
			let { data:child_data } = await this.request.json( this.api_url + '/app/get_job', { id: child_job_id } );
			assert.ok( child_data.code === 0 && child_data.job, "expected completed child job" );
			assert.ok( child_data.job.params.script === original_script, "child job inherited the linked Event script" );
			assert.ok( child_data.job.params.script !== hostile_script, "locked runtime script override was rejected" );
			assert.ok( child_data.job.params.script !== plugin_default_script, "linked Event script was not replaced by Plugin default" );
		}
		finally {
			// Clean up temporary definitions even if one of the regression assertions fails.
			await this.request.json( this.api_url + '/app/delete_api_key/v1', { id: api_key_id } );
			await this.request.json( this.api_url + '/app/delete_event/v1', { id: workflow_id } );
		}
	},

	async function test_api_delete_event_missing_id(test) {
		// delete without id should error
		let { data } = await this.request.json( this.api_url + '/app/delete_event/v1', {} );
		assert.ok( !!data.code, "expected error for missing id" );
	},

	async function test_api_delete_event_nonexistent(test) {
		// delete non-existent event should error
		let { data } = await this.request.json( this.api_url + '/app/delete_event/v1', { id: 'nope' } );
		assert.ok( !!data.code, "expected error for missing event" );
	},

	async function test_api_delete_event(test) {
		// delete our event
		let { data } = await this.request.json( this.api_url + '/app/delete_event/v1', { id: this.event_id } );
		assert.ok( data.code === 0, "successful api response" );
	},

	async function test_api_get_event_deleted(test) {
		// ensure deleted
		let { data } = await this.request.json( this.api_url + '/app/get_event/v1', { id: this.event_id } );
		assert.ok( !!data.code, "expected error for missing event" );
		delete this.event_id;
	},

];
