import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import { branchName, currentRef, renameBranch } from './git.js';
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
