import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { currentRef, isDirty } from '../git.js';
import type { Thread } from '../state.js';
import { fakeBoard, fakeTmux, fixture, git, gitFixture } from '../testHelpers.js';
import { enterLocal, leaveLocal, leaveLocalForDone, localProblem } from './local.js';

const BRANCH = 'oo/the-thing';

/**
 * Project "p" with thread #1 active on BRANCH in its own worktree: one commit there, then an uncommitted
 * change to README and an untracked new.txt. tmux is faked with no windows, so no claude is open.
 */
async function threadInWorktree(t: TestContext, extra: Partial<Thread>[] = []) {
	const tmux = fakeTmux(t);
	const { dir, project, origin, state } = await gitFixture([{ column: 'active', branch: BRANCH, base: 'main' }, ...extra]);
	const wt = state.threads[0]!.worktree!;
	await git(project, 'worktree', 'add', '-q', '-b', BRANCH, wt);
	writeFileSync(join(wt, 'work.txt'), 'committed\n');
	await git(wt, 'add', 'work.txt');
	await git(wt, 'commit', '-q', '-m', 'the work');
	writeFileSync(join(wt, 'README'), 'changed\n');
	writeFileSync(join(wt, 'new.txt'), 'untracked\n');
	const board = fakeBoard(state);
	const thread = () => board.state().threads.find(t => t.id === '1')!;
	return { dir, project, origin, wt, board, thread, tmux };
}

const subject = async (cwd: string) => (await git(cwd, 'log', '-1', '--format=%s')).stdout;

/** The README change and new.txt are in `cwd`, uncommitted, on top of the thread's commit. */
async function assertCarried(cwd: string) {
	assert.equal(readFileSync(join(cwd, 'README'), 'utf8'), 'changed\n');
	assert.equal(readFileSync(join(cwd, 'new.txt'), 'utf8'), 'untracked\n');
	assert.equal(await subject(cwd), 'the work');
	assert.ok(await isDirty(cwd));
}

