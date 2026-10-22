import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { capture, fixture } from './testHelpers.js';
import { loadState } from './state.js';
import { resolveProject, resolveThreadId, threadCommand, type Context } from './threadCommand.js';
import { inDir } from './threads.js';

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
