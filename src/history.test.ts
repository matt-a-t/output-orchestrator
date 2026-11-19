import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backfill, threadChanges } from './history.js';
import type { State, Thread } from './state.js';

const TS = '2026-11-19T12:00:00.000Z';

const thread = (t: Partial<Thread> = {}): Thread => ({
	id: '1',
	title: 'a thread',
	plan: '',
	project: 'p',
	column: 'planned',
	createdAt: '2026-11-01T00:00:00.000Z',
	updatedAt: '2026-11-01T00:00:00.000Z',
	...t,
});
const state = (...threads: Thread[]): State => ({ version: 1, projects: [], threads });

/** The entries for changing thread 1 from `before` to `after`. */
const change = (before: Partial<Thread>, after: Partial<Thread>) => threadChanges(state(thread(before)), state(thread(after)), TS);

test('threadChanges: a new thread is created, with its column, ticket and what it stacks on', () => {
	assert.deepEqual(threadChanges(state(), state(thread({ plan: 'do it', column: 'active', ticket: { key: 'AV-1', url: 'u' }, stackedOn: '7' })), TS), [
		{ ts: TS, thread: '1', project: 'p', event: 'created', title: 'a thread', column: 'active', plan: true, ticket: 'AV-1', stackedOn: '7' },
	]);
	assert.deepEqual(threadChanges(state(), state(thread()), TS), [{ ts: TS, thread: '1', project: 'p', event: 'created', title: 'a thread', column: 'planned', plan: false }]);
});

test('threadChanges: moves, including to archived', () => {
	assert.deepEqual(change({}, { column: 'active' }), [{ ts: TS, thread: '1', project: 'p', event: 'moved', from: 'planned', to: 'active' }]);
	assert.deepEqual(change({ column: 'done' }, { column: 'archived' }), [{ ts: TS, thread: '1', project: 'p', event: 'moved', from: 'done', to: 'archived' }]);
});

test('threadChanges: entering and leaving Local, with undefined and false the same', () => {
	assert.deepEqual(change({}, { local: true }), [{ ts: TS, thread: '1', project: 'p', event: 'local', on: true }]);
	assert.deepEqual(change({ local: true }, {}), [{ ts: TS, thread: '1', project: 'p', event: 'local', on: false }]);
	assert.deepEqual(change({ local: false }, {}), []);
});

test('threadChanges: a PR once it appears or changes, not when it stays or goes', () => {
	const pr = { number: 5, url: 'https://x/5' };
	assert.deepEqual(change({}, { pr }), [{ ts: TS, thread: '1', project: 'p', event: 'pr', number: 5, url: 'https://x/5' }]);
	assert.deepEqual(change({ pr }, { pr: { number: 6, url: 'https://x/6' } }), [{ ts: TS, thread: '1', project: 'p', event: 'pr', number: 6, url: 'https://x/6' }]);
	assert.deepEqual(change({ pr }, { pr }), []);
	assert.deepEqual(change({ pr }, {}), []);
});

test('threadChanges: a ticket set or changed, not one whose summary was refreshed', () => {
	assert.deepEqual(change({}, { ticket: { key: '#4', url: 'u' } }), [{ ts: TS, thread: '1', project: 'p', event: 'ticket', key: '#4' }]);
	assert.deepEqual(change({ ticket: { key: '#4', url: 'u' } }, { ticket: { key: '#4', url: 'u', summary: 'new' } }), []);
});

test('threadChanges: an edited plan', () => {
	assert.deepEqual(change({}, { plan: 'the plan' }), [{ ts: TS, thread: '1', project: 'p', event: 'plan' }]);
	assert.deepEqual(change({ plan: 'the plan' }, { plan: 'the plan, revised' }), [{ ts: TS, thread: '1', project: 'p', event: 'plan' }]);
});

test('threadChanges: a thread that is gone is removed', () => {
	assert.deepEqual(threadChanges(state(thread({ column: 'ideas' })), state(), TS), [{ ts: TS, thread: '1', project: 'p', event: 'removed', column: 'ideas' }]);
});

test('threadChanges: several changes at once, in a stable order', () => {
	assert.deepEqual(
		change({ column: 'polish' }, { column: 'pr', pr: { number: 1, url: 'u' }, local: true }).map(e => e.event),
		['moved', 'local', 'pr'],
	);
});

test("threadChanges: a save that changes nothing about threads' lives gives no entries", () => {
	const t = thread({ column: 'active', local: true, pr: { number: 1, url: 'u' }, plan: 'p' });
	const after = { ...t, updatedAt: TS, sessionId: 's', todos: [{ subject: 'x', status: 'done' as const }], title: 'renamed' };
	assert.deepEqual(threadChanges(state(t), state(after), TS), []);
	assert.deepEqual(threadChanges(state(t, thread({ id: '2' })), state(thread({ id: '2' }), t), TS), [], 'reordering moves nothing');
});

test('backfill: a created entry per thread at its createdAt, marked backfilled', () => {
	assert.deepEqual(backfill(state(thread({ column: 'done' }), thread({ id: '2', createdAt: 'then' }))), [
		{ ts: '2026-11-01T00:00:00.000Z', thread: '1', project: 'p', event: 'created', title: 'a thread', column: 'done', plan: false, backfilled: true },
		{ ts: 'then', thread: '2', project: 'p', event: 'created', title: 'a thread', column: 'planned', plan: false, backfilled: true },
	]);
});
