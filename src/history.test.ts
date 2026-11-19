import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { backfill, recordHistory, threadChanges } from './history.js';
import { saveState, type State, type Thread } from './state.js';
import { fixture } from './testHelpers.js';

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
	assert.deepEqual(threadChanges(state(), state(thread({ plan: 'do it', column: 'active', origin: 'cli', ticket: { key: 'AV-1', url: 'u' }, stackedOn: '7' })), TS), [
		{ ts: TS, thread: '1', project: 'p', event: 'created', title: 'a thread', column: 'active', plan: true, origin: 'cli', ticket: 'AV-1', stackedOn: '7' },
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

const lines = (dir: string) =>
	readFileSync(join(dir, 'history.jsonl'), 'utf8')
		.split('\n')
		.filter(Boolean)
		.map(l => JSON.parse(l));

test('saveState: appends each change beside the state file, privately, and nothing for a save that changes nothing', () => {
	const { dir, state } = fixture([{ title: 'one' }]);
	const file = join(dir, 'state.json');
	assert.deepEqual(lines(dir).map(e => [e.event, e.thread, e.backfilled]), [['created', '1', undefined]], "the first save's threads are new, not backfilled");
	assert.equal(statSync(join(dir, 'history.jsonl')).mode & 0o777, 0o600);
	const t = state.threads[0]!;
	saveState({ ...state, threads: [{ ...t, column: 'active' }] }, file);
	saveState({ ...state, threads: [{ ...t, column: 'active', updatedAt: 'later' }] }, file);
	saveState({ ...state, threads: [{ ...t, column: 'active', local: true }] }, file);
	assert.deepEqual(lines(dir).map(e => e.event), ['created', 'moved', 'local']);
});

test('saveState: history starts with a backfill of the threads already there, only once', () => {
	const { dir, state } = fixture([{ title: 'one' }, { title: 'two' }]);
	const file = join(dir, 'state.json');
	rmSync(join(dir, 'history.jsonl'));
	saveState({ ...state, threads: [{ ...state.threads[0]!, column: 'active' }, state.threads[1]!] }, file);
	saveState({ ...state, threads: [{ ...state.threads[0]!, column: 'polish' }, state.threads[1]!] }, file);
	assert.deepEqual(
		lines(dir).map(e => [e.event, e.thread, e.backfilled, e.ts === state.threads[0]!.createdAt]),
		[
			['created', '1', true, true],
			['created', '2', true, true],
			['moved', '1', undefined, false],
			['moved', '1', undefined, false],
		],
	);
});

test("saveState: a state file it can't read still gets saved over, with no history made up from it", () => {
	const { dir, state } = fixture();
	const file = join(dir, 'state.json');
	rmSync(join(dir, 'history.jsonl'), { force: true });
	writeFileSync(file, '{not json');
	saveState({ ...state, threads: [] }, file);
	assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).threads, []);
	assert.throws(() => statSync(join(dir, 'history.jsonl')));
});

test("recordHistory: a history file it can't write doesn't throw", () => {
	const { dir } = fixture();
	assert.doesNotThrow(() => recordHistory(state(), state(thread()), join(dir, 'missing', 'history.jsonl')));
});
