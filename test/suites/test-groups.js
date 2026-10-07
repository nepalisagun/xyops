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
	
	async function test_runtime_target_privileges(test) {
		// Cover effective group limits and admin bypasses, including roles.
		// These independent fixtures do not change any stored users or plugins.
		var api = new API();
		api.roles = [
			{ id: 'limited_role', enabled: true, groups: ['allowed'] },
			{ id: 'admin_role', enabled: true, privileges: { admin: true } }
		];
		api.plugins = [{ id: 'dynamic_plugin', params: [{ id: '_xy_override_targets', value: '' }] }];
		api.servers = {
			shared_server: { groups: ['allowed', 'other'] },
			outside_server: { groups: ['other'] }
		};
		api.doError = function(code, description, callback) { callback({ code, description }); return false; };
		
		var users = [
			{ privileges: {}, groups: ['allowed'] },
			{ privileges: {}, roles: ['limited_role'] }
		];
		var blocked = [
			{ server: 'shared_server' },
			{ params: { _xy_override_targets: 'allowed' } },
			{ params: { _xy_override_targets: '' } },
			{ fields: [{ id: '_xy_override_targets', value: '' }] },
			{ triggers: [{ params: { _xy_override_targets: 'allowed' } }] },
			{ plugin: 'dynamic_plugin' }
		];
		for (var user of users) {
			for (var data of blocked) {
				var errors = [];
				assert.ok( !api.requireRuntimeTargetPrivileges(user, data, response => errors.push(response)), "group-limited account cannot use runtime targeting" );
				assert.equal( errors.length, 1, "denial sends exactly one response" );
				assert.equal( errors[0].code, 'access', "runtime targeting returns an access error" );
			}
			assert.ok( api.requireRuntimeTargetPrivileges(user, { params: { _xy_override_algo: 'random' } }, function() {}), "other scheduling overrides remain available" );
			assert.ok( api.requireRuntimeTargetPrivileges(user, { server: 'shared_server' }, function() {}, true), "scheduler-assigned shared server remains accessible" );
			assert.ok( !api.requireRuntimeTargetPrivileges(user, { server: 'outside_server' }, function() {}, true), "an existing outside assignment is denied" );
		}
		for (var user of [
			{ privileges: { admin: true }, groups: ['allowed'] },
			{ privileges: {}, roles: ['admin_role'], groups: ['allowed'] },
			{ privileges: {}, categories: ['general'], groups: [] }
		]) {
			for (var data of blocked) assert.ok( api.requireRuntimeTargetPrivileges(user, data, function() {}), "administrator and group-unrestricted accounts retain runtime targeting" );
		}
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
		var suspended_job_id = '';
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
			var original_params = Tools.copyHash(this.xy.activeJobs[job_id].params, true);
			
			// Runtime targeting must be rejected even if it names the allowed group.
			// Check incoming values, hidden field defaults, and scheduled parameters.
			for (var override of [
				{ server: 'outside_server' },
				{ params: { ...event.params, _xy_override_targets: 'main' } },
				{ fields: [{ id: '_xy_override_targets', type: 'hidden', value: '' }] },
				{ triggers: [{ type: 'manual', enabled: true, params: { _xy_override_targets: 'main' } }] }
			]) {
				for (var api of ['create_event', 'update_event', 'run_event', 'update_active_job']) {
					var payload = (api == 'create_event') ? { ...event, ...override } : { id: (api == 'update_active_job') ? job_id : event_id, ...override };
					let denied = await this.request.json( this.api_url + '/app/' + api + '/v1', payload, options );
					assert.equal( denied.data.code, 'access', "runtime targeting is denied by " + api );
				}
			}
			for (var payload of [
				{ id: event_id, 'params/_xy_override_targets': 'outside_server' },
				{ id: event_id, json: JSON.stringify({ params: { _xy_override_targets: 'outside_server' } }) }
			]) {
				let denied = await this.request.json( this.api_url + '/app/run_event/v1', payload, options );
				assert.equal( denied.data.code, 'access', "legacy and JSON run parameters cannot bypass runtime checks" );
			}
			assert.equal( this.xy.findActiveJobs({ event: event_id }).length, 1, "denied runtime requests create no additional jobs" );
			assert.deepEqual( this.xy.activeJobs[job_id].params, original_params, "denied updates preserve live parameters" );
			
			// An administrator can still save the feature. Restricted accounts cannot
			// edit or run that Event just by omitting its inherited override.
			let dynamic = await this.request.json( this.api_url + '/app/update_event/v1', { id: event_id, params: { ...event.params, _xy_override_targets: 'main' } } );
			assert.equal( dynamic.data.code, 0, "administrator retains runtime targeting" );
			for (var api of ['update_event', 'run_event']) {
				let denied = await this.request.json( this.api_url + '/app/' + api + '/v1', { id: event_id }, options );
				assert.equal( denied.data.code, 'access', "inherited runtime targeting blocks " + api );
			}
			await this.request.json( this.api_url + '/app/update_event/v1', { id: event_id, params: event.params } );
			
			// Delayed and suspended job operations must also check saved and injected
			// parameters before they change any job state.
			let dynamic_job = await this.request.json( this.api_url + '/app/update_active_job/v1', { id: job_id, params: { ...event.params, _xy_override_targets: 'main' } } );
			assert.equal( dynamic_job.data.code, 0, "administrator can update live runtime parameters" );
			var until = this.xy.activeJobs[job_id].until;
			for (var api of ['update_active_job', 'job_skip_delay', 'resume_job']) {
				let denied = await this.request.json( this.api_url + '/app/' + api + '/v1', { id: job_id }, options );
				assert.equal( denied.data.code, 'access', "saved runtime targeting blocks " + api );
			}
			assert.equal( this.xy.activeJobs[job_id].until, until, "denied release preserves the job delay" );
			await this.request.json( this.api_url + '/app/update_active_job/v1', { id: job_id, params: event.params } );
			
			// A saved server may have been forced by an administrator. It cannot
			// authorize restricted operations just because job.targets is allowed.
			await this.request.json( this.api_url + '/app/update_active_job/v1', { id: job_id, server: 'outside_server' } );
			for (var api of ['update_active_job', 'job_skip_delay', 'resume_job']) {
				let denied = await this.request.json( this.api_url + '/app/' + api + '/v1', { id: job_id }, options );
				assert.equal( denied.data.code, 'access', "an existing outside server blocks " + api );
			}
			await this.request.json( this.api_url + '/app/update_active_job/v1', { id: job_id, server: '' } );
			
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
			
			// Exercise resume injections on an actual start-suspended job, including
			// its scheduler-assigned server. Rejections must leave it suspended.
			let suspended = await this.request.json( this.api_url + '/app/run_event/v1', {
				id: event_id, actions: [{ enabled: true, condition: 'start', type: 'suspend', users: [], email: '', web_hook: '', text: '' }]
			}, options );
			assert.equal( suspended.data.code, 0, "created start-suspended job" );
			suspended_job_id = suspended.data.id;
			for (var idx = 0; idx < 50 && !this.xy.activeJobs[suspended_job_id]?.suspended; idx++) await new Promise(resolve => setTimeout(resolve, 100));
			assert.ok( this.xy.activeJobs[suspended_job_id]?.suspended, "job reaches start suspension before dispatch" );
			var suspended_params = Tools.copyHash(this.xy.activeJobs[suspended_job_id].params, true);
			for (var key of ['_xy_override_targets', '_xy_override_server']) {
				let denied = await this.request.json( this.api_url + '/app/resume_job/v1', { id: suspended_job_id, params: { [key]: 'outside_server' } }, options );
				assert.equal( denied.data.code, (key == '_xy_override_targets') ? 'access' : 'api', "resume injections cannot retarget the job" );
				assert.ok( this.xy.activeJobs[suspended_job_id].suspended, "denied resume leaves the job suspended" );
				assert.deepEqual( this.xy.activeJobs[suspended_job_id].params, suspended_params, "denied resume preserves job parameters" );
			}
			let denied_admin = await this.request.json( this.api_url + '/app/resume_job/v1', { id: suspended_job_id, params: { _xy_override_server: 'outside_server' } } );
			assert.equal( denied_admin.data.code, 'api', "reserved server parameter is also rejected for administrators" );
			assert.ok( this.xy.activeJobs[suspended_job_id].suspended, "denied administrator resume leaves the job suspended" );
			let resumed = await this.request.json( this.api_url + '/app/resume_job/v1', { id: suspended_job_id, params: { ordinary_param: 'allowed' } }, options );
			assert.equal( resumed.data.code, 0, "ordinary resume with an assigned allowed server still succeeds" );
			await new Promise( (resolve, reject) => this.xy.waitForJob(suspended_job_id, function(err) { err ? reject(err) : resolve(); }) );
			
			// Positive runs exercise hydration and selection on the mock satellite.
			// Both admins and non-admin accounts without group limits keep overrides.
			var runtime_run = { id: event_id, params: { _xy_override_targets: 'main' } };
			let admin_run = await this.request.json( this.api_url + '/app/run_event/v1/wait', runtime_run );
			assert.equal( admin_run.data.code, 0, "administrator can run with runtime targeting" );
			assert.equal( admin_run.data.job.code, 0, "administrator runtime-targeted job completes" );
			await this.request.json( this.api_url + '/app/update_api_key/v1', { id: key_id, groups: [] } );
			let unrestricted_run = await this.request.json( this.api_url + '/app/run_event/v1/wait', runtime_run, options );
			assert.equal( unrestricted_run.data.code, 0, "group-unrestricted account can run with runtime targeting" );
			assert.equal( unrestricted_run.data.job.code, 0, "unrestricted runtime-targeted job completes" );
		}
		finally {
			// Clean up with the administrator session, including the delayed job
			// if an assertion failed before the positive run completed.
			for (var id of [job_id, suspended_job_id]) {
				if (!id || !this.xy.activeJobs[id]) continue;
				await this.request.json( this.api_url + '/app/abort_job/v1', { id } );
				await new Promise( (resolve, reject) => this.xy.waitForJob(id, function(err) { err ? reject(err) : resolve(); }) );
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
			{ id: 'dynamic_event', type: 'normal', category: 'allowed_cat', targets: ['allowed_group'], params: { _xy_override_targets: 'allowed_group' } },
			workflow('mixed_workflow', [eventNode('mixed_event')]),
			workflow('dynamic_workflow', [eventNode('dynamic_event')]),
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
			
			// Runtime targeting checks use the same recursive walk, covering saved
			// events, node overrides, ad-hoc jobs, and referenced sub-workflows.
			for (var nodes of [
				[eventNode('dynamic_event')],
				[eventNode('dynamic_workflow')],
				[{ type: 'event', data: { event: 'allowed_event', params: { _xy_override_targets: 'allowed_group' } } }],
				[{ type: 'job', data: { category: 'allowed_cat', targets: ['allowed_group'], params: { _xy_override_targets: 'allowed_group' } } }],
				[{ type: 'job', data: { category: 'allowed_cat', targets: ['allowed_group'], server: 'outside_server' } }]
			]) {
				error = null;
				denied = this.xy.requireWorkflowPrivileges(user, { nodes }, function(data) { error = data; });
				assert.ok( !denied && error && (error.code == 'access'), "runtime targeting in workflow nodes is rejected" );
			}
			
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
