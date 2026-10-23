// How `oo thread …` changes the board while it's running. The board keeps state in memory and
// overwrites state.json whenever it saves, so nothing else may write that file meanwhile: the CLI
// appends a request to requests.jsonl instead, the board applies it and appends a response.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { JsonlReader } from './jsonl.js';
import { DATA_DIR, type Column, type Todo } from './state.js';

/** Thread ids and project names are resolved by the CLI, so the board doesn't need its cwd. */
export type Request =
	| { id: string; op: 'add'; project: string; title: string; plan: string }
	| { id: string; op: 'move'; thread: string; column: Column }
	| { id: string; op: 'plan'; thread: string; plan: string }
	| { id: string; op: 'todos'; thread: string; todos: Todo[] };
export type Response = { id: string; ok: boolean; message: string; thread?: string };

export const requestsFile = (dir = DATA_DIR) => join(dir, 'requests.jsonl');
export const responsesFile = (dir = DATA_DIR) => join(dir, 'responses.jsonl');
const pidFile = (dir: string) => join(dir, 'board.pid');

/** Record that this process is the board, until it exits; requests from before it started are dropped. */
export function claimBoard(dir = DATA_DIR): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(requestsFile(dir), '');
	writeFileSync(responsesFile(dir), '');
	writeFileSync(pidFile(dir), String(process.pid));
	process.on('exit', () => releaseBoard(dir));
}

export function releaseBoard(dir = DATA_DIR): void {
	// Only if it's still ours.
	if (boardPid(dir) === process.pid) rmSync(pidFile(dir), { force: true });
}

function boardPid(dir: string): number | undefined {
	try {
		return Number(readFileSync(pidFile(dir), 'utf8').trim()) || undefined;
	} catch {}
}

/** Whether a board is running; a pid file left by one that died doesn't count. */
export function boardRunning(dir = DATA_DIR): boolean {
	const pid = boardPid(dir);
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: it exists but isn't ours to signal.
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

const isRequest = (r: any) => typeof r.id === 'string' && ['add', 'move', 'plan', 'todos'].includes(r.op);
const isResponse = (r: any) => typeof r.id === 'string' && typeof r.ok === 'boolean';

/** The board's side: new requests since the last read. */
export class RequestReader extends JsonlReader<Request> {
	constructor(dir = DATA_DIR) {
		super(requestsFile(dir), isRequest);
	}
}

export function respond(response: Response, dir = DATA_DIR): void {
	appendFileSync(responsesFile(dir), JSON.stringify(response) + '\n');
}

export type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/**
 * The CLI's side: send the request and wait for the board's response. Gives up after `timeoutMs`
 * (creating a worktree can take a while) or as soon as the board stops running.
 */
export async function sendRequest(
	request: DistributiveOmit<Request, 'id'>,
	{ dir = DATA_DIR, timeoutMs = 30_000, pollMs = 100 } = {},
): Promise<Response> {
	const id = randomUUID();
	// Read from the current end, so a large old file isn't scanned every time.
	const reader = new JsonlReader<Response>(responsesFile(dir), isResponse);
	reader.read();
	appendFileSync(requestsFile(dir), JSON.stringify({ ...request, id }) + '\n');
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const response = reader.read().find(r => r.id === id);
		if (response) return response;
		if (!boardRunning(dir)) return { id, ok: false, message: 'The board closed before answering' };
		await sleep(pollMs);
	}
	return { id, ok: false, message: `The board didn't answer within ${timeoutMs / 1000}s; it may still apply the change` };
}
