import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import { branchName, carryChanges, checkout, currentRef, defaultBranch, ensureWorktree, isDirty, pullBranch, pushState, rebaseInProgress, rebaseOnto, rebaseTarget, renameBranch, restartBranch, restoreChanges } from './git.js';
import type { Thread } from './state.js';

const thread = (t: Partial<Thread>): Thread => ({
	id: '7',
	title: 'Do the thing',
	plan: '',
	project: 'p',
	column: 'active',
	createdAt: '',
	updatedAt: '',
	...t,
});

/** A repo with one commit, a branch `from` and a worktree with it checked out. */
async function repo(from: string): Promise<{ repo: string; worktree: string }> {
	const dir = mkdtempSync(join(tmpdir(), 'oo-git-'));
	const repo = join(dir, 'repo');
	const worktree = join(dir, 'wt');
	const git = (...args: string[]) => execa('git', ['-C', repo, ...args]);
	await execa('git', ['init', '-q', '-b', 'main', repo]);
	await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
	await git('worktree', 'add', '-q', '-b', from, worktree);
	return { repo, worktree };
}

test('branches are named from the ticket, or oo/ without one, never the thread id', () => {
	assert.equal(branchName(thread({ ticket: { key: 'AV-123', url: '' } })), 'av-123-do-the-thing');
	assert.equal(branchName(thread({ ticket: { key: '#45', url: '' } })), '45-do-the-thing');
	assert.equal(branchName(thread({})), 'oo/do-the-thing');
	assert.equal(branchName(thread({ title: '!!!' })), 'oo/thread');
	assert.equal(branchName(thread({ title: '!!!', ticket: { key: 'AV-1', url: '' } })), 'av-1');
});

test('renames an unpushed branch to match a new ticket, in its worktree too', async () => {
	const { repo: r, worktree } = await repo('oo/do-the-thing');
	const result = await renameBranch(r, thread({ branch: 'oo/do-the-thing', ticket: { key: 'AV-123', url: '' } }));
	assert.equal(result.branch, 'av-123-do-the-thing');
	assert.equal(await currentRef(worktree), 'av-123-do-the-thing');
});

test('adds a suffix when the name is taken, and leaves a suffixed branch alone', async () => {
	const { repo: r } = await repo('oo/do-the-thing');
	await execa('git', ['-C', r, 'branch', 'av-123-do-the-thing']);
	const t = thread({ branch: 'oo/do-the-thing', ticket: { key: 'AV-123', url: '' } });
	const result = await renameBranch(r, t);
	assert.equal(result.branch, 'av-123-do-the-thing-2');
	assert.deepEqual(await renameBranch(r, { ...t, branch: result.branch }), {});
});

test('keeps a branch that has been pushed or has a PR', async () => {
	const { repo: r } = await repo('oo/do-the-thing');
	const t = thread({ branch: 'oo/do-the-thing', ticket: { key: 'AV-123', url: '' } });
	assert.match((await renameBranch(r, { ...t, pr: { number: 1, url: '' } })).message!, /already pushed/);
	await execa('git', ['-C', r, 'config', 'branch.oo/do-the-thing.remote', 'origin']);
	const result = await renameBranch(r, t);
	assert.equal(result.branch, undefined);
	assert.match(result.message!, /Kept #7's branch oo\/do-the-thing/);
});

/** A clone of a bare origin, on a branch that sets `f` to `branch`; origin's main has moved on from `file` to `upstream` since. */
async function behindMain(file: string, branch: string, upstream: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), 'oo-git-'));
	const [origin, clone, other] = ['origin', 'clone', 'other'].map(name => join(dir, name)) as [string, string, string];
	const commit = async (cwd: string, text: string, message: string) => {
		writeFileSync(join(cwd, 'f'), text);
		await execa('git', ['-C', cwd, 'add', 'f']);
		await execa('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message]);
	};
	await execa('git', ['init', '-q', '--bare', '-b', 'main', origin]);
	await execa('git', ['clone', '-q', origin, other]);
	await commit(other, file, 'init');
	await execa('git', ['-C', other, 'push', '-q', 'origin', 'HEAD:main']);
	await execa('git', ['clone', '-q', origin, clone]);
	// The rebase makes commits of its own.
	await execa('git', ['-C', clone, 'config', 'user.name', 't']);
	await execa('git', ['-C', clone, 'config', 'user.email', 't@t']);
	await execa('git', ['-C', clone, 'checkout', '-qb', 'oo/x']);
	await commit(clone, branch, 'branch');
	await commit(other, upstream, 'upstream');
	await execa('git', ['-C', other, 'push', '-q', 'origin', 'HEAD:main']);
	return clone;
}

