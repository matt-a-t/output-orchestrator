import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeBoard, fixture } from '../testHelpers.js';
import { threadWindowName } from '../tmux.js';
import { coldResume, wake, wakeStalled } from './claude.js';

const HOUR = 60 * 60_000;

/** A thread whose transcript's last turn sent `tokens`, `ago` ms before now, with an hour's cache. */
function setup(tokens: number, ago: number) {
	const { dir, state } = fixture([{ branch: 'oo/t', sessionId: 's1' }]);
	const transcriptPath = join(dir, 's1.jsonl');
	const usage = { input_tokens: 2, cache_read_input_tokens: tokens - 2, cache_creation: { ephemeral_1h_input_tokens: 1 } };
	writeFileSync(transcriptPath, JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - ago).toISOString(), message: { usage } }) + '\n');
	state.threads[0] = { ...state.threads[0]!, transcriptPath };
	return { state, thread: state.threads[0]! };
}

test('resuming is costly only for a closed claude with a large context whose cache has gone cold', () => {
	const cold = setup(300_000, 2 * HOUR);
	assert.equal(coldResume(fakeBoard(cold.state), cold.thread)?.tokens, 300_000);
	// Still warm, small, or already open: nothing to ask.
	const warm = setup(300_000, HOUR / 2);
	assert.equal(coldResume(fakeBoard(warm.state), warm.thread), undefined);
	const small = setup(20_000, 2 * HOUR);
	assert.equal(coldResume(fakeBoard(small.state), small.thread), undefined);
	const open = fakeBoard(cold.state, { liveWindows: () => new Set([threadWindowName(cold.thread.id)]) });
	assert.equal(coldResume(open, cold.thread), undefined);
	// Nothing to resume without a session.
	assert.equal(coldResume(fakeBoard(cold.state), { ...cold.thread, sessionId: undefined }), undefined);
});

test('w asks before resuming a costly one, offering a fresh start', () => {
	const { state, thread } = setup(300_000, 2 * HOUR);
	let no: (() => void) | undefined;
	const board = fakeBoard(state, { ask: (question, _yes, n) => void (board.messages.push(question), (no = n)) });
	void wake(board, thread);
	assert.match(board.messages[0]!, /300k tokens of context and its cache went cold 1h ago.*y resumes · n starts a fresh claude/);
	assert.ok(no);
});

test('w wakes in the background, as the thread\'s job', async () => {
	// A project that's gone stops the wake before it reaches tmux.
	const { state } = fixture([{ project: 'gone' }]);
	const board = fakeBoard(state);
	const waking = wake(board, state.threads[0]!);
	assert.equal(board.jobs().get('1')?.label, 'waking');
	await waking;
	assert.equal(board.jobs().size, 0);
	assert.deepEqual(board.messages, ['✗ Unknown project "gone"']);
});

test('W leaves out threads with a job running', async () => {
	const { state } = fixture([
		{ column: 'active', project: 'gone' },
		{ column: 'active', project: 'gone' },
	]);
	let yes: (() => unknown) | undefined;
	const board = fakeBoard(state, {
		statuses: () => ({ '1': 'interrupted', '2': 'interrupted' }),
		ask: (question, y) => void (board.messages.push(question), (yes = y)),
	});
	let finish!: () => void;
	const job = board.startJob(state.threads[0]!, { kind: 'local', label: 'leaving Local' }, () => new Promise<void>(resolve => (finish = resolve)));
	wakeStalled(board, state.threads);
	assert.deepEqual(board.messages, ['Wake #2?']);
	await yes!();
	assert.equal(board.messages.at(-1), '✗ Unknown project "gone"');
	finish();
	await job;
});
