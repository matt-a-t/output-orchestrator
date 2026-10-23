// `oo thread …`: drive the board from the shell (and from claude, see the oo skill).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardRunning, sendRequest, type DistributiveOmit, type Request, type Response } from './requests.js';
import { COLUMN_LABELS, COLUMNS, DATA_DIR, LOCAL_LABEL, loadState, saveState, TODO_MARKS, TODO_STATUSES, type Column, type State, type Thread, type Todo, type TodoStatus } from './state.js';
import { applyRequest, approvedTodo, inDir, threadDir, todoProgress, type Store } from './threads.js';

export const THREAD_USAGE = `  oo thread add <title> [--project <name>] [--plan-file <path>|-]
                              new Planned thread; prints its id (--plan-file - reads the plan from stdin)
  oo thread list [--json] [--project <name>] [--column <column>]
  oo thread show [id] [--json]
  oo thread move [id] <column>
                              columns: ${[...COLUMNS, 'archived'].join(', ')}
                              Moving to pr, and into or out of Local, is done on the board;
                              a thread in Local can't move until it's back.
  oo thread plan [id] --plan-file <path>|-
                              replace the thread's plan
  oo thread todo [id] set --file <path>|-
                              replace the thread's checkpoints, one per line (items already on it keep their status)
  oo thread todo [id] <n> <${TODO_STATUSES.join('|')}>
                              set checkpoint n's status (numbered as \`oo thread show\` lists them)
  Inside a thread's claude, id defaults to that thread. The project defaults to the one you're in.`;

/** What the command runs against; tests swap these out. */
export type Context = { cwd: string; env: NodeJS.ProcessEnv; dir: string; stdin: () => string };

export const defaultContext = (): Context => ({
	cwd: process.cwd(),
	env: process.env,
	dir: DATA_DIR,
	stdin: () => readFileSync(0, 'utf8'),
});

const ALL_COLUMNS: readonly Column[] = [...COLUMNS, 'archived'];

/** A failure to report as its message alone. */
class CommandError extends Error {}
/** A mistake in the command line itself, reported with the usage. */
class UsageError extends CommandError {}

/** Split args into positionals and `--name value` / `--name` flags. */
function parseArgs(args: string[], valued: string[], boolean: string[]) {
	const positional: string[] = [];
	const flags: Record<string, string | true> = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (!arg.startsWith('--')) {
			positional.push(arg);
			continue;
		}
		const name = arg.slice(2);
		if (boolean.includes(name)) flags[name] = true;
		else if (valued.includes(name) && args[i + 1] !== undefined) flags[name] = args[++i]!;
		else throw new UsageError(`Unknown option ${arg}`);
	}
	return { positional, flag: (name: string) => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined), has: (name: string) => flags[name] === true };
}

function parseColumn(name: string): Column {
	const column = ALL_COLUMNS.find(c => c === name.toLowerCase());
	if (!column) throw new UsageError(`Unknown column "${name}"; one of ${ALL_COLUMNS.join(', ')}`);
	return column;
}

/** The thread whose directory `cwd` is in, picking the innermost if they nest. */
function threadAt(state: State, cwd: string): Thread | undefined {
	return state.threads
		.map(t => ({ t, dir: threadDir(state, t) }))
		.filter(({ dir }) => dir && inDir(cwd, dir))
		.sort((a, b) => b.dir!.length - a.dir!.length)[0]?.t;
}

/** `--project`, else the project of the thread `cwd` is in (worktrees aren't inside the project), else the project containing `cwd`. */
export function resolveProject(state: State, cwd: string, name?: string): string {
	if (name) {
		if (!state.projects.some(p => p.name === name)) throw new CommandError(`Unknown project "${name}"`);
		return name;
	}
	const project =
		threadAt(state, cwd)?.project ??
		state.projects.filter(p => inDir(cwd, p.path)).sort((a, b) => b.path.length - a.path.length)[0]?.name;
	if (!project) throw new CommandError(`${cwd} isn't in any project; pass --project <name>`);
	return project;
}

