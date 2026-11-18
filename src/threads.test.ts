import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Thread } from './state.js';
import { boardOnlyMove, byPriority, forwardedMoveProblem, inCheckout, matchesSearch, threadDir, withPriority } from './threads.js';
import { fixture } from './testHelpers.js';

const thread: Thread = {
	id: '12',
	title: 'Sort the Done column',
	plan: 'Newest merges at the bottom',
	project: 'oo',
	column: 'active',
	branch: 'oo/sort-done',
	ticket: { key: 'AV-321', url: 'https://example.atlassian.net/browse/AV-321' },
	pr: { number: 70, url: 'https://github.com/o/r/pull/70' },
	createdAt: '',
	updatedAt: '',
};

test('the search matches the id, title, plan, ticket, branch and PR, ignoring case', () => {
	for (const query of ['#12', 'done COLUMN', 'newest merges', 'av-321', 'oo/sort', '#70']) assert.ok(matchesSearch(thread, query), query);
	assert.ok(!matchesSearch(thread, 'popup'));
	assert.ok(!matchesSearch(thread, '#71'));
});

test('an empty search matches every thread', () => {
	assert.ok(matchesSearch(thread, ''));
	assert.ok(matchesSearch(thread, '  '));
});

test('a column shows high priority first and low last, in J/K order within each', () => {
	const threads = (['low', undefined, 'high', 'normal', 'low', 'high'] as const).map((priority, i) => ({ ...thread, id: String(i), priority }));
	assert.deepEqual(
		byPriority(threads).map(t => t.id),
		['2', '5', '1', '3', '0', '4'],
	);
});

test('normal priority is left out of the thread', () => {
	assert.deepEqual(withPriority('normal'), { priority: undefined });
	assert.deepEqual(withPriority('high'), { priority: 'high' });
});

test("Local in a project with containers keeps the thread in its worktree; only Done and hiding it need it back", () => {
	const { state } = fixture([{ column: 'active', local: true, worktree: '/nowhere/1' }]);
	const thread = state.threads[0]!;
	const plain = state.projects[0]!;
	const withContainer = { ...plain, container: { image: 'x', ports: [3000], allow: [] } };
	assert.equal(inCheckout(plain, thread), true);
	assert.equal(inCheckout(withContainer, thread), false);
	assert.equal(threadDir(state, thread), plain.path);
	// Its worktree doesn't exist here, so there's nowhere for it to be yet.
	assert.equal(threadDir({ ...state, projects: [withContainer] }, thread), undefined);
	assert.match(boardOnlyMove(plain, thread, 'polish') ?? '', /on the project's own checkout/);
	assert.equal(boardOnlyMove(withContainer, thread, 'polish'), undefined);
	for (const column of ['done', 'archived', 'ideas'] as const) assert.match(forwardedMoveProblem(thread, column) ?? '', /bring it back first/);
	assert.equal(forwardedMoveProblem({ ...thread, local: undefined }, 'done'), undefined);
});
