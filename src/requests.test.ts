import assert from 'node:assert/strict';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fixture } from './testHelpers.js';
import { RequestReader, boardRunning, claimBoard, releaseBoard, respond, sendRequest } from './requests.js';
import { loadState, type State } from './state.js';
import { applyRequest, type Store } from './threads.js';

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach(stop => stop()));

/** Stand in for the board: claim the dir and apply requests to an in-memory state. */
function board(dir: string, state: State): { state: () => State } {
	claimBoard(dir);
	const store: Store = { get: () => state, update: fn => void (state = fn(state)) };
	const reader = new RequestReader(dir);
	let queue = Promise.resolve();
	const timer = setInterval(() => {
		for (const request of reader.read()) queue = queue.then(async () => respond(await applyRequest(store, request), dir));
	}, 20);
	stops.push(() => {
		clearInterval(timer);
		releaseBoard(dir);
	});
	return { state: () => state };
}

test('boardRunning: no pid file, a dead pid, then a claimed board', () => {
	const { dir } = fixture();
	assert.equal(boardRunning(dir), false);
	writeFileSync(join(dir, 'board.pid'), '999999999');
	assert.equal(boardRunning(dir), false);
	claimBoard(dir);
	assert.equal(boardRunning(dir), true);
	releaseBoard(dir);
	assert.equal(boardRunning(dir), false);
});

test('claiming the board drops requests from before it started', () => {
	const { dir } = fixture();
	writeFileSync(join(dir, 'requests.jsonl'), JSON.stringify({ id: 'old', op: 'add', project: 'p', title: 'stale', plan: '' }) + '\n');
	claimBoard(dir);
	stops.push(() => releaseBoard(dir));
	assert.deepEqual(new RequestReader(dir).read(), []);
});

test('requests round trip through the board, which leaves state.json alone', async () => {
	const { dir, state } = fixture();
	const running = board(dir, state);
	const [a, b] = await Promise.all([
		sendRequest({ op: 'add', project: 'p', title: 'a', plan: '' }, { dir }),
		sendRequest({ op: 'add', project: 'p', title: 'b', plan: 'the plan' }, { dir }),
	]);
	assert.deepEqual([a.ok, b.ok], [true, true]);
	// Requests queued together still get their own ids.
	assert.notEqual(a.thread, b.thread);
	assert.deepEqual(
		running.state().threads.map(t => [t.title, t.plan, t.column]),
		[['a', '', 'planned'], ['b', 'the plan', 'planned']],
	);
	assert.deepEqual(loadState(join(dir, 'state.json')).threads, []);

	const refused = await sendRequest({ op: 'move', thread: a.thread!, column: 'pr' }, { dir });
	assert.equal(refused.ok, false);
	assert.match(refused.message, /from the board/);
});

test('messages reach the board, which marks them delivered once claude has them', async () => {
	const { dir, state } = fixture([{ cwd: '/work/one' }, { cwd: '/work/two' }]);
	const running = board(dir, state);
	for (const text of ['a', 'b']) assert.equal((await sendRequest({ op: 'send', thread: '2', from: '1', text }, { dir })).ok, true);
	assert.equal((await sendRequest({ op: 'delivered', thread: '2', count: 1 }, { dir })).ok, true);
	assert.deepEqual(running.state().threads[1]!.inbox!.map(m => [m.text, m.delivered]), [['a', true], ['b', false]]);
});

test('local requests reach the board, which handles them itself', async () => {
	const { dir, state } = fixture([{ cwd: '/work/one' }]);
	board(dir, state);
	// This stand-in only has applyRequest, which leaves Local to the real board.
	const response = await sendRequest({ op: 'local', thread: '1', local: true }, { dir, timeoutMs: 2000 });
	assert.equal(response.ok, false);
	assert.match(response.message, /needs the board/);
});

test('sendRequest gives up when nothing answers', async () => {
	const { dir } = fixture();
	claimBoard(dir);
	stops.push(() => releaseBoard(dir));
	const response = await sendRequest({ op: 'add', project: 'p', title: 'a', plan: '' }, { dir, timeoutMs: 200 });
	assert.equal(response.ok, false);
	assert.match(response.message, /didn't answer/);
});

test('sendRequest stops waiting once the board closes', async () => {
	const { dir } = fixture();
	claimBoard(dir);
	setTimeout(() => releaseBoard(dir), 100);
	const response = await sendRequest({ op: 'add', project: 'p', title: 'a', plan: '' }, { dir });
	assert.equal(response.ok, false);
	assert.match(response.message, /closed/);
});

test('claiming the board makes the data dir and its files private, even a dir made before', () => {
	const { dir } = fixture();
	const data = join(dir, 'data');
	mkdirSync(data, { mode: 0o755 });
	claimBoard(data);
	stops.push(() => releaseBoard(data));
	assert.equal(statSync(data).mode & 0o777, 0o700);
	for (const file of ['requests.jsonl', 'responses.jsonl', 'board.pid']) assert.equal(statSync(join(data, file)).mode & 0o777, 0o600, file);
});