/**
 * The given id, else OO_THREAD_ID — but only from that thread's own directory, since a claude can
 * inherit another thread's OO_THREAD_ID (e.g. via a shared daemon).
 */
export function resolveThreadId(state: State, arg: string | undefined, env: NodeJS.ProcessEnv, cwd: string): string {
	if (arg) {
		const id = arg.replace(/^#/, '');
		if (!state.threads.some(t => t.id === id)) throw new CommandError(`No thread #${id}`);
		return id;
	}
	const id = env.OO_THREAD_ID;
	if (!id) throw new CommandError('Pass a thread id');
	const thread = state.threads.find(t => t.id === id);
	const dir = thread && threadDir(state, thread);
	if (!dir || !inDir(cwd, dir)) throw new CommandError(`OO_THREAD_ID is ${id}, but ${cwd} isn't that thread's directory; pass a thread id`);
	return id;
}

/** Through the board if it's running (it owns state.json then), else straight to state.json. */
async function change(request: DistributiveOmit<Request, 'id'>, ctx: Context): Promise<Response> {
	if (boardRunning(ctx.dir)) return sendRequest(request, { dir: ctx.dir });
	const file = join(ctx.dir, 'state.json');
	let state = loadState(file);
	const store: Store = { get: () => state, update: fn => void (state = fn(state)) };
	const response = await applyRequest(store, { ...request, id: '' });
	if (response.ok) saveState(state, file);
	return response;
}

/** The thread's column, noting when it's in Local. */
function where(t: Thread): string {
	return `${COLUMN_LABELS[t.column]}${t.local ? ` (in ${LOCAL_LABEL})` : ''}`;
}

function summary(t: Thread): string {
	return `#${t.id}\t${where(t)}\t${t.project}\t${t.title}`;
}

function details(state: State, t: Thread): string {
	const lines = [`#${t.id} ${t.title}`, `column:  ${where(t)}`, `project: ${t.project}`];
	if (t.branch) lines.push(`branch:  ${t.branch}${t.base ? ` (from ${t.base})` : ''}`);
	const dir = threadDir(state, t);
	if (dir) lines.push(`dir:     ${dir}`);
	if (t.pr) lines.push(`PR:      #${t.pr.number} ${t.pr.url}`);
	if (t.sessionId) lines.push(`session: ${t.sessionId}`);
	if (t.todos?.length) lines.push(`todos:   ${todoProgress(t.todos)} done`, ...t.todos.map(todo => `  ${TODO_MARKS[todo.status]} ${todo.subject}`));
	if (t.plan) lines.push('', t.plan);
	return lines.join('\n');
}

async function run(args: string[], ctx: Context): Promise<number> {
	const [sub, ...rest] = args;
	const state = loadState(join(ctx.dir, 'state.json'));
	if (sub === 'add') {
		const { positional, flag } = parseArgs(rest, ['project', 'plan-file'], []);
		const title = positional.join(' ').trim();
		if (!title) throw new UsageError('Give the thread a title');
		const planFile = flag('plan-file');
		const plan = planFile === undefined ? '' : (planFile === '-' ? ctx.stdin() : readFileSync(planFile, 'utf8')).trim();
		const project = resolveProject(state, ctx.cwd, flag('project'));
		const response = await change({ op: 'add', project, title, plan }, ctx);
		if (!response.ok) return fail(response.message);
		console.log(response.thread);
		return 0;
	}
	if (sub === 'list') {
		const { positional, flag, has } = parseArgs(rest, ['project', 'column'], ['json']);
		if (positional.length) throw new UsageError(`Unexpected ${positional[0]}`);
		const project = flag('project');
		if (project) resolveProject(state, ctx.cwd, project);
		const column = flag('column') && parseColumn(flag('column')!);
		// Archived threads only when asked for.
		const threads = state.threads.filter(
			t => (column ? t.column === column : t.column !== 'archived') && (!project || t.project === project),
		);
		console.log(has('json') ? JSON.stringify(threads, null, 2) : threads.map(summary).join('\n'));
		return 0;
	}
	if (sub === 'show') {
		const { positional, has } = parseArgs(rest, [], ['json']);
		if (positional.length > 1) throw new UsageError(`Unexpected ${positional[1]}`);
		const id = resolveThreadId(state, positional[0], ctx.env, ctx.cwd);
		const thread = state.threads.find(t => t.id === id)!;
		console.log(has('json') ? JSON.stringify({ ...thread, dir: threadDir(state, thread) }, null, 2) : details(state, thread));
		return 0;
	}
	if (sub === 'move') {
		const { positional } = parseArgs(rest, [], []);
		if (positional.length < 1 || positional.length > 2) throw new UsageError('oo thread move [id] <column>');
		const column = parseColumn(positional.at(-1)!);
		const thread = resolveThreadId(state, positional.length === 2 ? positional[0] : undefined, ctx.env, ctx.cwd);
		// That removes the directory and closes the thread's claude, which is likely the one asking.
		if ((column === 'done' || column === 'archived') && threadAt(state, ctx.cwd)?.id === thread) {
			return fail(`Moving #${thread} to ${COLUMN_LABELS[column]} from its own directory would close its claude — do it from the board`);
		}
		const response = await change({ op: 'move', thread, column }, ctx);
		if (!response.ok) return fail(response.message);
		console.log(response.message);
		return 0;
	}
	if (sub === 'plan') {
		const { positional, flag } = parseArgs(rest, ['plan-file'], []);
		if (positional.length > 1) throw new UsageError(`Unexpected ${positional[1]}`);
		const planFile = flag('plan-file');
		if (planFile === undefined) throw new UsageError('oo thread plan [id] --plan-file <path>|-');
		const plan = (planFile === '-' ? ctx.stdin() : readFileSync(planFile, 'utf8')).trim();
		const thread = resolveThreadId(state, positional[0], ctx.env, ctx.cwd);
		const response = await change({ op: 'plan', thread, plan }, ctx);
		if (!response.ok) return fail(response.message);
		console.log(response.message);
		return 0;
	}
	if (sub === 'todo') {
		const { positional, flag } = parseArgs(rest, ['file'], []);
		if (positional.at(-1) === 'set') {
			const file = flag('file');
			if (positional.length > 2 || file === undefined) throw new UsageError('oo thread todo [id] set --file <path>|-');
			const subjects = todoLines(file === '-' ? ctx.stdin() : readFileSync(file, 'utf8'));
			const thread = resolveThreadId(state, positional.length === 2 ? positional[0] : undefined, ctx.env, ctx.cwd);
			return report(await change({ op: 'todos', thread, subjects }, ctx));
		}
		if (positional.length < 2 || positional.length > 3) throw new UsageError('oo thread todo [id] <n> <status>');
		const [item, status] = positional.slice(-2) as [string, string];
		if (!TODO_STATUSES.includes(status as TodoStatus)) throw new UsageError(`Unknown status "${status}"; one of ${TODO_STATUSES.join(', ')}`);
		if (!/^[1-9]\d*$/.test(item)) throw new UsageError(`"${item}" isn't a checkpoint number`);
		const thread = resolveThreadId(state, positional.length === 3 ? positional[0] : undefined, ctx.env, ctx.cwd);
		return report(await change({ op: 'todo', thread, item: Number(item), status: status as TodoStatus }, ctx));
	}
	throw new UsageError('');
}

/** One checkpoint per line, without list markers or checkboxes. */
function todoLines(text: string): string[] {
	return text
		.split('\n')
		.map(line => line.replace(/^\s*(?:[-*]|\d+[.)])?\s*(?:\[[ xX]\]\s*)?/, '').trim())
		.filter(Boolean);
}

