import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactedSince, quietThreads, worthCompacting } from './idle.js';
import type { Status } from './status.js';
import { fixture } from './testHelpers.js';
import type { WindowInfo } from './tmux.js';

const now = Date.parse('2026-10-28T12:00:00Z');
const minutesAgo = (m: number) => now - m * 60_000;
const window = (id: string, patch: Partial<WindowInfo> = {}): WindowInfo => ({ name: `oo-${id}`, viewed: false, split: false, pid: 100, ...patch });

/** The ids quietThreads picks from thread 1, stopped 31 minutes ago in an unviewed window, with `change` applied. */
function picked(change: { status?: Status; since?: number; window?: Partial<WindowInfo> | null; minutes?: number; inbox?: boolean; local?: boolean } = {}) {
	const { state } = fixture([
		{ inbox: change.inbox ? [{ from: '2', text: 'hi', ts: new Date(now).toISOString(), delivered: false }] : undefined },
	]);
	const projects = state.projects.map(p => ({ ...p, closeIdleAfter: change.minutes ?? 30 }));
	const windows = change.window === null ? [] : [window('1', change.window)];
	const since = new Map([['1', change.since ?? minutesAgo(31)]]);
	const pending = new Map(change.local ? [['1', true]] : []);
	return quietThreads(state.threads, projects, { '1': change.status ?? 'stopped' }, since, windows, pending, now).map(t => t.id);
}

test('closes a claude stopped past its project\'s timeout, or opened and never prompted', () => {
	assert.deepEqual(picked(), ['1']);
	assert.deepEqual(picked({ status: 'idle' }), ['1']);
	assert.deepEqual(picked({ since: minutesAgo(30) }), ['1']);
});

test('keeps a claude that has not been quiet long enough, or whose project never closes them', () => {
	assert.deepEqual(picked({ since: minutesAgo(29) }), []);
	assert.deepEqual(picked({ minutes: 0 }), []);
});

test('keeps a claude that is working or waiting on you', () => {
	assert.deepEqual(picked({ status: 'working' }), []);
	assert.deepEqual(picked({ status: 'waiting' }), []);
});

test('keeps a window you are looking at, or with a split beside claude', () => {
	assert.deepEqual(picked({ window: { viewed: true } }), []);
	assert.deepEqual(picked({ window: { split: true } }), []);
	assert.deepEqual(picked({ window: null }), []);
});

test('keeps a claude with messages still to be pasted in, or a move to or from Local pending', () => {
	assert.deepEqual(picked({ inbox: true }), []);
	assert.deepEqual(picked({ local: true }), []);
});

test('compacts a large conversation before closing it, only while its cache is warm and the thread is not finished', () => {
	const { state } = fixture([{}]);
	const thread = { ...state.threads[0]!, column: 'followup' as const };
	const use = { tokens: 300_000, at: minutesAgo(31), cacheMs: 60 * 60_000 };
	assert.ok(worthCompacting(thread, use, now));
	assert.ok(!worthCompacting({ ...thread, column: 'done' }, use, now));
	assert.ok(!worthCompacting({ ...thread, column: 'archived' }, use, now));
	// Small, cold, already compacted, or nothing read.
	assert.ok(!worthCompacting(thread, { ...use, tokens: 40_000 }, now));
	assert.ok(!worthCompacting(thread, { ...use, cacheMs: 5 * 60_000 }, now));
	assert.ok(!worthCompacting(thread, { ...use, compacted: true }, now));
	assert.ok(!worthCompacting(thread, undefined, now));
});

test('a compaction counts as done once the transcript shows one since it was asked for', () => {
	const sentAt = minutesAgo(2);
	assert.ok(compactedSince({ tokens: 20_000, at: minutesAgo(1), cacheMs: 0, compacted: true }, sentAt));
	assert.ok(!compactedSince({ tokens: 20_000, at: minutesAgo(60), cacheMs: 0, compacted: true }, sentAt));
	assert.ok(!compactedSince({ tokens: 300_000, at: minutesAgo(1), cacheMs: 60 * 60_000 }, sentAt));
	assert.ok(!compactedSince(undefined, sentAt));
});
