import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRunStatuses, runPrefix, runSessionName } from './commands.js';
import type { Project, Thread } from './state.js';

const project = { name: 'my.web' } as Project;
const thread = { id: '12' } as Thread;

test("each thread's run of a command gets its own session, named in what tmux takes", () => {
	assert.equal(runSessionName(project, thread, { name: 'dev server', command: 'npm run dev' }), 'oo-run_my-web_12_dev-server');
	assert.equal(runSessionName(project, undefined, { name: 'test:unit', command: 'npm test' }), 'oo-run_my-web_main_test-unit');
	assert.equal(runSessionName(project, thread, { name: '!!', command: 'x' }), 'oo-run_my-web_12_x');
});

test("a thread's prefix doesn't take in another project's runs", () => {
	// Project "my-web" thread 1 against project "my-web-1": _ keeps them apart.
	const other = runSessionName({ name: 'my-web-1' } as Project, { id: '2' } as Thread, { name: 'dev', command: '' });
	assert.ok(!other.startsWith(runPrefix(project, { id: '1' } as Thread)));
	assert.ok(runSessionName(project, thread, { name: 'dev', command: '' }).startsWith(runPrefix(project, thread)));
});

test('run sessions are running until they record how their command exited', () => {
	const statuses = parseRunStatuses(['oo\t', 'oo-run_web_12_dev\t', 'oo-run_web_12_test\t0', 'oo-run_web_main_lint\t2', 'mine\t1'].join('\n'));
	assert.deepEqual([...statuses], [
		['oo-run_web_12_dev', { running: true }],
		['oo-run_web_12_test', { running: false, exit: 0 }],
		['oo-run_web_main_lint', { running: false, exit: 2 }],
	]);
});