function report(response: Response): number {
	if (!response.ok) return fail(response.message);
	console.log(response.message);
	return 0;
}

/** The plan claude had approved, from ExitPlanMode's PostToolUse input: inline, or in the file it was written to. */
function approvedPlan(input: any): string | undefined {
	const inline = input?.tool_input?.plan ?? input?.tool_response?.plan;
	if (typeof inline === 'string' && inline.trim()) return inline.trim();
	const file = input?.tool_input?.planFilePath ?? input?.tool_response?.filePath;
	if (typeof file !== 'string') return;
	try {
		return readFileSync(file, 'utf8').trim() || undefined;
	} catch {}
}

/**
 * Claude hook for ExitPlanMode (see planHook.ts): approving the plan of a thread in Planned saves it
 * as the thread's plan and moves the thread to Active. Returns what happened, for claude; undefined if nothing did.
 */
export async function planApproved(input: any, ctx: Context): Promise<string | undefined> {
	const state = loadState(join(ctx.dir, 'state.json'));
	let thread: string;
	try {
		thread = resolveThreadId(state, undefined, ctx.env, typeof input?.cwd === 'string' ? input.cwd : ctx.cwd);
	} catch {
		return;
	}
	if (state.threads.find(t => t.id === thread)?.column !== 'planned') return;
	const plan = approvedPlan(input);
	const responses = [
		...(plan ? [await change({ op: 'plan', thread, plan }, ctx)] : []),
		await change({ op: 'move', thread, column: 'active' }, ctx),
	];
	const messages = responses.map(r => `${r.ok ? '' : '✗ '}${r.message}`);
	if (responses.at(-1)!.ok) messages.push(TODOS_PROMPT);
	return messages.join('\n');
}

