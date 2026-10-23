import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { capture, fixture } from './testHelpers.js';
import { claimBoard, releaseBoard, RequestReader, respond, type Request } from './requests.js';
import { loadState } from './state.js';
import { approveTodo, planApproved, resolveProject, resolveThreadId, sessionStarted, threadCommand, type Context } from './threadCommand.js';
import { approvedTodo, inDir, todoWindow } from './threads.js';

const context = (dir: string, cwd: string, env: NodeJS.ProcessEnv = {}): Context => ({
	cwd,
	env,
	dir,
	stdin: () => 'plan from stdin\n',
});

test('inDir: the dir itself and folders inside it, not siblings with the same prefix', () => {
	assert.ok(inDir('/a/b', '/a/b'));
	assert.ok(inDir('/a/b/c/', '/a/b'));
	assert.ok(!inDir('/a/bc', '/a/b'));
	assert.ok(!inDir('/a', '/a/b'));
});

test('OO_THREAD_ID is the default only from that thread\'s directory', () => {
	const { project, state } = fixture([{ cwd: '/work/one' }, { cwd: '/work/two' }]);
	const env = { OO_THREAD_ID: '1' };
	assert.equal(resolveThreadId(state, undefined, env, '/work/one'), '1');
	assert.equal(resolveThreadId(state, undefined, env, '/work/one/src'), '1');
	assert.throws(() => resolveThreadId(state, undefined, env, '/work/two'), /isn't that thread's directory/);
	assert.throws(() => resolveThreadId(state, undefined, env, project), /isn't that thread's directory/);
	assert.throws(() => resolveThreadId(state, undefined, {}, '/work/one'), /Pass a thread id/);
	// An explicit id wins, from anywhere.
	assert.equal(resolveThreadId(state, '#2', env, '/work/one'), '2');
	assert.throws(() => resolveThreadId(state, '9', env, '/work/one'), /No thread #9/);
});

test('the project comes from --project, the thread you\'re in, or the project path', () => {
	const { project, state } = fixture([{ cwd: '/work/one' }]);
	assert.equal(resolveProject(state, '/work/one', undefined), 'p');
	assert.equal(resolveProject(state, join(project, 'sub'), undefined), 'p');
	assert.equal(resolveProject(state, '/elsewhere', 'p'), 'p');
	assert.throws(() => resolveProject(state, '/elsewhere', undefined), /isn't in any project/);
	assert.throws(() => resolveProject(state, '/elsewhere', 'nope'), /Unknown project "nope"/);
});

test('with the board closed, add and move write state.json', async t => {
	const { dir, project } = fixture([{ cwd: '/work/one' }]);
	const output = capture(t);
	const ctx = context(dir, join(project, 'sub'));
	assert.equal(await threadCommand(['add', 'new', 'thing', '--plan-file', '-'], ctx), 0);
	assert.equal(output.out(), '2');
	assert.equal(await threadCommand(['move', '1', 'archived'], ctx), 0);
	const threads = loadState(join(dir, 'state.json')).threads;
	assert.deepEqual(
		threads.map(t => [t.id, t.title, t.plan, t.column]),
		[['2', 'new thing', 'plan from stdin', 'planned'], ['1', 'thread 1', '', 'archived']],
	);
});

test('list hides archived threads unless asked for', async t => {
	const { dir, project } = fixture([{ title: 'live' }, { title: 'gone', column: 'archived' }]);
	const output = capture(t);
	await threadCommand(['list'], context(dir, project));
	assert.match(output.out(), /live/);
	assert.doesNotMatch(output.out(), /gone/);
	await threadCommand(['list', '--column', 'archived', '--json'], context(dir, project));
	assert.match(output.out(), /"title": "gone"/);
});

test('moves that need the board are refused and leave state.json alone', async t => {
	const { dir, project } = fixture([{ cwd: '/work/one' }]);
	const output = capture(t);
	assert.equal(await threadCommand(['move', '1', 'pr'], context(dir, project)), 1);
	assert.match(output.err(), /from the board/);
	assert.equal(loadState(join(dir, 'state.json')).threads[0]!.column, 'planned');
});

test('a thread in Local can\'t change column until it\'s back, and it shows as in Local', async t => {
	const { dir, project } = fixture([{ cwd: '/work/one', column: 'polish', local: true }]);
	const output = capture(t);
	assert.equal(await threadCommand(['move', '1', 'active'], context(dir, project)), 1);
	assert.match(output.err(), /is in Local/);
	assert.equal(loadState(join(dir, 'state.json')).threads[0]!.column, 'polish');
	assert.equal(await threadCommand(['list'], context(dir, project)), 0);
	assert.match(output.out(), /POLISH \(in LOCAL\)/);
});

test('threads from the old UI testing column load as in Local, back in Polish', () => {
	const { dir } = fixture();
	const file = join(dir, 'state.json');
	const old = JSON.parse(readFileSync(file, 'utf8'));
	old.threads.push({ id: '1', title: 't', project: 'p', column: 'uitest', restoreRef: 'main', createdAt: '', updatedAt: '' });
	writeFileSync(file, JSON.stringify(old));
	const [thread] = loadState(file).threads;
	assert.equal(thread!.column, 'polish');
	assert.equal(thread!.local, true);
	assert.equal('restoreRef' in thread!, false);
});

test('a thread can\'t be moved to done or archived from its own directory', async t => {
	const { dir } = fixture([{ cwd: '/work/one', column: 'polish' }]);
	const output = capture(t);
	const ctx = context(dir, '/work/one/src', { OO_THREAD_ID: '1' });
	assert.equal(await threadCommand(['move', 'done'], ctx), 1);
	assert.equal(await threadCommand(['move', '1', 'archived'], ctx), 1);
	assert.match(output.err(), /would close its claude/);
	// Other columns are fine.
	assert.equal(await threadCommand(['move', 'active'], ctx), 0);
});

test('usage: shown for mistakes in the command line, not for failed lookups', async t => {
	const { dir, project } = fixture();
	const output = capture(t);
	assert.equal(await threadCommand(['bogus'], context(dir, project)), 1);
	assert.match(output.err(), /usage:\n {2}oo thread add <title>/);
	assert.equal(await threadCommand(['move', 'sideways'], context(dir, project)), 1);
	assert.match(output.err(), /Unknown column "sideways"/);

	const lookup = fixture();
	const quiet = capture(t);
	assert.equal(await threadCommand(['show', '9'], context(lookup.dir, lookup.project)), 1);
	assert.doesNotMatch(quiet.err(), /usage:/);
});

test('local sends the direction to the board, toggling without one, and needs the board running', async t => {
	const { dir } = fixture([{ cwd: '/work/one' }, { cwd: '/work/two' }]);
	const output = capture(t);
	const ctx = context(dir, '/work/one', { OO_THREAD_ID: '1' });
	assert.equal(await threadCommand(['local', 'in'], ctx), 1);
	assert.match(output.err(), /needs the board running/);

	// Stand in for the board, answering with what it was asked.
	claimBoard(dir);
	const reader = new RequestReader(dir);
	const timer = setInterval(() => {
		for (const r of reader.read()) {
			const { thread, local } = r as Extract<Request, { op: 'local' }>;
			respond({ id: r.id, ok: true, message: `${r.op} #${thread} ${local}` }, dir);
		}
	}, 20);
	t.after(() => {
		clearInterval(timer);
		releaseBoard(dir);
	});
	assert.equal(await threadCommand(['local', 'in'], ctx), 0);
	assert.equal(await threadCommand(['local', 'out'], ctx), 0);
	assert.equal(await threadCommand(['local', '2'], ctx), 0);
	assert.equal(await threadCommand(['local', '#2', 'in'], ctx), 0);
	assert.equal(output.out(), 'local #1 true\nlocal #1 false\nlocal #2 toggle\nlocal #2 true');
	assert.equal(await threadCommand(['local', '2', 'sideways'], ctx), 1);
	assert.match(output.err(), /Unknown direction "sideways"[^]*usage:[^]*oo thread local \[id\] \[in\|out\]/);
});

test('plan replaces the thread\'s plan', async t => {
	const { dir } = fixture([{ cwd: '/work/one', plan: 'old' }]);
	capture(t);
	const ctx = context(dir, '/work/one', { OO_THREAD_ID: '1' });
	assert.equal(await threadCommand(['plan', '--plan-file', '-'], ctx), 0);
	assert.equal(loadState(join(dir, 'state.json')).threads[0]!.plan, 'plan from stdin');
	assert.equal(await threadCommand(['plan', '1'], ctx), 1);
});

test('approving a Planned thread\'s plan saves it and moves the thread to Active', async () => {
	const { dir } = fixture([{ cwd: '/work/one' }, { cwd: '/work/two', column: 'polish', plan: 'kept' }]);
	const input = (cwd: string) => ({ cwd, tool_name: 'ExitPlanMode', tool_input: { plan: '# Do it\n' } });
	const message = (await planApproved(input('/work/one'), context(dir, '/', { OO_THREAD_ID: '1' })))!;
	assert.match(message, /Moved #1 to ACTIVE/);
	assert.match(message, /oo thread todo set/);
	// Not Planned: left alone.
	assert.equal(await planApproved(input('/work/two'), context(dir, '/', { OO_THREAD_ID: '2' })), undefined);
	// No thread to go with it.
	assert.equal(await planApproved(input('/work/two'), context(dir, '/', {})), undefined);
	const threads = loadState(join(dir, 'state.json')).threads;
	assert.deepEqual(
		threads.map(t => [t.id, t.plan, t.column]),
		[['2', 'kept', 'polish'], ['1', '# Do it', 'active']],
	);
});

test('todo set replaces the checkpoints, keeping the status of ones already there', async t => {
	const { dir } = fixture([{ cwd: '/work/one', column: 'active', todos: [{ subject: 'b', status: 'review' }] }]);
	const output = capture(t);
	const ctx = { ...context(dir, '/work/one', { OO_THREAD_ID: '1' }), stdin: () => '- a\n\n2. [x] b\n* [ ] c\n' };
	assert.equal(await threadCommand(['todo', 'set', '--file', '-'], ctx), 0);
	assert.match(output.out(), /Updated #1's todos: 0\/3 done/);
	assert.deepEqual(loadState(join(dir, 'state.json')).threads[0]!.todos, [
		{ subject: 'a', status: 'pending' },
		{ subject: 'b', status: 'review' },
		{ subject: 'c', status: 'pending' },
	]);
});

test('todo <n> <status> sets one checkpoint\'s status, with or without a thread id', async t => {
	const todos = [{ subject: 'a', status: 'pending' as const }, { subject: 'b', status: 'pending' as const }];
	const { dir, project } = fixture([{ cwd: '/work/one', column: 'active', todos }]);
	const output = capture(t);
	assert.equal(await threadCommand(['todo', '1', 'done'], context(dir, '/work/one', { OO_THREAD_ID: '1' })), 0);
	assert.equal(await threadCommand(['todo', '1', '2', 'review'], context(dir, project)), 0);
	assert.deepEqual(loadState(join(dir, 'state.json')).threads[0]!.todos!.map(t => t.status), ['done', 'review']);
	assert.equal(await threadCommand(['todo', '1', '3', 'done'], context(dir, project)), 1);
	assert.match(output.err(), /no todo 3 \(it has 2\)/);
	assert.equal(await threadCommand(['todo', '1', '1', 'finished'], context(dir, project)), 1);
	assert.match(output.err(), /Unknown status "finished"/);
});

test('a starting claude is told where the checkpoints stand, until they\'re all done', () => {
	const todos = [{ subject: 'a', status: 'done' as const }, { subject: 'b', status: 'active' as const }];
	const { dir } = fixture([{ cwd: '/work/one', column: 'active', todos }, { cwd: '/work/two', column: 'active' }]);
	const briefing = sessionStarted({ cwd: '/work/one' }, context(dir, '/', { OO_THREAD_ID: '1' }))!;
	assert.match(briefing, /\(1\/2 done\)/);
	assert.match(briefing, /2\. \[active\] b/);
	assert.equal(sessionStarted({ cwd: '/work/two' }, context(dir, '/', { OO_THREAD_ID: '2' })), undefined);
	assert.equal(sessionStarted({ cwd: '/work/two' }, context(dir, '/', { OO_THREAD_ID: '1' })), undefined);
});

test('a claude starting in Local is told so, with or without checkpoints', () => {
	const { dir, project } = fixture([{ column: 'active', local: true, branch: 'oo/1-x' }, { cwd: '/work/two', column: 'active', local: true }]);
	const briefing = sessionStarted({ cwd: project }, context(dir, '/', { OO_THREAD_ID: '1' }))!;
	assert.match(briefing, new RegExp(`You're in Local: working in the project's own checkout at ${project} on oo/1-x`));
	assert.match(briefing, /oo thread local out/);
	// Imported threads stay in their own directory, so there's nothing to say.
	assert.equal(sessionStarted({ cwd: '/work/two' }, context(dir, '/', { OO_THREAD_ID: '2' })), undefined);
});

test('approving a step ticks off the checkpoint in review, else the active one', () => {
	const todo = (status: 'pending' | 'active' | 'review' | 'done') => ({ subject: status, status });
	assert.equal(approvedTodo([todo('done'), todo('active'), todo('review')]), 2);
	assert.equal(approvedTodo([todo('done'), todo('active'), todo('pending')]), 1);
	assert.equal(approvedTodo([todo('done'), todo('pending')]), -1);
});

test('todoWindow keeps the current step in view', () => {
	const todos = (done: number, total: number) =>
		Array.from({ length: total }, (_, i) => ({ subject: String(i), status: i < done ? ('done' as const) : ('pending' as const) }));
	assert.deepEqual(todoWindow(todos(0, 3), 5), { start: 0, end: 3 });
	assert.deepEqual(todoWindow(todos(0, 8), 5), { start: 0, end: 5 });
	// One finished step before the current one.
	assert.deepEqual(todoWindow(todos(3, 10), 5), { start: 2, end: 7 });
	// Near the end, or all done, the last few.
	assert.deepEqual(todoWindow(todos(8, 10), 5), { start: 5, end: 10 });
	assert.deepEqual(todoWindow(todos(10, 10), 5), { start: 5, end: 10 });
});

test('committing outside the board ticks off the checkpoint in review', async () => {
	const todos = [{ subject: 'a', status: 'review' as const }, { subject: 'b', status: 'pending' as const }];
	const { dir } = fixture([{ cwd: '/work/one', column: 'active', todos }, { cwd: '/work/two', column: 'active' }]);
	assert.equal(await approveTodo('1', context(dir, '/')), '✓ a');
	assert.deepEqual(loadState(join(dir, 'state.json')).threads[0]!.todos!.map(t => t.status), ['done', 'pending']);
	// Nothing in review or active: nothing to tick off.
	assert.equal(await approveTodo('1', context(dir, '/')), undefined);
	assert.equal(await approveTodo('2', context(dir, '/')), undefined);
});
