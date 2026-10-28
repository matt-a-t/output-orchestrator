// How `oo thread …` changes the board while it's running. The board keeps state in memory and
// overwrites state.json whenever it saves, so nothing else may write that file meanwhile: the CLI
// appends a request to requests.jsonl instead, the board applies it and appends a response.
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { JsonlReader } from './jsonl.js';
import { DATA_DIR, ensureDataDir, PRIVATE_FILE, type Column, type Priority, type Thread, type TodoStatus } from './state.js';

/** Thread ids and project names are resolved by the CLI, so the board doesn't need its cwd. */
export type Request =
	// `from`: the thread whose branch it builds on, and is blocked by (see stackedOn).
	| { id: string; op: 'add'; project: string; title: string; plan: string; ticket?: Thread['ticket']; from?: string }
	| { id: string; op: 'move'; thread: string; column: Column }
	// Only the board can do this one (it checks out, moves claude and runs hooks); 'toggle' is what t does.
	| { id: string; op: 'local'; thread: string; local: boolean | 'toggle' }
	// Board-only too (it pushes, opens the PR and runs hooks); without a body, claude drafts the PR, and the title too unless given.
	| { id: string; op: 'pr'; thread: string; title?: string; body?: string }
	| { id: string; op: 'plan'; thread: string; plan: string }
	| { id: string; op: 'priority'; thread: string; priority: Priority }
	// Save (or with null, clear) the messages the commit and PR forms open with; one left out stays as it is.
	| { id: string; op: 'draft'; thread: string; commit?: string | null; pr?: { title: string; body: string } | null }
	| { id: string; op: 'todos'; thread: string; subjects: string[] }
	// `item` counts from 1, as `oo thread show` lists them.
	| { id: string; op: 'todo'; thread: string; item: number; status: TodoStatus }
	// `from` is the sending thread's id, or UNVERIFIED_SENDER (see Message); `wake` (board-only) resumes a closed claude to hear it.
	| { id: string; op: 'send'; thread: string; from: string; text: string; wake?: boolean }
	// The thread's first `count` undelivered messages have been put to its claude.
	| { id: string; op: 'delivered'; thread: string; count: number }
	| { id: string; op: 'block'; thread: string; blocker: string }
	// Without a blocker, it clears them all.
	| { id: string; op: 'unblock'; thread: string; blocker?: string };
export type Response = { id: string; ok: boolean; message: string; thread?: string };

export const requestsFile = (dir = DATA_DIR) => join(dir, 'requests.jsonl');
export const responsesFile = (dir = DATA_DIR) => join(dir, 'responses.jsonl');
const pidFile = (dir: string) => join(dir, 'board.pid');

/** Record that this process is the board, until it exits; requests from before it started are dropped. */
export function claimBoard(dir = DATA_DIR): void {
	ensureDataDir(dir);
	writeFileSync(requestsFile(dir), '', { mode: PRIVATE_FILE });
	writeFileSync(responsesFile(dir), '', { mode: PRIVATE_FILE });
	writeFileSync(pidFile(dir), String(process.pid), { mode: PRIVATE_FILE });
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

const REQUEST_OPS = ['add', 'move', 'local', 'pr', 'plan', 'priority', 'draft', 'todos', 'todo', 'send', 'delivered', 'block', 'unblock'] as const;
// Doesn't compile if an op is missing above: the board would refuse its requests as unknown.
const allOps: [Exclude<Request['op'], (typeof REQUEST_OPS)[number]>] extends [never] ? true : never = true;
void allOps;

const isKnownOp = (op: string): op is Request['op'] => (REQUEST_OPS as readonly string[]).includes(op);
const isAnyRequest = (r: any) => typeof r.id === 'string' && typeof r.op === 'string';
const isResponse = (r: any) => typeof r.id === 'string' && typeof r.ok === 'boolean';

/**
 * The board's side: new requests since the last read. One it doesn't know (from a CLI built after the
 * board started) is answered here, so the CLI fails with that instead of waiting out its timeout.
 */
export class RequestReader {
	private readonly reader: JsonlReader<{ id: string; op: string }>;

	constructor(private readonly dir = DATA_DIR) {
		this.reader = new JsonlReader(requestsFile(dir), isAnyRequest);
	}

	read(): Request[] {
		return this.reader.read().filter((request): request is Request => {
			if (isKnownOp(request.op)) return true;
			const message = `The running board doesn't know \`oo thread ${request.op}\`; restart it (q, then oo) to pick up the new version`;
			respond({ id: request.id, ok: false, message }, this.dir);
			return false;
		});
	}
}

export function respond(response: Response, dir = DATA_DIR): void {
	appendFileSync(responsesFile(dir), JSON.stringify(response) + '\n', { mode: PRIVATE_FILE });
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
	appendFileSync(requestsFile(dir), JSON.stringify({ ...request, id }) + '\n', { mode: PRIVATE_FILE });
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const response = reader.read().find(r => r.id === id);
		if (response) return response;
		if (!boardRunning(dir)) return { id, ok: false, message: 'The board closed before answering' };
		await sleep(pollMs);
	}
	// The board applies requests one at a time, so this one may be queued behind a slow pr, local or hook.
	return { id, ok: false, message: `The board didn't answer within ${timeoutMs / 1000}s; it may be busy with another request and still apply this one` };
}
