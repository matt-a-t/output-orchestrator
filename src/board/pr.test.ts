import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { execa } from 'execa';
import { currentRef } from '../git.js';
import type { PrStatus } from '../github.js';
import { USER_SENDER, type Thread } from '../state.js';
import { followUpPrompt } from '../threadCommand.js';
import { fakeBoard, fakeGh, fakeTmux, fixture, git, gitFixture, type FakeAnswer } from '../testHelpers.js';
import { enterLocal } from './local.js';
import { checkPr, openPr, quizMessage, type PrSteps } from './pr.js';

const BRANCH = 'oo/the-thing';
const URL = 'https://github.com/o/r/pull/5';
const PR = { number: 5, url: URL };
const status = (state: string, mergeable = 'MERGEABLE'): FakeAnswer => ({ stdout: JSON.stringify({ state, mergeable, mergeStateStatus: 'CLEAN' }) });
const NO_PR: FakeAnswer = { exitCode: 1 };

/** Project "p" with thread #1 (plus `extra`) on BRANCH in its own worktree, with one commit and nothing uncommitted. */
async function threadInWorktree(t: TestContext, thread: Partial<Thread> = {}, extra: Partial<Thread>[] = []) {
	const tmux = fakeTmux(t);
	const { dir, project, origin, state } = await gitFixture([{ column: 'polish', branch: BRANCH, base: 'main', ...thread }, ...extra]);
	const wt = state.threads[0]!.worktree!;
	await git(project, 'worktree', 'add', '-q', '-b', BRANCH, wt);
	writeFileSync(join(wt, 'work.txt'), 'committed\n');
	await git(wt, 'add', 'work.txt');
	await git(wt, 'commit', '-q', '-m', 'the work');
	const board = fakeBoard(state);
	const thread1 = () => board.state().threads.find(t => t.id === '1')!;
	return { dir, project, origin, wt, board, thread: thread1, tmux };
}

/** PrSteps that write `draft` (null: cancel) and record what they were told. */
function steps(draft: { title: string; body: string } | null = { title: 'T', body: 'B' }) {
	const said: string[] = [];
	const described: string[] = [];
	let closed = false;
	const prSteps: PrSteps = {
		status: text => void said.push(text),
		describe: async (_cwd, _thread, base) => (described.push(base), draft),
		close: async () => void (closed = true),
	};
	return { prSteps, said, described, closed: () => closed };
}