// The checkpoints carry across claude runs, so the work can stop for review at each one.
const TODOS_PROMPT = `Before starting, save the plan's checkpoints with \`oo thread todo set --file - <<'EOF'\` (one per line, each a step the user can review and commit on its own).
Mark one active (\`oo thread todo <n> active\`) when you start it and review when it's ready, then stop and let the user review it; approving the step on the board commits it and marks it done.`;

/** What a thread's claude is told as it starts: where the thread's checkpoints stand. */
export function todoBriefing(todos: Todo[]): string | undefined {
	if (!todos.length || todos.every(t => t.status === 'done')) return;
	const list = todos.map((t, i) => `  ${i + 1}. [${t.status}] ${t.subject}`).join('\n');
	return `This thread's checkpoints (${todoProgress(todos)} done):\n${list}\nOnes in review are waiting for the user to approve them on the board; otherwise carry on from the first one that isn't done. Keep their status current with \`oo thread todo <n> <status>\`.`;
}

/** After a step of the thread is committed outside the board (`oo commit`): tick off its checkpoint, as approving it on the board does. */
export async function approveTodo(thread: string, ctx: Context = defaultContext()): Promise<string | undefined> {
	const todos = loadState(join(ctx.dir, 'state.json')).threads.find(t => t.id === thread)?.todos ?? [];
	const item = approvedTodo(todos);
	if (item === -1) return;
	const response = await change({ op: 'todo', thread, item: item + 1, status: 'done' }, ctx);
	return response.ok ? `✓ ${todos[item]!.subject}` : `✗ ${response.message}`;
}

/** Claude hook for SessionStart (see sessionHook.ts): the thread's checkpoints, for claude; undefined if it has none to do. */
export function sessionStarted(input: any, ctx: Context): string | undefined {
	const state = loadState(join(ctx.dir, 'state.json'));
	let thread: string;
	try {
		thread = resolveThreadId(state, undefined, ctx.env, typeof input?.cwd === 'string' ? input.cwd : ctx.cwd);
	} catch {
		return;
	}
	return todoBriefing(state.threads.find(t => t.id === thread)?.todos ?? []);
}

function fail(message: string): number {
	console.error(message);
	return 1;
}

/** Returns the exit code. */
export async function threadCommand(args: string[], ctx: Context = defaultContext()): Promise<number> {
	try {
		return await run(args, ctx);
	} catch (err) {
		if (!(err instanceof CommandError)) throw err;
		if (err.message) console.error(err.message);
		if (err instanceof UsageError) console.error(`usage:\n${THREAD_USAGE}`);
		return 1;
	}
}
