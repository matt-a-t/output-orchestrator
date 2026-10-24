import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import { branchName, currentRef, isDirty, rebaseInProgress, rebaseOnMain, renameBranch } from './git.js';
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

test('rebases on origin/main, keeping uncommitted changes', async () => {
	const clone = await behindMain('a\n-\n-\nb\n', 'A\n-\n-\nb\n', 'a\n-\n-\nB\n');
	writeFileSync(join(clone, 'new'), 'wip');
	assert.deepEqual(await rebaseOnMain(clone, 'main'), { result: 'rebased' });
	assert.equal(readFileSync(join(clone, 'f'), 'utf8'), 'A\n-\n-\nB\n');
	assert.ok(await isDirty(clone));
	assert.deepEqual(await rebaseOnMain(clone, 'main'), { result: 'up-to-date' });
});

test('leaves a conflicting rebase in progress and says which files', async () => {
	const clone = await behindMain('a\n', 'mine\n', 'theirs\n');
	assert.deepEqual(await rebaseOnMain(clone, 'main'), { result: 'conflicts', files: ['f'] });
	assert.ok(await rebaseInProgress(clone));
});