test("asks origin for its default branch, not the clone's stale origin/HEAD", async () => {
	const clone = await behindMain('a\n', 'b\n', 'c\n');
	const origin = join(clone, '..', 'origin');
	await execa('git', ['-C', origin, 'branch', 'trunk', 'main']);
	await execa('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/trunk']);
	assert.equal(await defaultBranch(clone), 'trunk');
	// Offline, the local ref is all there is.
	await execa('git', ['-C', clone, 'remote', 'set-url', 'origin', join(clone, '..', 'gone')]);
	assert.equal(await defaultBranch(clone), 'main');
});

test('rebases on origin/main, keeping uncommitted changes', async () => {
	const clone = await behindMain('a\n-\n-\nb\n', 'A\n-\n-\nb\n', 'a\n-\n-\nB\n');
	writeFileSync(join(clone, 'new'), 'wip');
	assert.deepEqual(await rebaseOnto(clone, await rebaseTarget(clone, thread({ base: 'main' }))), { result: 'rebased' });
	assert.equal(readFileSync(join(clone, 'f'), 'utf8'), 'A\n-\n-\nB\n');
	assert.ok(await isDirty(clone));
	assert.deepEqual(await rebaseOnto(clone, await rebaseTarget(clone, thread({ base: 'main' }))), { result: 'up-to-date' });
});

test('leaves a conflicting rebase in progress and says which files', async () => {
	const clone = await behindMain('a\n', 'mine\n', 'theirs\n');
	assert.deepEqual(await rebaseOnto(clone, await rebaseTarget(clone, thread({ base: 'main' }))), { result: 'conflicts', files: ['f'] });
	assert.ok(await rebaseInProgress(clone));
});

test('carries uncommitted changes from the worktree to the repo with the branch', async () => {
	const { repo: r, worktree } = await repo('oo/do-the-thing');
	const head = (cwd: string) => execa('git', ['-C', cwd, 'rev-parse', 'HEAD']).then(x => x.stdout);
	const before = await head(worktree);
	writeFileSync(join(worktree, 'new.txt'), 'new');
	assert.equal(await carryChanges(worktree), true);
	await execa('git', ['-C', r, 'worktree', 'remove', worktree]);
	await execa('git', ['-C', r, 'checkout', '-q', 'oo/do-the-thing']);
	await restoreChanges(r);
	assert.equal(await head(r), before);
	assert.equal(readFileSync(join(r, 'new.txt'), 'utf8'), 'new');
	assert.equal((await execa('git', ['-C', r, 'status', '--porcelain'])).stdout, '?? new.txt');
	// Again is a no-op: HEAD is a real commit now.
	await restoreChanges(r);
	assert.equal(await head(r), before);
});

test('carries nothing from a clean worktree', async () => {
	const { worktree } = await repo('oo/do-the-thing');
	assert.equal(await carryChanges(worktree), false);
	assert.equal(await isDirty(worktree), false);
});

test('pulls origin/main into a checkout put back on main', async () => {
	const clone = await behindMain('a\n', 'mine\n', 'theirs\n');
	await checkout(clone, 'main');
	await pullBranch(clone, 'main');
	assert.equal(readFileSync(join(clone, 'f'), 'utf8'), 'theirs\n');
});

