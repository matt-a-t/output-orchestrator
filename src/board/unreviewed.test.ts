import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../testHelpers.js';
import { eachLimited, settled, threadsToCheck } from './unreviewed.js';

test('threadsToCheck covers working columns, Local, outside threads and open windows, nothing finished', () => {
	const { state, project, dir } = fixture([
		{ column: 'active' },
		{ column: 'polish' },
		{ column: 'pr' },
		{ column: 'followup' },
		{ column: 'done' },
		{ column: 'planned' },
		{ column: 'planned' }, // window open
		{ column: 'done', local: true },
		{ column: 'done', cwd: '/elsewhere' },
		{ column: 'archived', cwd: '/archived' },
		{ column: 'active' }, // worktree not made yet
	]);
	for (const t of state.threads.slice(0, 7)) mkdirSync((t.worktree = join(dir, 'wt', t.id)), { recursive: true });
	state.threads[10]!.worktree = join(dir, 'wt', 'missing');
	const dirs = threadsToCheck(state, new Set(['oo-7']));
	assert.deepEqual([...dirs.keys()], ['1', '2', '3', '4', '7', '8', '9']);
	assert.equal(dirs.get('8'), project);
	assert.equal(dirs.get('9'), '/elsewhere');
});

test('threadsToCheck skips projects with worktrees off', () => {
	const { state, dir } = fixture([{ column: 'active' }]);
	mkdirSync((state.threads[0]!.worktree = join(dir, 'wt')), { recursive: true });
	state.projects[0]!.worktrees = false;
	assert.equal(threadsToCheck(state, new Set()).size, 0);
});

test('settled lists threads whose status just changed to something other than working', () => {
	assert.deepEqual(settled({ a: 'working', b: 'working', c: 'stopped' }, { a: 'stopped', b: 'working', c: 'stopped', d: 'idle' }), ['a', 'd']);
	assert.deepEqual(settled({ a: 'stopped' }, { a: 'working' }), []);
});

test('eachLimited runs every item, never more than the limit at once', async () => {
	let running = 0;
	let most = 0;
	const done: number[] = [];
	await eachLimited([1, 2, 3, 4, 5, 6, 7], 3, async n => {
		most = Math.max(most, ++running);
		await new Promise(resolve => setTimeout(resolve, 5));
		running--;
		done.push(n);
	});
	assert.equal(most, 3);
	assert.deepEqual(done.sort(), [1, 2, 3, 4, 5, 6, 7]);
});
