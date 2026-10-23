// `oo thread …`: drive the board from the shell (and from claude, see the oo skill).
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { boardRunning, sendRequest, type DistributiveOmit, type Request, type Response } from './requests.js';
import { COLUMN_LABELS, COLUMNS, DATA_DIR, LOCAL_LABEL, loadState, saveState, TODO_MARKS, TODO_STATUSES, type Column, type State, type Thread, type Todo } from './state.js';
import { applyRequest, inDir, threadDir, todoProgress, type Store } from './threads.js';

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
  Inside a thread's claude, id defaults to that thread. The project defaults to the one you're in.`;

/** What the command runs against; tests swap these out. `tasksDir` is where claude keeps its task lists. */
export type Context = { cwd: string; env: NodeJS.ProcessEnv; dir: string; tasksDir: string; stdin: () => string };

export const defaultContext = (): Context => ({
	cwd: process.cwd(),
	env: process.env,
	dir: DATA_DIR,
	tasksDir: join(homedir(), '.claude', 'tasks'),
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
	throw new UsageError('');
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
	if (responses.at(-1)!.ok) messages.push(TASKS_PROMPT);
	return messages.join('\n');
}

// Its task list is mirrored onto the thread's card (see tasksChanged).
const TASKS_PROMPT =
	'Before starting, break the plan into tasks with TaskCreate (one per step, short subjects), and keep their status current with TaskUpdate as you work: the board shows them on this thread\'s card.';

const isTodoStatus = (status: unknown): status is Todo['status'] => TODO_STATUSES.includes(status as any);

/**
 * Claude's task list after a TaskCreate/TaskUpdate, read from where claude keeps it (one file per task,
 * in a folder named after the session), or the list a TodoWrite (older claudes) was given.
 */
function claudeTodos(input: any, ctx: Context): Todo[] | undefined {
	if (input?.tool_name === 'TodoWrite') {
		const todos = input.tool_input?.todos;
		if (!Array.isArray(todos)) return;
		return todos.filter(t => typeof t?.content === 'string' && isTodoStatus(t.status)).map(t => ({ subject: t.content, status: t.status }));
	}
	if (typeof input?.session_id !== 'string') return;
	const dir = join(ctx.tasksDir, input.session_id);
	let names: string[];
	try {
		names = readdirSync(dir).filter(name => name.endsWith('.json'));
	} catch {
		return;
	}
	const tasks = names.flatMap(name => {
		try {
			return [JSON.parse(readFileSync(join(dir, name), 'utf8'))];
		} catch {
			return [];
		}
	});
	return tasks
		// Deleted tasks, and anything else unrecognised, are left out.
		.filter(t => typeof t?.subject === 'string' && isTodoStatus(t.status))
		.sort((a, b) => Number(a.id) - Number(b.id))
		.map(t => ({ subject: t.subject, status: t.status }));
}

/**
 * Claude hook for claude's task tools (see todosHook.ts): copy claude's task list onto its thread, for the board.
 * Returns what happened; undefined if nothing did.
 */
export async function tasksChanged(input: any, ctx: Context): Promise<string | undefined> {
	const state = loadState(join(ctx.dir, 'state.json'));
	let thread: string;
	try {
		thread = resolveThreadId(state, undefined, ctx.env, typeof input?.cwd === 'string' ? input.cwd : ctx.cwd);
	} catch {
		return;
	}
	const todos = claudeTodos(input, ctx);
	if (!todos) return;
	const current = state.threads.find(t => t.id === thread)?.todos ?? [];
	if (JSON.stringify(current) === JSON.stringify(todos)) return;
	return (await change({ op: 'todos', thread, todos }, ctx)).message;
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
