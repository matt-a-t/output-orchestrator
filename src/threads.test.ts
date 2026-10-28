import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Thread } from './state.js';
import { byPriority, matchesSearch, withPriority } from './threads.js';

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
