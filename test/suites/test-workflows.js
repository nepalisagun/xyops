const assert = require('node:assert/strict');
const fs = require('fs');
const Tools = require('pixl-tools');
const Workflows = require('../../lib/workflow');

// helper: sleep
async function sleep(ms) {
	await new Promise(res => setTimeout(res, ms));
}

// helper: poll internal jobs until specified job id disappears
async function waitForJob(ctx, job_id, opts = {}) {
	const timeout = opts.timeout || 20000;
	const interval = opts.interval || 250;
	const start = performance.now();
	
	while (performance.now() - start < timeout) {
		let { data } = await ctx.request.json(ctx.api_url + '/app/get_active_jobs/v1', {});
		if (data.code !== 0) throw new Error('get_active_jobs failed');
		if (!data.rows.find(r => r.id === job_id)) return;
		await sleep(interval);
	}
	
	throw new Error('Timed out waiting for job to finish');
}

// helper: wait for a specific workflow node job to be actively running
async function waitForActiveWorkflowNode(ctx, workflow_job_id, node_id, opts = {}) {
	const timeout = opts.timeout || 20000;
	const interval = opts.interval || 250;
	const start = performance.now();
	
	while (performance.now() - start < timeout) {
		let { data } = await ctx.request.json(ctx.api_url + '/app/get_active_jobs/v1', {
			state: 'active'
		});
		if (data.code !== 0) throw new Error('get_active_jobs failed');
		let job = data.rows.find(function(row) {
			return row.workflow && (row.workflow.job === workflow_job_id) && (row.workflow.node === node_id);
		});
		if (job) return job;
		await sleep(interval);
	}
	
	throw new Error('Timed out waiting for active workflow node: ' + node_id);
}

// helper: load workflow template from fixtures
function getWorkflow(name) {
	const data = JSON.parse( fs.readFileSync('test/fixtures/workflows/' + name + '.json') );
	return data.items[0].data;
}

