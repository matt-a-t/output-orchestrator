// `oo thread …`: drive the board from the shell (and from claude, see the oo skill).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardRunning, sendRequest, type DistributiveOmit, type Request, type Response } from './requests.js';
import { COLUMN_LABELS, COLUMNS, DATA_DIR, LOCAL_LABEL, loadState, PRIORITIES, PRIORITY_MARKS, saveState, TODO_MARKS, TODO_STATUSES, UNVERIFIED_SENDER, type Column, type Priority, type Project, type State, type Thread, type Todo, type TodoStatus } from './state.js';
import { applyRequest, approvedTodo, blockers, followUps, inDir, merged, nextTodo, priorityOf, threadDir, todoProgress, todosDone, messagesPrompt, senderLabel, undelivered, type Store, type TodoItem } from './threads.js';
import { sanitize } from './sanitize.js';
import { normalizeKey, ticketContent, ticketUrl } from './tickets.js';

export const THREAD_USAGE = `  oo thread add <title> [--project <name>] [--plan-file <path>|-] [--ticket <key>] [--from <id>]
                              new Planned thread; prints its id (--plan-file - reads the plan from stdin)
                              --ticket: the Jira key (AV-123, or 123 for the project's prefix) or GitHub issue (#45) it's for
                              --from: build on that thread's branch, blocked by it until it lands (its project by default)
  oo thread list [--json] [--project <name>] [--column <column>]
  oo thread show [id] [--json]
  oo thread move [id] <column>
                              columns: ${[...COLUMNS, 'archived'].join(', ')}
                              Moving to pr is oo thread pr; a thread in Local can't move until it's back.
  oo thread pr [id] [--title <title>] [--body-file <path>|-]
                              push the thread's branch, open its PR (unless it has one) and move it to PR, from Local too.
                              Without --body-file, it's the saved PR draft (oo thread draft pr), else claude drafts the description, and the title unless --title is given;
                              with it and no --title, the title is the thread's. Needs the board running.
  oo thread local [id] [in|out]
                              put the thread in Local, checking its branch out in the project's own checkout,
                              or bring it back (no direction: toggle, like t on the board). Needs the board running.
  oo thread plan [id] --plan-file <path>|-
                              replace the thread's plan
  oo thread priority [id] <${PRIORITIES.join('|')}>
                              high threads sit at the top of their column on the board, low ones at the bottom
  oo thread todo [id] set --file <path>|-
                              replace the thread's checkpoints, one per line (items already on it keep their status).
                              Start a line "after merge:" for one that waits for the PR to merge (deploying, prod queries, docs);
                              the merge moves the thread to followup instead of done and wakes its claude for them
  oo thread todo [id] <n> <${TODO_STATUSES.join('|')}>
                              set checkpoint n's status (numbered as \`oo thread show\` lists them)
  oo thread send <id> [--wake] (<message> | --file <path>|-)
                              tell a related thread's claude something, from this thread (or, outside one, marked unverified).
                              It's put to that claude when its turn ends, or when it next starts if it's closed;
                              --wake resumes a closed one to hear it now (needs the board running).
  oo thread inbox [id]        the messages other threads have sent this one
  oo thread block [id] <blocker>
                              record that the thread waits on another; it's dropped once that one reaches Done or is archived.
                              A blocker in the same project with a branch is one to build on: the thread's branch moves onto
                              it if it has no commits yet, and its diff and PR are against that branch either way
  oo thread unblock [id] (<blocker> | --all)
                              stop waiting on that thread, or with --all on any
  oo thread draft [id] commit --message <message>
  oo thread draft [id] pr [--title <title>] --body-file <path>|-
                              save the commit message (or PR title and description) the board's form opens with,
                              instead of claude drafting one then; it's cleared once used. No --title: the thread's
  Inside a thread's claude, id defaults to that thread, and it can change only that one: others it can only
  message, without --wake. The project defaults to the one you're in.`;

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