test("localProblem says why a thread can't go into Local", async () => {
	const { state } = fixture([
		{ branch: BRANCH },
		{ local: true },
		{ column: 'done', branch: BRANCH },
		{ column: 'active' },
		{ project: 'gone' },
	]);
	const board = fakeBoard(state);
	const [one, other, done, noBranch, gone] = state.threads as [Thread, Thread, Thread, Thread, Thread];
	assert.equal(await localProblem(board, gone, true), 'Unknown project "gone"');
	assert.equal(await localProblem(board, one, true), 'p already has #2 thread 2 in Local');
	board.updateThread(other.id, { local: undefined });
	assert.equal(await localProblem(board, done, true), '#3 is done — move it back to Polish first');
	assert.equal(await localProblem(board, noBranch, true), '#4 has no branch yet — open it first');
	board.setState(s => ({ ...s, projects: s.projects.map(p => ({ ...p, worktrees: false })) }));
	assert.match((await localProblem(board, one, true))!, /^#1 is in p, which has worktrees off — there's no checkout/);
	// Leaving is only stopped by the project being gone.
	assert.equal(await localProblem(board, { ...noBranch, local: true }, false), undefined);
});

test("localProblem stops a thread going into Local over the checkout's own tracked changes, not untracked ones", async () => {
	const { project, state } = await gitFixture([{ column: 'active', branch: BRANCH }]);
	const board = fakeBoard(state);
	writeFileSync(join(project, 'scratch.txt'), 'mine\n');
	assert.equal(await localProblem(board, state.threads[0]!, true), undefined);
	writeFileSync(join(project, 'README'), 'edited here\n');
	assert.equal(await localProblem(board, state.threads[0]!, true), `${project} has uncommitted changes — commit or stash them first`);
});

test('an imported thread goes into and out of Local without touching git', async () => {
	const { state } = fixture([{ column: 'active', cwd: '/nowhere' }]);
	const board = fakeBoard(state);
	assert.deepEqual(await enterLocal(board, state.threads[0]!), { ok: true, message: '#1 is in Local' });
	assert.equal(board.state().threads[0]!.local, true);
	assert.deepEqual(await leaveLocal(board, board.state().threads[0]!), { ok: true, message: '#1 is out of Local' });
	assert.equal(board.state().threads[0]!.local, undefined);
});

test('entering Local checks the branch out in the project, bringing the uncommitted changes and leaving no carry commit', async t => {
	const { project, wt, board, thread, tmux } = await threadInWorktree(t);
	const { ok, message } = await enterLocal(board, thread());
	assert.ok(ok, message);
	// It looked for claude's window to close, found none, so didn't start one in the checkout either.
	assert.deepEqual(tmux.calls().map(c => c[0]), ['list-windows', 'list-windows']);
	assert.equal(message, `p checkout is on ${BRANCH} with its uncommitted changes; claude works there until it leaves Local`);
	assert.equal(await currentRef(project), BRANCH);
	assert.equal(existsSync(wt), false);
	await assertCarried(project);
	assert.equal(thread().local, true);
});

test('entering Local waits for claude to finish working', async t => {
	const { project, wt, board, thread } = await threadInWorktree(t);
	board.statuses = () => ({ '1': 'working' });
	assert.deepEqual(await enterLocal(board, thread()), { ok: false, message: 'claude is still working on #1' });
	assert.equal(await currentRef(project), 'main');
	assert.ok(existsSync(wt));
});

test("a checkout that fails puts the thread back in its worktree with its changes", async t => {
	const { project, wt, board, thread } = await threadInWorktree(t);
	// The branch has clash.txt, and an untracked one in the checkout stops git checking it out.
	writeFileSync(join(wt, 'clash.txt'), 'branch\n');
	await git(wt, 'add', 'clash.txt');
	await git(wt, 'commit', '-q', '-m', 'the work');
	writeFileSync(join(project, 'clash.txt'), 'checkout\n');
	await assert.rejects(enterLocal(board, thread()), /clash\.txt/);
	assert.equal(await currentRef(project), 'main');
	assert.equal(await currentRef(wt), BRANCH);
	await assertCarried(wt);
	assert.equal(thread().local, undefined);
});

test('leaving Local puts the checkout back on main and the changes back in a new worktree', async t => {
	const { project, wt, board, thread } = await threadInWorktree(t);
	assert.ok((await enterLocal(board, thread())).ok);
	const { ok, message } = await leaveLocal(board, thread());
	assert.ok(ok, message);
	assert.equal(message, 'p checkout is back on main; #1 is back in its worktree with its uncommitted changes');
	assert.equal(await currentRef(project), 'main');
	assert.equal(await isDirty(project), false);
	assert.equal(await currentRef(wt), BRANCH);
	await assertCarried(wt);
	assert.equal(thread().local, undefined);
});

test("leaving Local for Done puts the checkout back on main with origin's merge pulled", async t => {
	const { dir, project, origin, wt, board, thread } = await threadInWorktree(t);
	await git(wt, 'checkout', '-q', '--', 'README');
	await git(wt, 'clean', '-qf');
	assert.ok((await enterLocal(board, thread())).ok);
	// The PR merging, as another clone pushing to main.
	const other = join(dir, 'other');
	await git(dir, 'clone', '-q', origin, other);
	await git(other, 'commit', '-q', '--allow-empty', '-m', 'merged');
	await git(other, 'push', '-q', 'origin', 'main');
	assert.equal(await leaveLocalForDone(board, thread()), 'p checkout is back on main, pulled');
	assert.equal(await currentRef(project), 'main');
	assert.equal(await subject(project), 'merged');
	assert.equal(thread().local, undefined);
});

test("leaving Local for Done still ends on main when origin can't be pulled", async t => {
	const { dir, project, wt, board, thread } = await threadInWorktree(t);
	await git(wt, 'checkout', '-q', '--', 'README');
	await git(wt, 'clean', '-qf');
	assert.ok((await enterLocal(board, thread())).ok);
	await git(project, 'remote', 'set-url', 'origin', join(dir, 'missing.git'));
	assert.match(await leaveLocalForDone(board, thread()), /^p checkout is back on main, couldn't pull origin\/main: /);
	assert.equal(await currentRef(project), 'main');
	assert.equal(thread().local, undefined);
});