const onOrigin = async (origin: string, branch: string) =>
	(await execa('git', ['-C', origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { reject: false })).exitCode === 0;

/** Wait for what `void checkPr` (after opening a PR) records to show up. */
async function eventually(check: () => boolean) {
	for (let i = 0; i < 100 && !check(); i++) await sleep(50);
	assert.ok(check());
}

test("openPr says why it can't open a PR before touching git", async () => {
	const { state } = fixture([{ project: 'gone' }, { cwd: '/no/such/dir' }, { column: 'polish' }]);
	const board = fakeBoard(state);
	const [gone, missing, noBranch] = state.threads as [Thread, Thread, Thread];
	assert.deepEqual(await openPr(board, gone, steps().prSteps), { ok: false, message: 'Unknown project "gone"' });
	assert.deepEqual(await openPr(board, missing, steps().prSteps), { ok: false, message: '/no/such/dir no longer exists' });
	assert.deepEqual(await openPr(board, noBranch, steps().prSteps), { ok: false, message: '#3 has no branch yet — open it first' });
	assert.equal(board.state().threads[2]!.column, 'polish');
});

test("openPr won't open a PR for an imported thread whose directory is on the default branch", async () => {
	const { project, state } = await gitFixture([{ column: 'polish' }]);
	const board = fakeBoard(state);
	const imported = { ...state.threads[0]!, cwd: project };
	assert.deepEqual(await openPr(board, imported, steps().prSteps), {
		ok: false,
		message: `${project} is on main — switch #1's work onto a branch there first`,
	});
});

test('openPr wants uncommitted changes dealt with first', async t => {
	const { wt, board, thread } = await threadInWorktree(t);
	const gh = fakeGh(t, {});
	writeFileSync(join(wt, 'new.txt'), 'not yet\n');
	assert.deepEqual(await openPr(board, thread(), steps().prSteps), {
		ok: false,
		message: '#1 has uncommitted changes — approve them (d, then a) or discard them first',
	});
	assert.deepEqual(gh.calls(), []);
});

test("openPr won't open a stacked thread's PR until its parent's branch is pushed in full", async t => {
	const PARENT = 'oo/parent';
	const { project, origin, board, thread } = await threadInWorktree(t, { stackedOn: '2', base: PARENT }, [{ column: 'pr' }]);
	fakeGh(t, { [`pr view ${BRANCH}`]: NO_PR });
	await git(project, 'branch', PARENT);
	assert.deepEqual(await openPr(board, thread(), steps().prSteps), {
		ok: false,
		message: `#1 builds on #2's ${PARENT}, which isn't pushed — open #2's PR first`,
	});
	await git(project, 'push', '-q', 'origin', PARENT);
	await git(project, 'checkout', '-q', PARENT);
	await git(project, 'commit', '-q', '--allow-empty', '-m', 'unpushed');
	await git(project, 'checkout', '-q', 'main');
	const { ok, message } = await openPr(board, thread(), steps().prSteps);
	assert.equal(ok, false);
	assert.match(message, /^#2's oo\/parent has commits that aren't pushed/);
	assert.equal(await onOrigin(origin, BRANCH), false);
	assert.equal(thread().column, 'polish');
});

test('cancelling the PR description pushes nothing', async t => {
	const { origin, board, thread } = await threadInWorktree(t);
	fakeGh(t, { [`pr view ${BRANCH}`]: NO_PR });
	const cancel = steps(null);
	assert.deepEqual(await openPr(board, thread(), cancel.prSteps), { ok: true, message: 'Cancelled' });
	assert.ok(cancel.closed());
	assert.equal(await onOrigin(origin, BRANCH), false);
	assert.equal(thread().column, 'polish');
});

test('openPr pushes the branch, opens its PR into the default branch and moves the thread to PR', async t => {
	const { origin, board, thread } = await threadInWorktree(t, { drafts: { commit: 'a commit', pr: { title: 'saved', body: 'saved' } } });
	const gh = fakeGh(t, { [`pr view ${BRANCH}`]: NO_PR, 'pr create': { stdout: `Creating pull request\n${URL}\n` }, 'pr view 5': status('OPEN') });
	const open = steps();
	assert.deepEqual(await openPr(board, thread(), open.prSteps), { ok: true, message: `Opened PR #5: ${URL}` });
	assert.deepEqual(open.described, ['origin/main']);
	assert.ok(open.closed());
	assert.ok(await onOrigin(origin, BRANCH));
	assert.deepEqual(
		gh.calls().find(c => c[1] === 'create'),
		['pr', 'create', '--head', BRANCH, '--title', 'T', '--body-file', '-'],
	);
	assert.deepEqual(gh.inputs(), ['B']);
	assert.equal(thread().column, 'pr');
	assert.deepEqual(thread().pr, PR);
	// The PR draft is used up; the commit draft isn't the PR's to clear.
	assert.deepEqual(thread().drafts, { commit: 'a commit' });
	// It checks the new PR's merge status straight away.
	await eventually(() => board.merge()['1']?.state === 'OPEN');
});

test("a stacked thread's PR goes into its parent's branch", async t => {
	const PARENT = 'oo/parent';
	const { project, board, thread } = await threadInWorktree(t, { stackedOn: '2', base: PARENT }, [{ column: 'pr' }]);
	await git(project, 'branch', PARENT);
	await git(project, 'push', '-q', 'origin', PARENT);
	const gh = fakeGh(t, { [`pr view ${BRANCH}`]: NO_PR, 'pr create': { stdout: URL }, 'pr view 5': status('OPEN') });
	const open = steps();
	assert.ok((await openPr(board, thread(), open.prSteps)).ok);
	// Described against the parent's branch as this checkout has it.
	assert.deepEqual(open.described, [PARENT]);
	assert.deepEqual(
		gh.calls().find(c => c[1] === 'create'),
		['pr', 'create', '--head', BRANCH, '--base', PARENT, '--title', 'T', '--body-file', '-'],
	);
	await eventually(() => board.merge()['1'] !== undefined);
});

test('openPr pushes to a PR that already exists instead of opening another', async t => {
	const { origin, board, thread } = await threadInWorktree(t);
	const gh = fakeGh(t, { [`pr view ${BRANCH}`]: { stdout: JSON.stringify(PR) }, 'pr view 5': status('OPEN') });
	const open = steps();
	assert.deepEqual(await openPr(board, thread(), open.prSteps), { ok: true, message: `Pushed PR #5: ${URL}` });
	assert.deepEqual(open.described, []);
	assert.ok(await onOrigin(origin, BRANCH));
	assert.equal(gh.calls().some(c => c[1] === 'create'), false);
	assert.equal(thread().column, 'pr');
	await eventually(() => board.merge()['1'] !== undefined);
});

test('checkPr records an open PR\'s merge status, keeping it while GitHub works it out', async t => {
	const { state } = fixture([{ column: 'pr', pr: PR }]);
	const board = fakeBoard(state);
	const gh = fakeGh(t, { 'pr view 5': status('OPEN', 'CONFLICTING') });
	await checkPr(board, state.threads[0]!);
	const conflicting: PrStatus = { state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'CLEAN' };
	assert.deepEqual(board.merge(), { '1': conflicting });
	gh.answer({ 'pr view 5': status('OPEN', 'UNKNOWN') });
	await checkPr(board, state.threads[0]!);
	assert.deepEqual(board.merge(), { '1': conflicting });
	assert.equal(board.state().threads[0]!.column, 'pr');
});

test('checkPr leaves the thread alone when gh fails, or it has no PR', async t => {
	const { state } = fixture([{ column: 'pr', pr: PR }, { column: 'pr' }]);
	const board = fakeBoard(state);
	const gh = fakeGh(t, { 'pr view 5': { exitCode: 1 } });
	await checkPr(board, state.threads[0]!);
	await checkPr(board, state.threads[1]!);
	assert.equal(gh.calls().length, 1);
	assert.deepEqual(board.merge(), {});
	assert.deepEqual(board.messages, []);
	assert.deepEqual(board.state().threads.map(t => t.column), ['pr', 'pr']);
});

test('a merged PR moves the thread to Done and removes its worktree', async t => {
	const { wt, board, thread } = await threadInWorktree(t, { column: 'pr', pr: PR });
	fakeGh(t, { 'pr view 5': status('MERGED') });
	board.setMerge({ '1': { state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' } });
	await checkPr(board, thread());
	assert.equal(thread().column, 'done');
	assert.deepEqual(board.merge(), {});
	assert.equal(board.messages[0], "#1's PR #5 merged → Done");
	assert.equal(existsSync(wt), false);
});

test('a merged PR with after-merge checkpoints moves the thread to Follow-up and tells its claude', async t => {
	const todos = [
		{ subject: 'build it', status: 'done' as const },
		{ subject: 'deploy it', status: 'pending' as const, afterMerge: true },
	];
	const { wt, board, thread } = await threadInWorktree(t, { column: 'pr', pr: PR, todos });
	// Its claude is open, so it hears the message once its turn ends rather than being woken.
	fakeTmux(t, ['oo-1']);
	fakeGh(t, { 'pr view 5': status('MERGED') });
	await checkPr(board, thread());
	assert.equal(thread().column, 'followup');
	assert.equal(board.messages[0], "#1's PR #5 merged → Follow-up (1 after-merge checkpoint)");
	assert.ok(existsSync(wt));
	assert.deepEqual(
		thread().inbox?.map(m => [m.from, m.text, m.delivered]),
		[[USER_SENDER, followUpPrompt(todos, PR), false]],
	);
});

test('a merged PR takes the thread out of Local on its way to Done', async t => {
	const { project, board, thread } = await threadInWorktree(t);
	assert.ok((await enterLocal(board, thread())).ok);
	board.setColumn('1', 'pr', { pr: PR });
	fakeGh(t, { 'pr view 5': status('MERGED') });
	await checkPr(board, thread());
	assert.equal(thread().column, 'done');
	assert.equal(thread().local, undefined);
	assert.equal(await currentRef(project), 'main');
	assert.equal(board.messages[0], "#1's PR #5 merged → Done; p checkout is back on main, pulled");
});

test("a merged PR stays in PR while the Local checkout has changes that Done would leave on main", async t => {
	const { project, board, thread } = await threadInWorktree(t);
	assert.ok((await enterLocal(board, thread())).ok);
	board.setColumn('1', 'pr', { pr: PR });
	writeFileSync(join(project, 'stray.txt'), 'uncommitted\n');
	fakeGh(t, { 'pr view 5': status('MERGED') });
	await checkPr(board, thread());
	assert.equal(thread().column, 'pr');
	assert.equal(thread().local, true);
	assert.equal(await currentRef(project), BRANCH);
	assert.equal(
		board.messages[0],
		"⚠ #1's PR #5 merged, but it stays in PR until it can leave Local: #1 has uncommitted changes — approve them (d, then a) or discard them first",
	);
});

test('quizMessage says how the pop quiz went, and that a failed one stopped the PR', () => {
	const opened = 'Opened PR #5: url';
	assert.equal(quizMessage(opened, null), opened);
	assert.equal(quizMessage(opened, { result: 'passed', score: '3/3' }), `${opened} · pop quiz 3/3`);
	assert.equal(quizMessage(opened, { result: 'overridden', score: '1/3' }), `${opened} · pop quiz 1/3, opened anyway`);
	assert.equal(quizMessage('Cancelled', { result: 'failed', score: '1/3' }), '⚠ Pop quiz failed (1/3) — PR not opened');
	assert.equal(quizMessage(opened, { result: 'skipped' }), `${opened} · ⚠ no pop quiz: claude couldn't write one`);
});
