const assert = require('node:assert/strict');
const Tools = require('pixl-tools');
const API = require('../../lib/api.js');

exports.tests = [

	async function test_api_get_groups(test) {
		// list all groups
		let { data } = await this.request.json( this.api_url + '/app/get_groups/v1', {} );
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( Array.isArray(data.rows), "expected rows array" );
		assert.ok( data.list && (data.list.length >= 0), "expected list metadata" );
	},
	
	async function test_group_limited_resource_helpers(test) {
		// Reads and concrete resource access retain any-match semantics, so one
		// shared group grants access even when the resource has other groups.
		var cuser = {
			privileges: {},
			categories: [],
			groups: ['allowed']
		};
		
		var events = [
			{ id: 'workflow', type: 'workflow', category: 'general', targets: [] },
			{ id: 'empty', type: 'normal', category: 'general', targets: [] },
			{ id: 'servers_only', type: 'normal', category: 'general', targets: ['server123'] },
			{ id: 'shared', type: 'normal', category: 'general', targets: ['allowed', 'forbidden', 'server123'] },
			{ id: 'forbidden', type: 'normal', category: 'general', targets: ['forbidden', 'server123'] }
		];
		var event_ids = this.xy.getUserLimitedEvents(cuser, events).map( event => event.id );
		assert.deepEqual( event_ids, ['workflow', 'shared'], "event filtering uses any-match and explicitly allows workflows" );
		
		var jobs = [
			{ id: 'workflow', type: 'workflow', category: 'general', targets: [] },
			{ id: 'empty', type: 'normal', category: 'general', targets: [] },
			{ id: 'shared', type: 'normal', category: 'general', targets: ['allowed', 'forbidden'] },
			{ id: 'forbidden', type: 'normal', category: 'general', targets: ['forbidden'] }
		];
		var job_ids = this.xy.getUserLimitedJobs(cuser, jobs).map( job => job.id );
		assert.deepEqual( job_ids, ['workflow', 'shared'], "job filtering uses any-match and explicitly allows workflows" );
		
		// Empty group lists on concrete resources are not the workflow special case,
		// so they remain outside every group-limited user's scope.
		var servers = [
			{ id: 'empty', groups: [] },
			{ id: 'shared', groups: ['allowed', 'forbidden'] },
			{ id: 'forbidden', groups: ['forbidden'] }
		];
		var server_ids = this.xy.getUserLimitedServers(cuser, servers).map( server => server.id );
		assert.deepEqual( server_ids, ['shared'], "server filtering uses any-match and rejects empty groups" );
		
		var alerts = [
			{ id: 'empty', groups: [] },
			{ id: 'shared', groups: ['allowed', 'forbidden'] },
			{ id: 'forbidden', groups: ['forbidden'] }
		];
		var alert_ids = this.xy.getUserLimitedAlerts(cuser, alerts).map( alert => alert.id );
		assert.deepEqual( alert_ids, ['shared'], "alert filtering uses any-match and rejects empty groups" );
		
		var user = { privileges: {}, roles: [], groups: ['allowed'] };
		assert.ok( !this.xy.checkTargetPrivilege(user, ['server123']), "individual server targets alone deny access" );
		assert.ok( !this.xy.checkTargetPrivilege(user, ['forbidden', 'server123']), "disallowed groups and servers deny access" );
		assert.ok( this.xy.checkTargetPrivilege(user, ['allowed', 'forbidden', 'server123']), "legacy read checks retain any-match target access" );
		assert.ok( this.xy.checkTargetPrivilege(user, []), "empty workflow targets retain their existing access behavior" );
		
		// Empty target arrays are only valid for workflows.  This preserves the
		// invariant used by checkTargetPrivilege() to recognize workflow targets.
		var validation_error = null;
		var valid = this.xy.requireValidEventData({ type: 'normal', targets: [] }, function(data) { validation_error = data; });
		assert.ok( !valid && validation_error, "ordinary events cannot have empty target arrays" );
		assert.ok( this.xy.requireValidEventData({
			type: 'workflow',
			targets: [],
			workflow: { nodes: [], connections: [] }
		}, function() {}), "workflows retain empty target arrays" );
	},
	
	async function test_all_target_privileges(test) {
		// Use a small independent account fixture to cover direct grants, role
		// grants, and administrator bypasses without changing stored accounts.
		var api = new API();
		api.roles = [
			{ id: 'target_role', enabled: true, groups: ['second_allowed'] },
			{ id: 'admin_role', enabled: true, privileges: { admin: true } }
		];
		api.doError = function(code, description, callback) {
			callback({ code, description });
			return false;
		};
		
		var user = { privileges: {}, roles: ['target_role'], groups: ['allowed'] };
		var cases = [
			{ targets: ['allowed'], allowed: true },
			{ targets: ['allowed', 'second_allowed'], allowed: true },
			{ targets: ['allowed', 'forbidden', 'server123'], allowed: false },
			{ targets: ['forbidden', 'allowed'], allowed: false },
			{ targets: ['allowed', 'server123'], allowed: false },
			{ targets: [], allowed: true }
		];
		
		cases.forEach( function(item) {
			var errors = [];
			var allowed = api.requireAllTargetPrivileges(user, item.targets, function(data) { errors.push(data); });
			assert.equal( allowed, item.allowed, "expected execution access for targets: " + item.targets.join(', ') );
			assert.equal( errors.length, item.allowed ? 0 : 1, "first denied target sends exactly one response" );
			if (errors.length) assert.equal( errors[0].code, 'access', "denied execution returns an access error" );
		});
		
		// The new helper inherits the existing administrator and unrestricted
		// account bypasses, including administrator privileges from a role.
		assert.ok( api.requireAllTargetPrivileges({ privileges: { admin: true }, groups: ['allowed'] }, ['forbidden'], function() {}), "direct administrator bypass is retained" );
		assert.ok( api.requireAllTargetPrivileges({ privileges: {}, roles: ['admin_role'], groups: ['allowed'] }, ['forbidden'], function() {}), "role administrator bypass is retained" );
		assert.ok( api.requireAllTargetPrivileges({ privileges: {}, groups: [] }, ['forbidden'], function() {}), "unrestricted account bypass is retained" );
		assert.ok( api.requireTargetPrivilege(user, ['allowed', 'other_group'], function() {}), "server membership checks still require only one allowed group" );
	},
	
	async function test_api_group_limited_execution_targets(test) {
		// Exercise the public APIs with a restricted key and a dedicated Event.
		// The repository harness runs jobs on its mock satellite, not a live host.
		let created_key = await this.request.json( this.api_url + '/app/create_api_key/v1', {
			title: 'Unit Test Target Access Key',
			groups: ['main'],
			privileges: { create_events: 1, edit_events: 1, run_jobs: 1, update_jobs: 1 }
		});
		assert.equal( created_key.data.code, 0, "created group-limited key" );
		
		var key_id = created_key.data.api_key.id;
		var options = { headers: { 'X-Session-ID': '', 'X-API-Key': created_key.data.plain_key } };
		var event_id = '';
		var job_id = '';
		var event = {
			title: 'Unit Test Target Access Event', enabled: true,
			category: 'general', plugin: 'shellplug', algo: 'random', targets: ['main'],
			params: { script: '#!/bin/sh\necho targets\n', duration: 1 }, triggers: [ { type: 'manual', enabled: true } ]
		};
		
		try {
			let created = await this.request.json( this.api_url + '/app/create_event/v1', event, options );
			assert.equal( created.data.code, 0, "allowed target can create an Event" );
			event_id = created.data.event.id;
			
			// Hold one job on the conductor so live target updates can be checked
			// before any dispatch. The administrator creates this delayed fixture.
			let delayed = await this.request.json( this.api_url + '/app/run_event/v1', {
				id: event_id, state: 'start_delay', until: Tools.timeNow() + 60
			});
			assert.equal( delayed.data.code, 0, "created delayed job fixture" );
			job_id = delayed.data.id;
			assert.equal( this.xy.activeJobs[job_id].state, 'start_delay', "fixture remains on the conductor before dispatch" );
			
			for (var targets of [ ['main', 'forbidden_group'], ['main', 'outside_server'] ]) {
				let created = await this.request.json( this.api_url + '/app/create_event/v1', { ...event, targets }, options );
				assert.equal( created.data.code, 'access', "mixed targets cannot create an Event" );
				
				let updated = await this.request.json( this.api_url + '/app/update_event/v1', { id: event_id, targets }, options );
				assert.equal( updated.data.code, 'access', "mixed targets cannot update an Event" );
				assert.deepEqual( Tools.findObject(this.xy.events, { id: event_id }).targets, ['main'], "denied update preserves stored targets" );
				
				let ran = await this.request.json( this.api_url + '/app/run_event/v1', { id: event_id, targets }, options );
				assert.equal( ran.data.code, 'access', "mixed runtime target arrays cannot launch a job" );
				assert.equal( this.xy.findActiveJobs({ event: event_id }).length, 1, "denied run creates no additional job" );
				
				let live = await this.request.json( this.api_url + '/app/update_active_job/v1', { id: job_id, targets }, options );
				assert.equal( live.data.code, 'access', "mixed targets cannot update a live job" );
				assert.deepEqual( this.xy.activeJobs[job_id].targets, ['main'], "denied live update preserves job targets" );
			}
			
			// Existing mixed-target Events still support reads, but restricted
			// accounts cannot edit or run them, even with an allowed replacement.
			let mixed = await this.request.json( this.api_url + '/app/update_event/v1', { id: event_id, targets: ['main', 'forbidden_group'] } );
			assert.equal( mixed.data.code, 0, "administrator can save mixed targets" );
			let fetched = await this.request.json( this.api_url + '/app/get_event/v1', { id: event_id }, options );
			assert.equal( fetched.data.code, 0, "mixed-target Event retains legacy read access" );
			
			for (var api of ['update_event', 'run_event']) {
				let denied = await this.request.json( this.api_url + '/app/' + api + '/v1', { id: event_id, targets: ['main'] }, options );
				assert.equal( denied.data.code, 'access', "existing mixed targets block " + api );
			}
			
			let restored = await this.request.json( this.api_url + '/app/update_event/v1', { id: event_id, targets: ['main'] } );
			assert.equal( restored.data.code, 0, "administrator restores allowed targets" );
			
			// Check the original live-job targets as well as replacement targets.
			// Releasing or resuming a mixed-target job must use the same rule.
			let mixed_job = await this.request.json( this.api_url + '/app/update_active_job/v1', { id: job_id, targets: ['main', 'forbidden_group'] } );
			assert.equal( mixed_job.data.code, 0, "administrator can set mixed live targets" );
			for (var api of ['update_active_job', 'job_skip_delay', 'resume_job']) {
				let denied = await this.request.json( this.api_url + '/app/' + api + '/v1', { id: job_id, targets: ['main'] }, options );
				assert.equal( denied.data.code, 'access', "existing mixed live targets block " + api );
			}
			let restored_job = await this.request.json( this.api_url + '/app/update_active_job/v1', { id: job_id, targets: ['main'] } );
			assert.equal( restored_job.data.code, 0, "administrator restores allowed live targets" );
			
			let live = await this.request.json( this.api_url + '/app/update_active_job/v1', { id: job_id, targets: ['main'] }, options );
			assert.equal( live.data.code, 0, "allowed live target update succeeds" );
			let ran = await this.request.json( this.api_url + '/app/run_event/v1/wait', { id: event_id, targets: ['main'] }, options );
			assert.equal( ran.data.code, 0, "allowed manual run succeeds" );
			assert.equal( ran.data.job.code, 0, "allowed job completes on the mock satellite" );
		}
		finally {
			// Clean up with the administrator session, including the delayed job
			// if an assertion failed before the positive run completed.
			if (job_id && this.xy.activeJobs[job_id]) {
				await this.request.json( this.api_url + '/app/abort_job/v1', { id: job_id } );
				await new Promise( (resolve, reject) => this.xy.waitForJob(job_id, function(err) { err ? reject(err) : resolve(); }) );
			}
			if (event_id) await this.request.json( this.api_url + '/app/delete_event/v1', { id: event_id } );
			await this.request.json( this.api_url + '/app/delete_api_key/v1', { id: key_id } );
		}
	},
	
	async function test_recursive_workflow_privilege_helper(test) {
		// Workflow reads use only the top-level category, but create, update and
		// manual run operations must validate every reachable nested node.
		var user = { privileges: {}, roles: [], categories: ['allowed_cat'], groups: ['allowed_group'] };
		var eventNode = function(id, targets) {
			return { type: 'event', data: { event: id, targets: targets || [] } };
		};
		var workflow = function(id, nodes) {
			return { id: id, type: 'workflow', category: 'allowed_cat', targets: [], workflow: { nodes: nodes } };
		};
		var original_events = this.xy.events;
		this.xy.events = original_events.concat([
			{ id: 'allowed_event', type: 'normal', category: 'allowed_cat', targets: ['allowed_group'] },
			{ id: 'mixed_event', type: 'normal', category: 'allowed_cat', targets: ['allowed_group', 'forbidden_group'] },
			workflow('mixed_workflow', [eventNode('mixed_event')]),
			workflow('nested_workflow', [eventNode('allowed_event'), eventNode('cyclic_workflow')]),
			workflow('cyclic_workflow', [eventNode('nested_workflow')]),
			workflow('forbidden_workflow', [
				{ type: 'job', data: { category: 'forbidden_cat', targets: ['allowed_group'] } }
			])
		]);
		
		try {
			var allowed = this.xy.requireWorkflowPrivileges(user, {
				nodes: [eventNode('nested_workflow')]
			}, function() {});
			assert.ok( allowed, "recursive allowed workflow passes, including a safe cycle" );
			
			var error = null;
			var denied = this.xy.requireWorkflowPrivileges(user, {
				nodes: [eventNode('allowed_event', ['forbidden_group'])]
			}, function(data) { error = data; });
			assert.ok( !denied && error, "forbidden Event Node target override is rejected" );
			
			// One allowed target must not authorize other targets on the same
			// node, whether supplied by an override or a nested saved Event.
			for (var nodes of [
				[eventNode('allowed_event', ['allowed_group', 'forbidden_group'])],
				[eventNode('mixed_workflow')],
				[{ type: 'job', data: { category: 'allowed_cat', targets: ['allowed_group', 'forbidden_group'] } }]
			]) {
				error = null;
				denied = this.xy.requireWorkflowPrivileges(user, { nodes }, function(data) { error = data; });
				assert.ok( !denied && error && (error.code == 'access'), "mixed workflow targets are rejected" );
			}
			
			error = null;
			denied = this.xy.requireWorkflowPrivileges(user, {
				nodes: [eventNode('forbidden_workflow')]
			}, function(data) { error = data; });
			assert.ok( !denied && error, "forbidden Job Node category in a nested workflow is rejected" );
		}
		finally {
			this.xy.events = original_events;
		}
	},

	async function test_api_get_group_missing_param(test) {
		// missing id param
		let { data } = await this.request.json( this.api_url + '/app/get_group/v1', {} );
		assert.ok( !!data.code, "expected error for missing id" );
	},

	async function test_api_get_group_missing(test) {
		// non-existent group
		let { data } = await this.request.json( this.api_url + '/app/get_group/v1', { id: 'nope' } );
		assert.ok( !!data.code, "expected error for missing group" );
	},

	async function test_api_create_group_missing_title(test) {
		// missing required title
		let { data } = await this.request.json( this.api_url + '/app/create_group/v1', {
			"hostname_match": ".+"
		});
		assert.ok( !!data.code, "expected error for missing title" );
	},

	async function test_api_create_group_missing_hostname(test) {
		// missing required hostname_match
		let { data } = await this.request.json( this.api_url + '/app/create_group/v1', {
			"title": "Unit Test Group"
		});
		assert.ok( !!data.code, "expected error for missing hostname_match" );
	},

	async function test_api_create_group_invalid_action(test) {
		// invalid alert action (invalid condition)
		let { data } = await this.request.json( this.api_url + '/app/create_group/v1', {
			"title": "Bad Group",
			"hostname_match": ".+",
			"alert_actions": [ { "enabled": true, "condition": "nope", "type": "email", "users": ["admin"] } ]
		});
		assert.ok( !!data.code, "expected error for invalid alert action" );
	},

	async function test_api_create_group(test) {
		// create new group
		let { data } = await this.request.json( this.api_url + '/app/create_group/v1', {
			"title": "Unit Test Group",
			"hostname_match": ".+",
			"notes": "Created by unit tests"
		});
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.group && data.group.id, "expected group in response" );
		this.group_id = data.group.id;
	},

	async function test_api_get_new_group(test) {
		// fetch our group
		let { data } = await this.request.json( this.api_url + '/app/get_group/v1', { id: this.group_id } );
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.group && data.group.id === this.group_id, "group id unexpected" );
		assert.ok( data.group.title === 'Unit Test Group', "unexpected group title" );
		assert.ok( !!data.group.hostname_match, "expected hostname_match" );
	},

	async function test_api_update_group_missing_id(test) {
		// update without id should error
		let { data } = await this.request.json( this.api_url + '/app/update_group/v1', { title: 'oops' } );
		assert.ok( !!data.code, "expected error for missing id" );
	},

	async function test_api_update_group(test) {
		// update our group
		let { data } = await this.request.json( this.api_url + '/app/update_group/v1', {
			id: this.group_id,
			title: 'UTG v2',
			hostname_match: '^satunit'
		});
		assert.ok( data.code === 0, "successful api response" );
	},

	async function test_api_update_group_invalid_action(test) {
		// invalid alert action on update (missing users/email)
		let { data } = await this.request.json( this.api_url + '/app/update_group/v1', {
			id: this.group_id,
			alert_actions: [ { enabled: true, condition: 'error', type: 'email' } ]
		});
		assert.ok( !!data.code, "expected error for invalid alert action on update" );
	},

	async function test_api_get_updated_group(test) {
		// verify updates
		let { data } = await this.request.json( this.api_url + '/app/get_group/v1', { id: this.group_id } );
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.group && data.group.title === 'UTG v2', "unexpected group title" );
		assert.ok( data.group.hostname_match === '^satunit', "unexpected hostname_match" );
	},

	async function test_api_delete_group_missing_id(test) {
		// delete without id should error
		let { data } = await this.request.json( this.api_url + '/app/delete_group/v1', {} );
		assert.ok( !!data.code, "expected error for missing id" );
	},

	async function test_api_delete_group_nonexistent(test) {
		// delete non-existent group should error
		let { data } = await this.request.json( this.api_url + '/app/delete_group/v1', { id: 'nope' } );
		assert.ok( !!data.code, "expected error for missing group" );
	},

	async function test_api_delete_group(test) {
		// delete our group
		let { data } = await this.request.json( this.api_url + '/app/delete_group/v1', { id: this.group_id } );
		assert.ok( data.code === 0, "successful api response" );
	},

	async function test_api_get_group_deleted(test) {
		// ensure deleted
		let { data } = await this.request.json( this.api_url + '/app/get_group/v1', { id: this.group_id } );
		assert.ok( !!data.code, "expected error for missing group" );
		delete this.group_id;
	},

	async function test_api_stub_multi_update_group(test) {
		// stubbed: skip multi_update_group
		assert.ok(true, 'stub multi_update_group');
	},

	async function test_api_stub_watch_group(test) {
		// stubbed: skip watch_group
		assert.ok(true, 'stub watch_group');
	},

	async function test_api_create_group_final(test) {
		// create a final group for other suites
		let { data } = await this.request.json( this.api_url + '/app/create_group/v1', {
			"title": "Unit Test Group Final",
			"hostname_match": ".+",
			"notes": "Keep me for future tests"
		});
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.group && data.group.id, "expected group in response" );
		this.group_final_id = data.group.id;
	},

	async function test_api_create_group_snapshot(test) {
		// create a snapshot for the final group and save the id
		let { data } = await this.request.json( this.api_url + '/app/create_group_snapshot/v1', {
			group: this.group_final_id
		});
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.id, "expected snapshot id in response" );
		this.group_snapshot_id = data.id;
	}

];