/** A repo on main with a parent thread's branch one commit ahead, `parent` having `f` = 'parent'. */
async function withParent(): Promise<{ repo: string; dir: string; commit: (cwd: string, text: string) => Promise<void> }> {
	const dir = mkdtempSync(join(tmpdir(), 'oo-git-'));
	const repo = join(dir, 'repo');
	const commit = async (cwd: string, text: string) => {
		writeFileSync(join(cwd, 'f'), text);
		await execa('git', ['-C', cwd, 'add', 'f']);
		await execa('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', text]);
	};
	await execa('git', ['init', '-q', '-b', 'main', repo]);
	await commit(repo, 'main');
	await execa('git', ['-C', repo, 'checkout', '-qb', 'oo/parent']);
	await commit(repo, 'parent');
	await execa('git', ['-C', repo, 'checkout', '-q', 'main']);
	return { repo, dir, commit };
}

test("a stacked thread's new branch starts from its parent's branch, which isn't pushed", async () => {
	const { repo, dir } = await withParent();
	const worktree = join(dir, 'wt');
	const created = await ensureWorktree(repo, thread({ stackedOn: '1', base: 'oo/parent', worktree }));
	assert.deepEqual(created, { branch: 'oo/do-the-thing', base: 'oo/parent' });
	assert.equal(readFileSync(join(worktree, 'f'), 'utf8'), 'parent');
});

test('a branch with no commits of its own moves onto the parent, one with commits stays put', async () => {
	const { repo, dir, commit } = await withParent();
	const worktree = join(dir, 'wt');
	await execa('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'oo/child', worktree, 'main']);
	const child = thread({ branch: 'oo/child', base: 'main', worktree });
	writeFileSync(join(worktree, 'wip'), 'wip');
	assert.equal(await restartBranch(repo, child, 'oo/parent'), false, 'uncommitted changes would be lost');
	await execa('git', ['-C', worktree, 'clean', '-qfd']);
	assert.equal(await restartBranch(repo, child, 'oo/parent'), true);
	assert.equal(readFileSync(join(worktree, 'f'), 'utf8'), 'parent');
	// Its own work on top of main now isn't something to throw away.
	await execa('git', ['-C', worktree, 'reset', '-q', '--hard', 'main']);
	await commit(worktree, 'child');
	assert.equal(await restartBranch(repo, child, 'oo/parent'), false);
	assert.equal(readFileSync(join(worktree, 'f'), 'utf8'), 'child');
});

test("a stacked thread rebases onto its parent's branch as it is here, pushed or not", async () => {
	const { repo, dir, commit } = await withParent();
	const worktree = join(dir, 'wt');
	await execa('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'oo/child', worktree, 'oo/parent']);
	writeFileSync(join(worktree, 'g'), 'child');
	await execa('git', ['-C', worktree, 'add', 'g']);
	await execa('git', ['-C', worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'child']);
	// The parent moves on after the child branched.
	await execa('git', ['-C', repo, 'checkout', '-q', 'oo/parent']);
	await commit(repo, 'parent 2');
	const child = thread({ branch: 'oo/child', base: 'oo/parent', stackedOn: '1', worktree });
	const upstream = await rebaseTarget(worktree, child);
	assert.equal(upstream, 'oo/parent');
	await execa('git', ['-C', worktree, 'config', 'user.name', 't']);
	await execa('git', ['-C', worktree, 'config', 'user.email', 't@t']);
	assert.deepEqual(await rebaseOnto(worktree, upstream), { result: 'rebased' });
	assert.equal(readFileSync(join(worktree, 'f'), 'utf8'), 'parent 2');
	assert.equal(readFileSync(join(worktree, 'g'), 'utf8'), 'child');
});

test('pushState says whether origin has a branch with all its commits', async () => {
	const clone = await behindMain('a\n', 'b\n', 'c\n');
	assert.equal(await pushState(clone, 'oo/x'), 'missing');
	await execa('git', ['-C', clone, 'push', '-q', 'origin', 'oo/x']);
	assert.equal(await pushState(clone, 'oo/x'), 'pushed');
	writeFileSync(join(clone, 'f'), 'more');
	await execa('git', ['-C', clone, 'commit', '-qam', 'more']);
	assert.equal(await pushState(clone, 'oo/x'), 'behind');
});
