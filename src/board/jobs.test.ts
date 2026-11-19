import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeBoard, fixture } from '../testHelpers.js';
import { onThread } from './board.js';
import { jobProblem, jobsWarning } from './jobs.js';

const LEAVING = { kind: 'local', label: 'leaving Local' } as const;

test('a second job on a busy thread is refused, and the job clears once it ends', async () => {
	const { state } = fixture([{}, {}]);
	const board = fakeBoard(state);
	const [one, two] = state.threads as [(typeof state.threads)[0], (typeof state.threads)[0]];
	let finish!: () => void;
	const first = board.startJob(one, LEAVING, () => new Promise<void>(resolve => (finish = resolve)));
	assert.equal(board.jobs().get('1')?.label, 'leaving Local');
	assert.equal(jobProblem(board, one), '⚠ #1 is busy (leaving Local)');
	assert.equal(jobProblem(board, two), undefined);

	let ran = false;
	await board.startJob(one, { kind: 'wake', label: 'waking' }, async () => void (ran = true));
	assert.ok(!ran);
	assert.deepEqual(board.messages, ['⚠ #1 is busy (leaving Local)']);
	assert.equal(jobsWarning(board.jobs()), ' ⚠ #1 is still leaving Local');

	// Another thread's job runs alongside.
	await board.startJob(two, { kind: 'wake', label: 'waking' }, async () => void (ran = true));
	assert.ok(ran);

	finish();
	await first;
	assert.equal(board.jobs().size, 0);
	assert.equal(jobsWarning(board.jobs()), '');
});

test("a job's error goes on the message line, and the job still clears", async () => {
	const { state } = fixture([{}]);
	const board = fakeBoard(state);
	await board.startJob(state.threads[0]!, LEAVING, async () => {
		throw new Error('checkout failed');
	});
	assert.deepEqual(board.messages, ['✗ #1: checkout failed']);
	assert.equal(board.jobs().size, 0);
});

test('thread bindings refuse a thread that has a job', async () => {
	const { state } = fixture([{ column: 'active' }]);
	const board = fakeBoard(state);
	const thread = state.threads[0]!;
	let acted = 0;
	const binding = onThread(() => acted++);
	let finish!: () => void;
	const job = board.startJob(thread, LEAVING, () => new Promise<void>(resolve => (finish = resolve)));
	binding(board, thread);
	assert.equal(acted, 0);
	assert.deepEqual(board.messages, ['⚠ #1 is busy (leaving Local)']);
	finish();
	await job;
	binding(board, thread);
	assert.equal(acted, 1);
});