exports.tests = [
	
	async function test_workflow_magic_inheritance(test) {
		// Event nodes, ad-hoc jobs and nested workflows all receive the request
		// that started the parent. Inheritance depends on metadata, not source.
		var magic = {
			headers: { 'linear-signature': 'original' }, body: '{ "text": "café" }',
			params: { unknown: { value: 42 } }, query: { caller: 'original' }
		};
		for (var has_magic of [true, false]) {
			var children = [];
			var engine = Object.assign(new Workflows(), {
				events: [
					{ id: 'event', title: 'Event', params: {}, triggers: [], actions: [], limits: [] },
					{ id: 'nested', title: 'Nested Workflow', params: {}, actions: [], limits: [],
						workflow: { nodes: [], connections: [] }, triggers: [{ id: 'manual', type: 'manual', enabled: true }] }
				],
				plugins: [{ id: 'plugin', title: 'Plugin' }],
				config: { get() { return 1000; } },
				jobDetails: { parent: { workflowData: {} } },
				countTotalWFJobs() { return 0; }, logWorkflow() {},
				launchJob(job, callback) { children.push(job); callback(null, 'child_' + children.length); }
			});
			if (has_magic) engine.jobDetails.parent.magic = magic;
			var parent = {
				id: 'parent', event: 'workflow_event', source: 'user', params: {},
				workflow: { state: { event: {}, job: {}, nested: {} }, jobs: {}, connections: [] }
			};
			
			engine.runWFNode_event({ job: parent, node: { id: 'event', data: { event: 'event' } } });
			engine.runWFNode_job({ job: parent, node: { id: 'job', data: { plugin: 'plugin', params: {} } } });
			engine.runWFNode_event({ job: parent, node: { id: 'nested', data: { event: 'nested' } } });
			assert.equal(children.length, 3, 'all three node types launch');
			assert.equal(children[2].workflow.start, 'manual', 'nested workflow retains its own start node');
			
			// launchJob moves a nested workflow's metadata to its own details.
			// Start another job from that context to exercise a second generation.
			engine.jobDetails.nested_job = { workflowData: {} };
			if (children[2].magic) engine.jobDetails.nested_job.magic = children[2].magic;
			var nested = {
				id: 'nested_job', event: 'nested', source: 'workflow', params: {},
				workflow: { state: { job: {} }, jobs: {}, connections: [] }
			};
			engine.runWFNode_job({ job: nested, node: { id: 'job', data: { plugin: 'plugin', params: {} } } });
			
			for (var child of children) {
				if (has_magic) assert.deepEqual(JSON.parse(JSON.stringify(child)).magic, magic, 'child inherits original metadata through JSON transport');
				else assert.ok(!Object.hasOwn(child, 'magic'), 'ordinary workflow does not acquire Magic Link metadata');
				assert.ok(!Object.hasOwn(child.params, 'unknown'), 'metadata does not leak into child params');
			}
		}
	},
	
	async function test_workflow_split_empty_continue(test) {
		// Empty lists may continue only when the Split does not require successful jobs.
		const cases = [
			{ name: 'continue zero', percentage: 0, continues: true },
			{ name: 'default continue zero', continues: true },
			{ name: 'positive threshold', percentage: 50 },
			{ name: 'all success threshold', percentage: 100 },
			{ name: 'previous successes', percentage: 100, previous: true },
			{ name: 'filtered empty list', percentage: 0, filter: true, continues: true },
			{ name: 'filtered positive threshold', percentage: 100, filter: true },
			{ name: 'unmanaged positive threshold', percentage: 100, unmanaged: true }
		];
		
		cases.forEach( function(item) {
			const engine = new Workflows();
			const node = { id: 'split', type: 'controller', data: {
				controller: 'split', split: 'data.items', continue: item.percentage,
				filter: item.filter ? 'item.keep' : ''
			} };
			const worker = { id: 'worker', type: item.unmanaged ? 'controller' : 'job' };
			const state = {};
			const job = { id: 'parent', workflow: {
				nodes: [node, worker, { id: 'final', type: 'job' }],
				state: { split: state }, jobs: {},
				connections: [
					{ id: 'splitWorker', source: 'split', dest: 'worker' },
					{ id: 'workerContinue', source: 'worker', dest: 'final', condition: 'continue' }
				]
			} };
			
			// A previous activation's successful jobs must not satisfy an empty activation.
			if (item.previous) job.workflow.jobs.worker = [{ id: 'previous', code: 0 }];
			engine.jobDetails = { parent: { workflowData: {} } };
			engine.logWorkflow = function() {};
			const launched = [];
			engine.runWorkflowNode = function(opts) { launched.push(opts.node.id); };
			
			engine.runWFController_split({ job, node, overrides: { input: {
				data: { items: item.filter ? [{ keep: false }] : [] }
			} } });
			
			assert.deepEqual(launched, item.continues ? ['final'] : [], item.name + ': correct continuation');
			assert.equal(!!state.error, !item.continues, item.name + ': preserves errors at positive thresholds');
			if (item.continues) {
				assert.equal(state.active, false, item.name + ': Split is inactive');
				assert.equal(state.max, 0, item.name + ': no jobs expected');
				assert.equal(state.count, 0, item.name + ': no jobs completed');
				assert.ok(state.completed, item.name + ': Split is completed');
			}
		} );
	},
	
	async function test_workflow_join_percentage(test) {
		// Exercise Join's output directly, without launching downstream jobs.
		const cases = [
			{ name: 'all succeed', top: [0, 0], bottom: [0], percentage: 100 },
			{ name: 'mixed unequal branches', top: [0, 1], bottom: [0], percentage: 66.66666666666666 },
			{ name: 'none succeed', top: [1, 'warning'], bottom: ['abort'], percentage: 0 },
			{ name: 'retry succeeds', top: [{ code: 1, retried: true }, 0], bottom: [0], percentage: 100 },
			{ name: 'no output data', top: [0], bottom: [1], percentage: 50 },
			{ name: 'below one percent', top: [0], bottom: Array(100).fill(1), percentage: 0.9900990099009901 },
			{ name: 'no job results', top: [], bottom: [], percentage: null }
		];
		
		cases.forEach( function(item) {
			const engine = new Workflows();
			const node = { id: 'join' };
			const jobs = {};
			['top', 'bottom'].forEach( function(source) {
				jobs[source] = item[source].map( function(result, idx) {
					return { id: source + idx, ...(typeof(result) == 'object' ? result : { code: result }) };
				} );
			} );
			const job = { id: 'parent', workflow: {
				jobs, state: { join: {} }, nodes: [{ id: 'final' }],
				connections: [{ source: 'top', dest: 'join' }, { source: 'bottom', dest: 'join' }, { source: 'join', dest: 'final' }]
			} };
			engine.jobDetails = { parent: { wfJobData: {} } };
			engine.logWorkflow = function() {};
			let data;
			engine.runWorkflowNode = function(opts) { data = opts.overrides.input.data; };
			
			// Both input wires must arrive before the final input is generated.
			engine.runWFController_join({ job, node });
			assert.equal(data, undefined, item.name + ': waits for both inputs');
			engine.runWFController_join({ job, node });
			assert.equal(data.percentage, item.percentage, item.name + ': correct success percentage');
			assert.equal(data.items.length, jobs.top.concat(jobs.bottom).filter(stub => !stub.retried).length, item.name + ': includes terminal jobs without output');
		} );
	},
	
	async function test_workflow_reject_duplicate_node_id(test) {
		// The API should reject duplicate workflow node IDs instead of silently repairing them.
		let workflow = getWorkflow('decision');
		workflow.id = 'edupnode01';
		workflow.workflow.nodes.push( Tools.copyHash(workflow.workflow.nodes[0], true) );
		
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', workflow );
		assert.ok( data.code !== 0, "api rejected duplicate node ID" );
	},
	
	async function test_workflow_reject_duplicate_connection_id(test) {
		// The API should reject duplicate workflow connection IDs.
		let workflow = getWorkflow('decision');
		workflow.id = 'edupconn01';
		
		let conn = Tools.copyHash(workflow.workflow.connections[0], true);
		conn.source = workflow.workflow.connections[1].source;
		conn.dest = workflow.workflow.connections[1].dest;
		workflow.workflow.connections.push(conn);
		
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', workflow );
		assert.ok( data.code !== 0, "api rejected duplicate connection ID" );
	},
	
	async function test_workflow_reject_duplicate_connection_pair(test) {
		// The API should reject duplicate wires between the same source and destination nodes.
		let workflow = getWorkflow('decision');
		workflow.id = 'eduppair01';
		
		let conn = Tools.copyHash(workflow.workflow.connections[0], true);
		conn.id = 'cduppair';
		workflow.workflow.connections.push(conn);
		
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', workflow );
		assert.ok( data.code !== 0, "api rejected duplicate connection pair" );
	},
	
	async function test_update_active_workflow(test) {
		// Update a future workflow node while xySat is delaying the current node.
		const first_node_id = 'nk42jgcz';
		const future_node_id = 'nqe6dmpv';
		let workflow = getWorkflow('decision');
		workflow.id = 'eactiveupdate';
		workflow.title = 'Active Workflow Update Test';
		Tools.findObject(workflow.workflow.nodes, { id: first_node_id }).data.params.duration = '4';
		
		let { data:wflow } = await this.request.json( this.api_url + '/app/create_event/v1', workflow );
		assert.ok( wflow.code === 0, "successful api response" );
		assert.ok( wflow.event && wflow.event.id, "expected event in response" );
		
		let { data:run_data } = await this.request.json( this.api_url + '/app/run_event/v1', { id: wflow.event.id } );
		assert.ok( run_data.code === 0, "successful api response" );
		assert.ok( run_data.id, "expected workflow job id" );
		let job_id = run_data.id;
		
		// Wait until the first node is definitely executing, then fetch the live
		// workflow so we can replace its complete nodes array.
		await waitForActiveWorkflowNode( this, job_id, first_node_id );
		let { data:before_data } = await this.request.json( this.api_url + '/app/get_job/v1', { id: job_id } );
		assert.ok( before_data.code === 0 && before_data.job, "expected active workflow job" );
		assert.ok( before_data.job.workflow.state[first_node_id], "workflow has live state before update" );
		
		let nodes = Tools.copyHash(before_data.job.workflow.nodes, true);
		let future_node = Tools.findObject(nodes, { id: future_node_id });
		future_node.data.targets = ['satunit1'];
		
		// Only send nodes.  The API should shallow-merge the workflow object and
		// preserve its connections, runtime state and completed-job history.
		let { data:update_data } = await this.request.json( this.api_url + '/app/update_active_job/v1', {
			id: job_id,
			workflow: { nodes: nodes }
		});
		assert.ok( update_data.code === 0, "active workflow update succeeded" );
		
		let { data:live_data } = await this.request.json( this.api_url + '/app/get_job/v1', { id: job_id } );
		assert.ok( live_data.code === 0 && live_data.job, "expected updated active workflow job" );
		assert.ok( live_data.job.workflow.connections.length === before_data.job.workflow.connections.length, "workflow connections were preserved" );
		assert.ok( live_data.job.workflow.state[first_node_id], "workflow runtime state was preserved" );
		assert.deepEqual( Tools.findObject(live_data.job.workflow.nodes, { id: future_node_id }).data.targets, ['satunit1'], "future node targets were updated" );
		
		// The current node completes after its mock delay, then the workflow should
		// launch the future node using its new target and finish normally.
		await waitForJob( this, job_id );
		let { data:final_data } = await this.request.json( this.api_url + '/app/get_job/v1', { id: job_id } );
		assert.ok( final_data.code === 0 && final_data.job, "expected completed workflow job" );
		assert.ok( final_data.job.code === 0, "updated workflow completed successfully" );
		assert.ok( final_data.job.workflow.jobs[future_node_id], "updated future node was launched" );
		
		let child_job_id = final_data.job.workflow.jobs[future_node_id][0].id;
		let { data:child_data } = await this.request.json( this.api_url + '/app/get_job/v1', { id: child_job_id } );
		assert.ok( child_data.code === 0 && child_data.job, "expected completed future node job" );
		assert.deepEqual( child_data.job.targets, ['satunit1'], "future node used its updated targets" );
	},
	
	async function test_workflow_decision(test) {
		// test multi-job workflow with decision controller
		let { data:wflow } = await this.request.json( this.api_url + '/app/create_event/v1', getWorkflow('decision'));
		assert.ok( wflow.code === 0, "successful api response" );
		assert.ok( wflow.event && wflow.event.id, "expected event in response" );
		let workflow_id = wflow.event.id;
		
		let { data } = await this.request.json( this.api_url + '/app/run_event/v1', { id: workflow_id });
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.id, "expected id in response" );
		let job_id = data.id;
		
		// wait for workflow to complete
		await waitForJob( this, job_id );
		
		// get job data
		let { data:jdata } = await this.request.json( this.api_url + '/app/get_job', { id: job_id });
		assert.ok( jdata.code === 0, "successful api response" );
		assert.ok( jdata.job, "expected job in response" );
		
		let job = jdata.job;
		let state = job.workflow.state;
		let jobs = job.workflow.jobs;
		
		// assertions here
		assert.ok( job.code == 0, "workflow completed successfully" );
		
		// job node IDs:
		// nk42jgcz = "Generate Data"
		// nqe6dmpv = "Hi" (data.num == 42)
		// n8qpiq1i = "There" (data.num != 42)
		
		assert.ok( jobs['nk42jgcz'], "Found jobs for node nk42jgcz");
		assert.ok( jobs['nk42jgcz'].length == 1, "Exactly one job for node nk42jgcz");
		
		assert.ok( jobs['nqe6dmpv'], "Found jobs for node nqe6dmpv");
		assert.ok( jobs['nqe6dmpv'].length == 1, "Exactly one job for node nqe6dmpv");
		
		var job_ids = [];
		for (var node_id in jobs) {
			jobs[node_id].forEach( function(job) { job_ids.push( job.id ); } );
		}
		assert.ok( job_ids.length == 2, "correct number of sub-jobs" );
		
		// fetch all of them at once
		let { data:sjdata } = await this.request.json( this.api_url + '/app/get_jobs', {
			ids: job_ids
		});
		assert.ok( sjdata.code === 0, "successful api response" );
		assert.ok( sjdata.jobs, "expected jobs in response" );
		assert.ok( sjdata.jobs.length == 2, "correct number of jobs in response" );
		assert.ok( Tools.findObjects(sjdata.jobs, { complete: true, code: 0 }).length == 2, "all jobs are complete and successful" );
		
		job_ids.forEach( function(job_id, idx) {
			assert.ok( !!Tools.findObject(sjdata.jobs, { id: job_id }), "found job idx " + idx );
		} );
	},
	
	async function test_workflow_repeat_join(test) {
		// test multi-job workflow with repeat and join controllers
		let { data:wflow } = await this.request.json( this.api_url + '/app/create_event/v1', getWorkflow('repeat-join'));
		assert.ok( wflow.code === 0, "successful api response" );
		assert.ok( wflow.event && wflow.event.id, "expected event in response" );
		let workflow_id = wflow.event.id;
		
		let { data } = await this.request.json( this.api_url + '/app/run_event/v1', { id: workflow_id });
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.id, "expected id in response" );
		let job_id = data.id;
		
		// wait for workflow to complete
		await waitForJob( this, job_id );
		
		// get job data
		let { data:jdata } = await this.request.json( this.api_url + '/app/get_job', { id: job_id });
		assert.ok( jdata.code === 0, "successful api response" );
		assert.ok( jdata.job, "expected job in response" );
		
		let job = jdata.job;
		let state = job.workflow.state;
		let jobs = job.workflow.jobs;
		
		// assertions here
		assert.ok( job.code == 0, "workflow completed successfully" );
		
		// job node IDs:
		// n5r4k75x = "Generate Data" (x5)
		// nbzpuk59 = "Finalize Data" (x1)
		
		assert.ok( jobs['n5r4k75x'], "Found jobs for node n5r4k75x");
		assert.ok( jobs['n5r4k75x'].length == 5, "Exactly five jobs for node n5r4k75x (generate data)");
		
		assert.ok( jobs['nbzpuk59'], "Found jobs for node nbzpuk59");
		assert.ok( jobs['nbzpuk59'].length == 1, "Exactly one job for node nbzpuk59 (finalize data)");
		
		var job_ids = [];
		for (var node_id in jobs) {
			jobs[node_id].forEach( function(job) { job_ids.push( job.id ); } );
		}
		assert.ok( job_ids.length == 6, "correct number of sub-jobs" );
		
		// fetch all of them at once
		let { data:sjdata } = await this.request.json( this.api_url + '/app/get_jobs', {
			ids: job_ids,
			verbose: true // need this for data!
		});
		assert.ok( sjdata.code === 0, "successful api response" );
		assert.ok( sjdata.jobs, "expected jobs in response" );
		assert.ok( sjdata.jobs.length == 6, "correct number of jobs in response" );
		assert.ok( Tools.findObjects(sjdata.jobs, { complete: true, code: 0 }).length == 6, "all jobs are complete and successful" );
		
		job_ids.forEach( function(job_id, idx) {
			assert.ok( !!Tools.findObject(sjdata.jobs, { id: job_id }), "found job idx " + idx );
		} );
		
		// make sure final job has correct merged (joined) data
		var final_job_id = jobs['nbzpuk59'][0].id;
		var final_job = Tools.findObject( sjdata.jobs, { id: final_job_id } );
		assert.ok( !!final_job, "Found final job in sea of completed jobs" );
		
		assert.ok( !!final_job.input, "Found input object in final job" );
		assert.ok( !!final_job.input.data, "Found input data in final job" );
		assert.ok( !!final_job.input.data.items, "Found items in input data in final job" );
		assert.ok( final_job.input.data.items.length == 5, "Correct number of items in input data in final job" );
		assert.equal( final_job.input.data.percentage, 100, "Joined success percentage reaches final job input" );
		
		assert.ok( !!final_job.input.data.combined, "Found combined object in input data in final job" );
		assert.ok( final_job.input.data.combined.num == 42, "Correct data in combined object in input data in final job" );
	},
	
	async function test_workflow_discrete_join(test) {
		// test multi-job workflow with join controller
		let { data:wflow } = await this.request.json( this.api_url + '/app/create_event/v1', getWorkflow('discrete-join'));
		assert.ok( wflow.code === 0, "successful api response" );
		assert.ok( wflow.event && wflow.event.id, "expected event in response" );
		let workflow_id = wflow.event.id;
		
		let { data } = await this.request.json( this.api_url + '/app/run_event/v1', { id: workflow_id });
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.id, "expected id in response" );
		let job_id = data.id;
		
		// wait for workflow to complete
		await waitForJob( this, job_id );
		
		// get job data
		let { data:jdata } = await this.request.json( this.api_url + '/app/get_job', { id: job_id });
		assert.ok( jdata.code === 0, "successful api response" );
		assert.ok( jdata.job, "expected job in response" );
		
		// console.log( "\nWORKFLOW: ", JSON.stringify(jdata.job, null, "\t") );
		
		let job = jdata.job;
		let state = job.workflow.state;
		let jobs = job.workflow.jobs;
		
		// assertions here
		assert.ok( job.code == 0, "workflow completed successfully" );
		
		// job node IDs:
		// nxew2z8t = "Generate Data 1"
		// nriolmha = "Generate Data 2"
		// ndl4jafi = "Finalize Data"
		
		assert.ok( jobs['nxew2z8t'], "Found jobs for node nxew2z8t");
		assert.ok( jobs['nxew2z8t'].length == 1, "Exactly 1 job for node nxew2z8t (generate data 1)");
		
		assert.ok( jobs['nriolmha'], "Found jobs for node nriolmha");
		assert.ok( jobs['nriolmha'].length == 1, "Exactly 1 job for node nriolmha (generate data 1)");
		
		assert.ok( jobs['ndl4jafi'], "Found jobs for node ndl4jafi");
		assert.ok( jobs['ndl4jafi'].length == 1, "Exactly 1 job for node ndl4jafi (finalize data)");
		
		var job_ids = [];
		for (var node_id in jobs) {
			jobs[node_id].forEach( function(job) { job_ids.push( job.id ); } );
		}
		assert.ok( job_ids.length == 3, "correct number of sub-jobs ran" );
		
		// fetch all of them at once
		let { data:sjdata } = await this.request.json( this.api_url + '/app/get_jobs', {
			ids: job_ids,
			verbose: true // need this for data!
		});
		assert.ok( sjdata.code === 0, "successful api response" );
		assert.ok( sjdata.jobs, "expected jobs in response" );
		assert.ok( sjdata.jobs.length == 3, "correct number of jobs in response" );
		assert.ok( Tools.findObjects(sjdata.jobs, { complete: true, code: 0 }).length == 3, "all jobs are complete and successful" );
		
		job_ids.forEach( function(job_id, idx) {
			assert.ok( !!Tools.findObject(sjdata.jobs, { id: job_id }), "found job idx " + idx );
		} );
		
		// make sure final job has correct merged (joined) data
		var final_job_id = jobs['ndl4jafi'][0].id;
		var final_job = Tools.findObject( sjdata.jobs, { id: final_job_id } );
		assert.ok( !!final_job, "Found final job in sea of completed jobs" );
		
		// console.log( "\nFINAL JOB: ", JSON.stringify(final_job, null, "\t") );
		
		assert.ok( !!final_job.input, "Found input object in final job" );
		assert.ok( !!final_job.input.data, "Found input data in final job" );
		assert.ok( !!final_job.input.data.items, "Found items in input data in final job" );
		assert.ok( final_job.input.data.items.length == 2, "Correct number of items in input data in final job" );
		
		assert.ok( !!final_job.input.data.combined, "Found combined object in input data in final job" );
		assert.ok( final_job.input.data.combined.num == 42, "Correct data in combined object in input data in final job" );
	},
	
	async function test_workflow_multiplex(test) {
		// test multi-job workflow with multiplex controller
		let { data:wflow } = await this.request.json( this.api_url + '/app/create_event/v1', getWorkflow('multiplex'));
		assert.ok( wflow.code === 0, "successful api response" );
		assert.ok( wflow.event && wflow.event.id, "expected event in response" );
		let workflow_id = wflow.event.id;
		
		let { data } = await this.request.json( this.api_url + '/app/run_event/v1', { id: workflow_id });
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.id, "expected id in response" );
		let job_id = data.id;
		
		// wait for workflow to complete
		await waitForJob( this, job_id );
		
		// get job data
		let { data:jdata } = await this.request.json( this.api_url + '/app/get_job', { id: job_id });
		assert.ok( jdata.code === 0, "successful api response" );
		assert.ok( jdata.job, "expected job in response" );
		
		let job = jdata.job;
		let state = job.workflow.state;
		let jobs = job.workflow.jobs;
		
		// console.log( "\nWORKFLOW: ", JSON.stringify(jdata.job, null, "\t") );
		
		// assertions here
		assert.ok( job.code == 0, "workflow completed successfully" );
		
		// job node IDs:
		// nizewm42 = job
		// n68r2e20 = action
		
		assert.ok( jobs['nizewm42'], "Found jobs for node nizewm42");
		assert.ok( jobs['nizewm42'].length == 1, "Exactly one job for node nizewm42");
		
		var job_ids = [];
		for (var node_id in jobs) {
			jobs[node_id].forEach( function(job) { job_ids.push( job.id ); } );
		}
		assert.ok( job_ids.length == 1, "correct number of sub-jobs" );
		
		// fetch all of them at once
		let { data:sjdata } = await this.request.json( this.api_url + '/app/get_jobs', {
			ids: job_ids
		});
		assert.ok( sjdata.code === 0, "successful api response" );
		assert.ok( sjdata.jobs, "expected jobs in response" );
		assert.ok( sjdata.jobs.length == 1, "correct number of jobs in response" );
		assert.ok( Tools.findObjects(sjdata.jobs, { complete: true, code: 0 }).length == 1, "all jobs are complete and successful" );
		
		job_ids.forEach( function(job_id, idx) {
			assert.ok( !!Tools.findObject(sjdata.jobs, { id: job_id }), "found job idx " + idx );
		} );
		
		// make sure action ran
		assert.ok( !!state['n68r2e20'], "found state for action node" );
		assert.ok( state['n68r2e20'].code == 0, "action node has code 0" );
		assert.ok( !!state['n68r2e20'].date, "action node has date prop" );
	},
	
	async function test_workflow_split(test) {
		// test multi-job workflow with split controller
		let { data:wflow } = await this.request.json( this.api_url + '/app/create_event/v1', getWorkflow('split'));
		assert.ok( wflow.code === 0, "successful api response" );
		assert.ok( wflow.event && wflow.event.id, "expected event in response" );
		let workflow_id = wflow.event.id;
		
		let { data } = await this.request.json( this.api_url + '/app/run_event/v1', { 
			id: workflow_id,
			input: {
				data: {
					list: ["Item A", "Item B", "Item C"]
				}
			}
		});
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.id, "expected id in response" );
		let job_id = data.id;
		
		// wait for workflow to complete
		await waitForJob( this, job_id );
		
		// get job data
		let { data:jdata } = await this.request.json( this.api_url + '/app/get_job', { id: job_id });
		assert.ok( jdata.code === 0, "successful api response" );
		assert.ok( jdata.job, "expected job in response" );
		
		let job = jdata.job;
		let state = job.workflow.state;
		let jobs = job.workflow.jobs;
		
		// console.log( "\nWORKFLOW: ", JSON.stringify(jdata.job, null, "\t") );
		
		// assertions here
		assert.ok( job.code == 0, "workflow completed successfully" );
		
		// job node IDs:
		// nan42bp0 = job
		
		assert.ok( jobs['nan42bp0'], "Found jobs for node nan42bp0");
		assert.ok( jobs['nan42bp0'].length == 3, "Exactly three jobs for node nan42bp0");
		
		var job_ids = [];
		for (var node_id in jobs) {
			jobs[node_id].forEach( function(job) { job_ids.push( job.id ); } );
		}
		assert.ok( job_ids.length == 3, "correct number of sub-jobs" );
		
		// fetch all of them at once
		let { data:sjdata } = await this.request.json( this.api_url + '/app/get_jobs', {
			ids: job_ids,
			verbose: true
		});
		assert.ok( sjdata.code === 0, "successful api response" );
		assert.ok( sjdata.jobs, "expected jobs in response" );
		assert.ok( sjdata.jobs.length == 3, "correct number of jobs in response" );
		assert.ok( Tools.findObjects(sjdata.jobs, { complete: true, code: 0 }).length == 3, "all jobs are complete and successful" );
		
		// make sure each sub-job was assigned one item from our split
		var split_items = [];
		job_ids.forEach( function(job_id, idx) {
			var sub_job = Tools.findObject(sjdata.jobs, { id: job_id });
			// console.log( "\nJOB " + idx + ": ", JSON.stringify(sub_job, null, "\t") );
			assert.ok( !!sub_job, "found sub-job idx " + idx );
			assert.ok( !!sub_job.input, `found sub-job idx ${idx} input object` );
			assert.ok( !!sub_job.input.data, `found sub-job idx ${idx} input.data object` );
			assert.ok( !!sub_job.input.data.item, `found sub-job idx ${idx} input.data.item` );
			assert.ok( !!sub_job.input.data.item.match(/^Item\s+\w+$/), `sub-job idx ${idx} input.data.item matches expected string pattern` );
			split_items.push( sub_job.input.data.item );
		} );
		
		// make sure all three items are unique
		assert.ok( new Set(split_items).size === split_items.length, "all split item strings are unique" );
	}

];