/** The ticket `--ticket` names, in the project's form; its url is left empty if gh can't say. */
async function resolveTicket(project: Project, input: string | undefined): Promise<Thread['ticket']> {
	if (input === undefined) return;
	if (project.tracker === 'none') throw new CommandError(`${project.name} has no ticket tracker; set one in the board's projects screen (P)`);
	const key = normalizeKey(project, input);
	if (!key) throw new CommandError(`Not a ${project.tracker === 'github' ? 'GitHub issue number' : 'Jira key'}: ${input}`);
	return { key, url: await ticketUrl(project, key).catch(() => '') };
}

function parseColumn(name: string): Column {
	const column = ALL_COLUMNS.find(c => c === name.toLowerCase());
	if (!column) throw new UsageError(`Unknown column "${name}"; one of ${ALL_COLUMNS.join(', ')}`);
	return column;
}

/**
 * The thread whose directory `cwd` is in, picking the innermost if they nest. None if a project
 * checkout inside it is nearer, e.g. ~/app under a thread in a project at ~ without worktrees.
 */
function threadAt(state: State, cwd: string): Thread | undefined {
	const found = state.threads
		.map(t => ({ t, dir: threadDir(state, t) }))
		.filter(({ dir }) => dir && inDir(cwd, dir))
		.sort((a, b) => b.dir!.length - a.dir!.length)[0];
	if (found && !state.projects.some(p => inDir(cwd, p.path) && p.path.length > found.dir!.length)) return found.t;
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

/**
 * A thread's claude may be prompt-injected, so it changes only its own thread: OO_THREAD_ID's, or the one
 * it's working in, as OO_THREAD_ID can leak into another thread's claude (see fromThreadDir). Others it
 * can only message. Not a sandbox (it could unset OO_THREAD_ID), but an injected "move #5 to done" doesn't just work.
 */
function ownThreadOnly(state: State, thread: string, ctx: Context): string {
	const own = ctx.env.OO_THREAD_ID;
	if (!own || thread === own || thread === threadAt(state, ctx.cwd)?.id) return thread;
	throw new CommandError(`A thread's claude can only change its own thread; message #${thread} with oo thread send, or ask the user`);
}

/** Through the board if it's running (it owns state.json then), else straight to state.json. */
async function change(request: DistributiveOmit<Request, 'id'>, ctx: Context & { timeoutMs?: number }): Promise<Response> {
	if (boardRunning(ctx.dir)) return sendRequest(request, { dir: ctx.dir, timeoutMs: ctx.timeoutMs });
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

function summary(state: State, t: Thread): string {
	const waiting = blockers(state, t).map(b => `#${b.id}`).join(',');
	const mark = PRIORITY_MARKS[priorityOf(t)];
	return `#${t.id}\t${where(t)}${mark ? ` ${mark}` : ''}${waiting ? ` ⧗${waiting}` : ''}\t${t.project}\t${t.title}`;
}

function details(state: State, t: Thread): string {
	const lines = [`#${t.id} ${t.title}`, `column:  ${where(t)}`, `project: ${t.project}`];
	if (t.priority) lines.push(`priority: ${t.priority}`);
	for (const b of blockers(state, t)) lines.push(`blocked: #${b.id} ${b.title} (${where(b)})`);
	if (t.ticket) lines.push(`ticket:  ${t.ticket.key}${t.ticket.url ? ` ${t.ticket.url}` : ''}`);
	if (t.branch) lines.push(`branch:  ${t.branch}${t.base ? ` (from ${t.base})` : ''}`);
	const dir = threadDir(state, t);
	if (dir) lines.push(`dir:     ${dir}`);
	if (t.pr) lines.push(`PR:      #${t.pr.number} ${t.pr.url}`);
	if (t.sessionId) lines.push(`session: ${t.sessionId}`);
	const unread = undelivered(t.inbox).length;
	if (unread) lines.push(`inbox:   ${unread} not yet delivered (oo thread inbox)`);
	if (t.todos?.length) lines.push(`todos:   ${todoProgress(t.todos)} done`, ...t.todos.map(todo => `  ${TODO_MARKS[todo.status]} ${todoSubject(todo)}`));
	const content = t.ticket && ticketContent(t.ticket);
	if (content) lines.push('', content);
	if (t.plan) lines.push('', t.plan);
	return lines.join('\n');
}

/** Text from a file, or stdin for `-`, sanitized like the command line. */
function readInput(ctx: Context, file: string): string {
	return sanitize(file === '-' ? ctx.stdin() : readFileSync(file, 'utf8'));
}

async function run(args: string[], ctx: Context): Promise<number> {
	// Titles, messages and the rest are kept and shown to people and claudes, so no terminal escapes in them.
	const [sub, ...rest] = args.map(sanitize);
	const state = loadState(join(ctx.dir, 'state.json'));
	if (sub === 'add') {
		const { positional, flag } = parseArgs(rest, ['project', 'plan-file', 'ticket', 'from'], []);
		const title = positional.join(' ').trim();
		if (!title) throw new UsageError('Give the thread a title');
		const planFile = flag('plan-file');
		const plan = planFile === undefined ? '' : readInput(ctx, planFile).trim();
		const from = flag('from') === undefined ? undefined : resolveThreadId(state, flag('from'), ctx.env, ctx.cwd);
		// Building on another thread means being in its project.
		const project = resolveProject(state, ctx.cwd, flag('project') ?? state.threads.find(t => t.id === from)?.project);
		const ticket = await resolveTicket(state.projects.find(p => p.name === project)!, flag('ticket'));
		const response = await change({ op: 'add', project, title, plan, ticket, from }, ctx);
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
		console.log(has('json') ? JSON.stringify(threads, null, 2) : threads.map(t => summary(state, t)).join('\n'));
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
		const thread = ownThreadOnly(state, resolveThreadId(state, positional.length === 2 ? positional[0] : undefined, ctx.env, ctx.cwd), ctx);
		// That removes the worktree and closes the thread's claude, which is likely the one asking. A thread
		// with its own directory (imported, or in a project without worktrees) keeps both.
		const ownDir = state.threads.find(t => t.id === thread)?.cwd;
		if ((column === 'done' || column === 'archived') && !ownDir && threadAt(state, ctx.cwd)?.id === thread) {
			return fail(`Moving #${thread} to ${COLUMN_LABELS[column]} from its own directory would close its claude — do it from the board`);
		}
		const response = await change({ op: 'move', thread, column }, ctx);
		if (!response.ok) return fail(response.message);
		console.log(response.message);
		return 0;
	}
	if (sub === 'block' || sub === 'unblock') {
		const { positional, has } = parseArgs(rest, [], sub === 'unblock' ? ['all'] : []);
		const all = has('all');
		const usage = sub === 'block' ? 'oo thread block [id] <blocker>' : 'oo thread unblock [id] (<blocker> | --all)';
		// Like move, the last id is the one acted on (the blocker); one before it is the thread, else this one.
		const max = all ? 1 : 2;
		if (positional.length > max || (!all && !positional.length)) throw new UsageError(usage);
		const own = positional.length === max ? positional[0] : undefined;
		const thread = ownThreadOnly(state, resolveThreadId(state, own, ctx.env, ctx.cwd), ctx);
		const blocker = all ? undefined : resolveThreadId(state, positional.at(-1), ctx.env, ctx.cwd);
		return report(await change(sub === 'block' ? { op: 'block', thread, blocker: blocker! } : { op: 'unblock', thread, blocker }, ctx));
	}
	if (sub === 'local') {
		const { positional } = parseArgs(rest, [], []);
		if (positional.length > 2) throw new UsageError('oo thread local [id] [in|out]');
		const last = positional.at(-1);
		const direction = last === 'in' || last === 'out' ? last : undefined;
		const ids = direction ? positional.slice(0, -1) : positional;
		if (ids.length > 1) throw new UsageError(`Unknown direction "${last}"; in or out`);
		const thread = ownThreadOnly(state, resolveThreadId(state, ids[0], ctx.env, ctx.cwd), ctx);
		// It checks out, closes and resumes claude and runs hooks, which only the board can do.
		if (!boardRunning(ctx.dir)) return fail('Moving into or out of Local needs the board running');
		return report(await sendRequest({ op: 'local', thread, local: direction ? direction === 'in' : 'toggle' }, { dir: ctx.dir }));
	}
	if (sub === 'pr') {
		const { positional, flag } = parseArgs(rest, ['title', 'body-file'], []);
		if (positional.length > 1) throw new UsageError(`Unexpected ${positional[1]}`);
		const bodyFile = flag('body-file');
		const body = bodyFile === undefined ? undefined : readInput(ctx, bodyFile).trim();
		const title = flag('title')?.trim() || undefined;
		const thread = ownThreadOnly(state, resolveThreadId(state, positional[0], ctx.env, ctx.cwd), ctx);
		// It pushes, opens the PR, moves the thread and runs hooks, which only the board can do.
		if (!boardRunning(ctx.dir)) return fail('Opening a PR needs the board running');
		// claude drafting the description and the push can take a few minutes.
		return report(await sendRequest({ op: 'pr', thread, title, body }, { dir: ctx.dir, timeoutMs: 5 * 60_000 }));
	}
	if (sub === 'priority') {
		const { positional } = parseArgs(rest, [], []);
		if (positional.length < 1 || positional.length > 2) throw new UsageError(`oo thread priority [id] <${PRIORITIES.join('|')}>`);
		const priority = positional.at(-1)!.toLowerCase();
		if (!PRIORITIES.includes(priority as Priority)) throw new UsageError(`Unknown priority "${priority}"; one of ${PRIORITIES.join(', ')}`);
		const thread = ownThreadOnly(state, resolveThreadId(state, positional.length === 2 ? positional[0] : undefined, ctx.env, ctx.cwd), ctx);
		return report(await change({ op: 'priority', thread, priority: priority as Priority }, ctx));
	}
	if (sub === 'plan') {
		const { positional, flag } = parseArgs(rest, ['plan-file'], []);
		if (positional.length > 1) throw new UsageError(`Unexpected ${positional[1]}`);
		const planFile = flag('plan-file');
		if (planFile === undefined) throw new UsageError('oo thread plan [id] --plan-file <path>|-');
		const plan = readInput(ctx, planFile).trim();
		const thread = ownThreadOnly(state, resolveThreadId(state, positional[0], ctx.env, ctx.cwd), ctx);
		const response = await change({ op: 'plan', thread, plan }, ctx);
		if (!response.ok) return fail(response.message);
		console.log(response.message);
		return 0;
	}
	if (sub === 'draft') {
		const { positional, flag } = parseArgs(rest, ['message', 'title', 'body-file'], []);
		const kind = positional.at(-1);
		if (positional.length < 1 || positional.length > 2 || (kind !== 'commit' && kind !== 'pr')) {
			throw new UsageError('oo thread draft [id] commit --message <message> | pr [--title <title>] --body-file <path>|-');
		}
		const thread = ownThreadOnly(state, resolveThreadId(state, positional.length === 2 ? positional[0] : undefined, ctx.env, ctx.cwd), ctx);
		if (kind === 'commit') {
			const message = flag('message')?.trim();
			if (!message) throw new UsageError('oo thread draft [id] commit --message <message>');
			return report(await change({ op: 'draft', thread, commit: message }, ctx));
		}
		const bodyFile = flag('body-file');
		if (bodyFile === undefined) throw new UsageError('oo thread draft [id] pr [--title <title>] --body-file <path>|-');
		const body = readInput(ctx, bodyFile).trim();
		const title = flag('title')?.trim() || state.threads.find(t => t.id === thread)!.title;
		return report(await change({ op: 'draft', thread, pr: { title, body } }, ctx));
	}
	if (sub === 'todo') {
		const { positional, flag } = parseArgs(rest, ['file'], []);
		if (positional.at(-1) === 'set') {
			const file = flag('file');
			if (positional.length > 2 || file === undefined) throw new UsageError('oo thread todo [id] set --file <path>|-');
			const items = todoLines(readInput(ctx, file));
			const thread = ownThreadOnly(state, resolveThreadId(state, positional.length === 2 ? positional[0] : undefined, ctx.env, ctx.cwd), ctx);
			return report(await change({ op: 'todos', thread, items }, ctx));
		}
		if (positional.length < 2 || positional.length > 3) throw new UsageError('oo thread todo [id] <n> <status>');
		const [item, status] = positional.slice(-2) as [string, string];
		if (!TODO_STATUSES.includes(status as TodoStatus)) throw new UsageError(`Unknown status "${status}"; one of ${TODO_STATUSES.join(', ')}`);
		if (!/^[1-9]\d*$/.test(item)) throw new UsageError(`"${item}" isn't a checkpoint number`);
		const thread = ownThreadOnly(state, resolveThreadId(state, positional.length === 3 ? positional[0] : undefined, ctx.env, ctx.cwd), ctx);
		return report(await change({ op: 'todo', thread, item: Number(item), status: status as TodoStatus }, ctx));
	}
	if (sub === 'send') {
		const { positional, flag, has } = parseArgs(rest, ['file'], ['wake']);
		const [to, ...words] = positional;
		const file = flag('file');
		if (!to || (file === undefined) === !words.length) throw new UsageError('oo thread send <id> [--wake] (<message> | --file <path>|-)');
		const text = (file === undefined ? words.join(' ') : readInput(ctx, file)).trim();
		if (!text) throw new UsageError('The message is empty');
		const thread = resolveThreadId(state, to, ctx.env, ctx.cwd);
		const from = senderId(state, ctx);
		// Resuming a claude is something only the board can do.
		if (has('wake') && ctx.env.OO_THREAD_ID) return fail("--wake is for the user, not a thread's claude");
		if (has('wake') && !boardRunning(ctx.dir)) return fail('--wake needs the board running');
		return report(await change({ op: 'send', thread, from, text, wake: has('wake') || undefined }, has('wake') ? { ...ctx, timeoutMs: 60_000 } : ctx));
	}
	if (sub === 'inbox') {
		const { positional } = parseArgs(rest, [], []);
		if (positional.length > 1) throw new UsageError(`Unexpected ${positional[1]}`);
		const thread = state.threads.find(t => t.id === resolveThreadId(state, positional[0], ctx.env, ctx.cwd))!;
		const inbox = thread.inbox ?? [];
		if (!inbox.length) console.log(`#${thread.id} has no messages`);
		for (const m of inbox) {
			console.log(`${m.ts.slice(0, 16).replace('T', ' ')}  from ${senderLabel(m.from)}${m.delivered ? '' : ' (not yet delivered)'}\n  ${m.text.replace(/\n/g, '\n  ')}`);
		}
		return 0;
	}
	throw new UsageError('');
}

/** The thread sending from here, if this is a thread's claude (or its directory), else unverified: the user can't be told apart from a claude that cd'd out. */
function senderId(state: State, ctx: Context): string {
	try {
		return resolveThreadId(state, undefined, ctx.env, ctx.cwd);
	} catch {
		return threadAt(state, ctx.cwd)?.id ?? UNVERIFIED_SENDER;
	}
}

/** One checkpoint per line, without list markers or checkboxes; an "after merge:" prefix marks one that waits for the merge. */
function todoLines(text: string): TodoItem[] {
	return text
		.split('\n')
		.map(line => line.replace(/^\s*(?:[-*]|\d+[.)])?\s*(?:\[[ xX]\]\s*)?/, '').trim())
		.filter(Boolean)
		.map(line => {
			const subject = line.replace(/^after merge\s*:\s*/i, '');
			return subject === line ? { subject } : { subject, afterMerge: true };
		});
}

/** How a checkpoint is listed for people and claudes: after-merge ones say so. */
const todoSubject = (todo: Todo) => `${todo.afterMerge ? '(after merge) ' : ''}${todo.subject}`;

function report(response: Response): number {
	if (!response.ok) return fail(response.message);
	console.log(response.message);
	return 0;
}

/** The plan claude had approved, from ExitPlanMode's PostToolUse input: inline, or in the file it was written to. */
function approvedPlan(input: any): string | undefined {
	const inline = input?.tool_input?.plan ?? input?.tool_response?.plan;
	if (typeof inline === 'string' && inline.trim()) return sanitize(inline).trim();
	const file = input?.tool_input?.planFilePath ?? input?.tool_response?.filePath;
	if (typeof file !== 'string') return;
	try {
		return sanitize(readFileSync(file, 'utf8')).trim() || undefined;
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
Start a line with "after merge:" for work that can only happen once the PR has merged: database queries or data fixes against shared or production systems, the deploy itself, verifying it in production, updating docs or filing tickets. List them in the order they have to happen around the deploy; a step that must run before the code goes out comes before the deploy step, or before the merge if merging deploys. The board keeps them back until the PR merges, then moves the thread to Follow-up and wakes you for them.
Mark one active (\`oo thread todo <n> active\`) when you start it and review when it's ready, then stop and let the user review it; approving the step on the board commits it and marks it done.
Just before marking one review, save its commit message with \`oo thread draft commit --message <message>\` (and, for the last one, the PR's with \`oo thread draft pr --title <title> --body-file - <<'EOF'\`), so the board's forms open with them.`;

/** What a thread's claude is told as it starts: where the thread's checkpoints stand, and whether its PR has merged (`isMerged`). */
export function todoBriefing(todos: Todo[], isMerged = false): string | undefined {
	if (!todos.length || todosDone(todos)) return;
	const list = todos.map((t, i) => `  ${i + 1}. [${t.status}] ${todoSubject(t)}`).join('\n');
	const next = nextTodo(todos, isMerged) === -1 ? '.' : "; otherwise carry on from the first one that isn't done.";
	const waiting = !isMerged && followUps(todos).length ? ' After-merge ones wait until the PR has merged: the board wakes you for them then.' : '';
	return `This thread's checkpoints (${todoProgress(todos)} done):\n${list}\nOnes in review are waiting for the user to approve them on the board${next}${waiting} Keep their status current with \`oo thread todo <n> <status>\`.`;
}

/** What a thread's claude is woken with when its PR merges with after-merge checkpoints left (see checkPr). */
export function followUpPrompt(todos: Todo[], pr: { number: number }): string {
	const list = todos.flatMap((t, i) => (t.afterMerge && t.status !== 'done' ? [`  ${i + 1}. ${t.subject}`] : [])).join('\n');
	return [
		`PR #${pr.number} has merged, so this thread is in Follow-up for its after-merge checkpoints:\n${list}`,
		"Work through them in order as before: mark each active, then review when it's done, and stop for the user to approve it.",
		'These act on live systems: show the user any query or command against shared or production systems, and wait for their go-ahead before running it.',
		"Don't commit anything: the branch has merged, so a code change now belongs in a new thread (`oo thread add`).",
	].join('\n');
}

/**
 * What claude is told once its step is approved, and committed unless there's no `commitSubject` (a
 * checkpoint approved with no changes): which checkpoint that was (`ticked`, -1 for none), the user's
 * comments from the commit form and what to do next. `todos` are the checkpoints after ticking it off, and
 * `isMerged` whether the PR has merged, which after-merge ones wait for. Undefined after the last one with
 * no comments and nothing left waiting: claude has already stopped, so there's nothing to tell it.
 */
export function approvedPrompt(todos: Todo[], ticked: number, commitSubject?: string, notes = '', isMerged = false): string | undefined {
	const next = nextTodo(todos, isMerged);
	const waiting = !isMerged && followUps(todos).length > 0;
	if (next === -1 && !notes && !waiting) return;
	const done =
		commitSubject === undefined
			? `The user approved your step "${todos[ticked]?.subject}" with no changes to commit.`
			: `${ticked === -1 ? 'The user approved your changes and committed them' : `The user approved and committed your step "${todos[ticked]!.subject}"`} (commit: ${commitSubject}).`;
	const then =
		next !== -1
			? `Move on to the next checkpoint: ${next + 1}. ${todos[next]!.subject}. Mark it active with \`oo thread todo ${next + 1} active\`.`
			: waiting
				? 'That was the last step before the merge: open its PR (`oo thread pr`) only when the user asks. The after-merge checkpoints wait until it has merged, when the board wakes you for them.'
				: isMerged
					? 'That was the last after-merge step: stop, and the user moves the thread to Done.'
					: 'That was the last step: open its PR (`oo thread pr`) only when the user asks.';
	const comments = notes && `The user's comments, to handle before ${next === -1 ? 'you stop' : 'moving on'}: "${notes}".`;
	return [done, comments, then].filter(Boolean).join(' ');
}

/**
 * After a step of the thread is committed outside the board (`oo commit`): tick off its checkpoint and
 * drop the commit draft it used, as approving it on the board does.
 */
export async function approveTodo(thread: string, ctx: Context = defaultContext()): Promise<string | undefined> {
	const stored = loadState(join(ctx.dir, 'state.json')).threads.find(t => t.id === thread);
	if (stored?.drafts?.commit) await change({ op: 'draft', thread, commit: null }, ctx);
	const todos = stored?.todos ?? [];
	const item = approvedTodo(todos);
	if (item === -1) return;
	const response = await change({ op: 'todo', thread, item: item + 1, status: 'done' }, ctx);
	return response.ok ? `✓ ${todos[item]!.subject}` : `✗ ${response.message}`;
}

/** What a thread's claude is told as it starts in Local, which the move into it restarts claude for. Imported threads don't move. */
function localBriefing(state: State, t: Thread): string | undefined {
	if (!t.local || t.cwd) return;
	return `You're in Local: working in the project's own checkout at ${threadDir(state, t)} on ${t.branch}, which the user's dev setup runs from; your changes are live there. \`oo thread local out\` (or t on the board) brings it back to its worktree.`;
}

/** What a thread's claude is told as it starts about the project's other open threads, so it knows who it can tell about its work. */
function relatedBriefing(state: State, t: Thread): string | undefined {
	const open = state.threads.filter(o => o.id !== t.id && o.project === t.project && o.column !== 'done' && o.column !== 'archived');
	if (!open.length) return;
	const shown = open.slice(0, 8).map(o => `#${o.id} ${o.title} (${COLUMN_LABELS[o.column]})`);
	const more = open.length > shown.length ? `, and ${open.length - shown.length} more (oo thread list)` : '';
	return `Other open threads in ${t.project}: ${shown.join('; ')}${more}. If your work changes something one of them relies on, tell it with \`oo thread send <id> --file - <<'EOF'\`.`;
}

/**
 * Claude hook for SessionStart (see sessionHook.ts): whether it's in Local, the thread's checkpoints, messages
 * waiting for it and the project's other open threads, for claude; undefined if there's none of those. The messages count as delivered then.
 */
export async function sessionStarted(input: any, ctx: Context): Promise<string | undefined> {
	const state = loadState(join(ctx.dir, 'state.json'));
	let id: string;
	try {
		id = resolveThreadId(state, undefined, ctx.env, typeof input?.cwd === 'string' ? input.cwd : ctx.cwd);
	} catch {
		return;
	}
	const thread = state.threads.find(t => t.id === id)!;
	const messages = undelivered(thread.inbox);
	// Briefly, since claude waits on this hook to start; a board busy with something slow applies it later.
	if (messages.length) await change({ op: 'delivered', thread: id, count: messages.length }, { ...ctx, timeoutMs: 5_000 });
	const parts = [localBriefing(state, thread), todoBriefing(thread.todos ?? [], merged(thread)), messages.length ? messagesPrompt(state, messages) : undefined, relatedBriefing(state, thread)].filter(Boolean);
	return parts.length ? parts.join('\n') : undefined;
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
