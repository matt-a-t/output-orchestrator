import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { execaSync } from 'execa';
import { z } from 'zod';

export const COLUMNS = ['planned', 'active', 'polish', 'pr', 'followup', 'done'] as const;
export const COLUMN_LABELS: Record<Column, string> = {
	ideas: 'IDEAS',
	planned: 'PLANNED',
	active: 'ACTIVE',
	polish: 'POLISH',
	pr: 'PR',
	followup: 'FOLLOW-UP',
	done: 'DONE',
	archived: 'ARCHIVED',
};
export const LOCAL_LABEL = 'LOCAL';
export const COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue', 'red', 'white'] as const;

// IDEAS (before Planned) shelves a thread worth keeping but not planned yet, ARCHIVED (after Done) one that's
// finished with. Both are hidden until I / A shows them, and their threads have no worktree or window.
export const ALL_COLUMNS = ['ideas', ...COLUMNS, 'archived'] as const;
const ColumnSchema = z.enum(ALL_COLUMNS);
export type Column = z.infer<typeof ColumnSchema>;
export const hidden = (column: Column) => column === 'ideas' || column === 'archived';

/** Shell commands a project runs when things happen on the board (see hooks.ts). */
export const HOOK_EVENTS = ['newThread', 'worktreeCreated', 'enterLocal', 'leaveLocal', 'enterPolish', 'leavePolish'] as const;
export type ProjectHook = (typeof HOOK_EVENTS)[number];
export const HOOK_LABELS: Record<ProjectHook, string> = {
	newThread: 'new thread',
	worktreeCreated: 'worktree created',
	enterLocal: 'enter local',
	leaveLocal: 'leave local',
	enterPolish: 'enter polish',
	leavePolish: 'leave polish',
};

export const TRACKERS = ['none', 'github', 'jira'] as const;
export type Tracker = (typeof TRACKERS)[number];

export const DEFAULT_CLOSE_IDLE_AFTER = 30;

/** A named shell command the project runs from the board with r, e.g. a dev server or the tests (see commands.ts). */
const CommandSchema = z.object({ name: z.string(), command: z.string() });
export type ProjectCommand = z.infer<typeof CommandSchema>;

/**
 * A docker compose stack Local runs on the host from the thread's worktree, joining the thread's container to its
 * network (see board/stack.ts). `files` are relative to the worktree; `name` is the compose project name, which by
 * default is what `docker compose` would pick in the project checkout, so it's the same stack as one run by hand.
 */
const ComposeSchema = z.object({
	files: z.array(z.string()).min(1),
	name: z.string().optional(),
});
export type ComposeSetting = z.infer<typeof ComposeSchema>;

/**
 * Where a project's threads run claude when it has one (see container.ts): one long-lived container per thread
 * from `image`, with egress only to the reference firewall's hosts plus `allow`, and `ports` published to the host.
 */
const ContainerSchema = z.object({
	image: z.string(),
	allow: z.array(z.string()).default([]),
	ports: z.array(z.number().int().min(1).max(65535)).default([]),
	compose: ComposeSchema.optional(),
});
export type ContainerSetting = z.infer<typeof ContainerSchema>;

const ProjectSchema = z.object({
	name: z.string(),
	// Shown on board cards in place of the name, when set.
	abbrev: z.string().default(''),
	path: z.string(),
	// Off for a directory that isn't a repo (e.g. ~ or ~/.claude): threads run in the project
	// directory itself, several at once, with no branch, diffs or PR.
	worktrees: z.boolean().default(true),
	color: z.enum(COLORS),
	// What w / W paste into a woken claude; empty means DEFAULT_WAKE_PROMPT.
	wakePrompt: z.string().default(''),
	// Minutes a thread's claude can sit stopped before the board closes its window (see useIdleClose); 0 never does.
	closeIdleAfter: z.number().int().min(0).default(DEFAULT_CLOSE_IDLE_AFTER),
	hooks: z.partialRecord(z.enum(HOOK_EVENTS), z.string()).default({}),
	commands: z.array(CommandSchema).default([]),
	// Where the project's tickets live (see tickets.ts); jira needs the site and the key prefix.
	tracker: z.enum(TRACKERS).default('none'),
	jiraSite: z.string().default(''),
	jiraProject: z.string().default(''),
	// Unset: threads run on the host.
	container: ContainerSchema.optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const DEFAULT_WAKE_PROMPT = 'You were interrupted (your session was closed). Pick up where you left off and keep going.';

/**
 * A thread's checkpoints: each is worked on (active), handed over (review), then approved and committed (done).
 * Ones `afterMerge` (deploying, queries against prod, verifying it, updating docs) wait for the PR to merge,
 * which moves the thread to Follow-up and wakes its claude for them.
 */
export const TODO_STATUSES = ['pending', 'active', 'review', 'done'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
const TodoSchema = z.object({ subject: z.string(), status: z.enum(TODO_STATUSES), afterMerge: z.boolean().optional() });
export type Todo = z.infer<typeof TodoSchema>;
/**
 * A message from another thread's claude, held until it's put to this thread's claude. `from` is the
 * sending thread's id, USER_SENDER for ones the board writes itself, or UNVERIFIED_SENDER for
 * `oo thread send` from outside any thread, which could be anyone (or any claude) with a shell.
 */
export const USER_SENDER = 'user';
export const UNVERIFIED_SENDER = 'unverified';
const MessageSchema = z.object({ from: z.string(), text: z.string(), ts: z.string(), delivered: z.boolean() });
export type Message = z.infer<typeof MessageSchema>;

/** How soon a thread wants doing: each column shows high first and low last, in J/K order within each. */
export const PRIORITIES = ['high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
// How cards and `oo thread list` mark them: a red ▲ for high, a grey ▽ for low.
export const PRIORITY_MARKS: Record<Priority, string> = { high: '▲', normal: '', low: '▽' };
export const PRIORITY_COLORS: Record<Priority, string | undefined> = { high: 'red', normal: undefined, low: 'gray' };

export const TODO_MARKS: Record<TodoStatus, string> = { pending: '○', active: '▸', review: '●', done: '✓' };

const ThreadSchema = z.preprocess(
	// Local used to be a column, "uitest", between Polish and PR.
	(t: any) => (t?.column === 'uitest' ? { ...t, column: 'polish', local: true } : t),
	z.object({
		id: z.string(),
		title: z.string(),
		plan: z.string().default(''),
		project: z.string(),
		// The thread's column on the board, kept while it's in Local.
		column: ColumnSchema,
		// In Local: the branch is checked out in the project's own checkout, and claude works there (one per project).
		local: z.boolean().optional(),
		// In Local by forwarding its project's ports to its container, not by checking its branch out (see board/local.ts).
		forwarded: z.boolean().optional(),
		color: z.enum(COLORS).optional(),
		// Left out for normal, which most threads are.
		priority: z.enum(PRIORITIES).optional(),
		// Claude's session ID for the thread's latest run, reported by the SessionStart hook; used to resume.
		sessionId: z.string().optional(),
		transcriptPath: z.string().optional(),
		// Its plan was approved in a large conversation: once that claude has saved the checkpoints and stopped,
		// the board swaps it for a fresh one on the plan (see useFreshStarts). Cleared by any move.
		freshStart: z.boolean().optional(),
		// Imported threads (see transcripts.ts) keep running where they were started instead of in a worktree.
		cwd: z.string().optional(),
		// Set when the thread's worktree is first created (see git.ts); the branch outlives the worktree.
		branch: z.string().optional(),
		// What the branch was created from; the thread diff is against its merge-base.
		base: z.string().optional(),
		// Where the worktree lives; recorded when the project is renamed (see worktreePath).
		worktree: z.string().optional(),
		// The Jira ticket (AV-123) or GitHub issue (#45) the thread works on; names the branch and PR.
		// What it says, and who said it, are kept when the board reads it: shown to claude as the
		// ticket's content, never as the plan, since anyone can file an issue on a public repo.
		ticket: z
			.object({
				key: z.string(),
				url: z.string(),
				summary: z.string().optional(),
				description: z.string().optional(),
				author: z.string().optional(),
				// A GitHub issue whose author isn't the repo's owner, a member or a collaborator.
				outsider: z.boolean().optional(),
			})
			.optional(),
		// Opened on moving to PR; polled so the thread moves on once it's merged: to Follow-up if it has
		// after-merge checkpoints left, else to Done.
		pr: z.object({ number: z.number(), url: z.string() }).optional(),
		// Checkpoints to review and commit, kept across claude runs (see `oo thread todo`).
		todos: z.array(TodoSchema).optional(),
		// Messages from related threads (see `oo thread send`), kept once delivered so `oo thread inbox` can list them.
		inbox: z.array(MessageSchema).optional(),
		// Messages the thread's claude wrote ahead of review (see `oo thread draft`), so the commit and PR
		// forms open filled in instead of waiting on a fresh draft. Each is cleared once used.
		drafts: z.object({ commit: z.string().optional(), pr: z.object({ title: z.string(), body: z.string() }).optional() }).optional(),
		// The last pop quiz taken before opening its PR (see quiz.ts), with how it went, for z to show again.
		quiz: z
			.object({
				questions: z.array(
					z.discriminatedUnion('kind', [
						z.object({ kind: z.literal('choice'), question: z.string(), choices: z.array(z.string()), answer: z.number(), why: z.string() }),
						z.object({ kind: z.literal('text'), question: z.string(), answer: z.string() }),
					]),
				),
				answers: z.array(z.union([z.number(), z.string(), z.null()])),
				grades: z.array(z.object({ correct: z.boolean(), note: z.string() })),
				result: z.enum(['passed', 'overridden', 'failed']),
				score: z.string(),
				at: z.string(),
			})
			.optional(),
		// Threads this one waits on; dropped as each reaches Done or is archived (see threads.ts).
		blockedBy: z.array(z.string()).optional(),
		// The blocker (also in blockedBy) whose branch this thread's branch builds on; its base is that branch.
		stackedOn: z.string().optional(),
		// Set when the thread it built on merges: that branch's last commit, so u rebases only this thread's own
		// commits onto the default branch (a squash merge leaves the originals behind). Cleared once u runs.
		rebaseFrom: z.string().optional(),
		createdAt: z.string(),
		updatedAt: z.string(),
	}),
);
export type Thread = z.infer<typeof ThreadSchema>;

const StateSchema = z.object({
	version: z.literal(1),
	projects: z.array(ProjectSchema),
	// Array order is the within-column order.
	threads: z.array(ThreadSchema),
});
export type State = z.infer<typeof StateSchema>;

export const DATA_DIR = join(homedir(), '.local', 'share', 'output-orchestrator');
export const STATE_FILE = join(DATA_DIR, 'state.json');
/** Mode for the files oo writes there: thread prompts, messages and claude's events are nobody else's business. */
export const PRIVATE_FILE = 0o600;

/** Create oo's data dir, or close up one made before it was private, so only you can read what's in it. */
export function ensureDataDir(dir = DATA_DIR): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
}

export function loadState(file = STATE_FILE): State {
	let raw: string;
	try {
		raw = readFileSync(file, 'utf8');
	} catch {
		return withHome({ version: 1, projects: [], threads: [] });
	}
	return withHome(StateSchema.parse(JSON.parse(raw)));
}

/** Whether `project` is the built-in one at the home directory. */
export function isHome(project: Project, home = homedir()): boolean {
	return project.path === home;
}

/**
 * The state with a project at `home` (worktrees off), added last if there isn't one, so there's
 * always somewhere to start threads that work on the machine or claude's settings.
 */
export function withHome(state: State, home = homedir()): State {
	if (state.projects.some(p => isHome(p, home))) return state;
	const name = state.projects.some(p => p.name === 'home') ? '~' : 'home';
	const project: Project = { name, abbrev: '', path: home, worktrees: false, color: 'white', wakePrompt: '', closeIdleAfter: DEFAULT_CLOSE_IDLE_AFTER, hooks: {}, commands: [], tracker: 'none', jiraSite: '', jiraProject: '' };
	return { ...state, projects: [...state.projects, project] };
}

/** What the state file looked like right after a save, to tell that save apart from another program's write. */
export type Saved = { mtimeMs: number; size: number };

/** Save the state, compactly: it's rewritten on every change, and the board, the CLI and claude's hooks all parse it. */
export function saveState(state: State, file = STATE_FILE): Saved {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(state), { mode: PRIVATE_FILE });
	renameSync(tmp, file);
	const { mtimeMs, size } = statSync(file);
	return { mtimeMs, size };
}

/** Whether the file, as `stat` sees it now, is still the one `saved` wrote, so there's nothing new to load. */
export function stillSaved(saved: Saved | null, stat: Saved): boolean {
	return !!saved && stat.mtimeMs === saved.mtimeMs && stat.size === saved.size;
}

/** Whether `path` is in a git repo. */
export function isRepo(path: string): boolean {
	return execaSync('git', ['-C', path, 'rev-parse', '--git-dir'], { reject: false }).exitCode === 0;
}

/** Whether `host` is a Jira Cloud site, the only kind JIRA_EMAIL and JIRA_API_TOKEN are sent to. */
export const isJiraCloudHost = (host: string) => /^[a-z0-9-]+\.atlassian\.net$/i.test(host);
export const JIRA_CLOUD_ONLY = 'The jira site must be yourco.atlassian.net (JIRA_EMAIL and JIRA_API_TOKEN are only sent to Jira Cloud)';

/** Why `project` can't be saved over the project currently named `original` (undefined for a new one), if it can't. */
export function projectProblem(state: State, project: Project, original?: string): string | undefined {
	if (!project.name) return 'Name is empty';
	const old = state.projects.find(p => p.name === original);
	if (old && isHome(old) && project.path !== old.path) return `${old.name} is the built-in home project — its path is always ${old.path}`;
	if (!old && isHome(project)) return `${project.path} is already the ${state.projects.find(p => isHome(p))?.name} project`;
	if (project.name !== original && state.projects.some(p => p.name === project.name)) return `Project "${project.name}" already exists`;
	if (!existsSync(project.path)) return `No such directory: ${project.path}`;
	if (project.worktrees && !isRepo(project.path)) return `${project.path} isn't a git repo — turn worktrees off for a project without one`;
	if (project.container && !project.worktrees) return 'A container needs worktrees on: each thread gets its own worktree to mount';
	if (project.tracker === 'jira' && !project.jiraSite) return 'Jira tickets need a jira site';
	if (project.jiraSite && !isJiraCloudHost(project.jiraSite)) return JIRA_CLOUD_ONLY;
}

/**
 * The container fields as the projects screen edits them: ports, allowed hosts and compose files are comma or space
 * separated, and `stack` is the compose project name.
 */
export type ContainerText = { image: string; ports: string; allow: string; compose: string; stack: string };

export const containerText = (container: ContainerSetting | undefined): ContainerText => ({
	image: container?.image ?? '',
	ports: container?.ports.join(', ') ?? '',
	allow: container?.allow.join(', ') ?? '',
	compose: container?.compose?.files.join(', ') ?? '',
	stack: container?.compose?.name ?? '',
});

/** The setting `text` describes (undefined with no image), or why it can't be saved. */
export function parseContainer(text: ContainerText): { container?: ContainerSetting; problem?: string } {
	const list = (s: string) => s.split(/[\s,]+/).filter(Boolean);
	const image = text.image.trim();
	const files = [...new Set(list(text.compose))];
	const name = text.stack.trim();
	if (!image) return list(text.ports).length || list(text.allow).length || files.length || name ? { problem: 'Container ports, hosts and compose need an image' } : {};
	const ports: number[] = [];
	for (const p of list(text.ports)) {
		const n = Number(p);
		if (!Number.isInteger(n) || n < 1 || n > 65535) return { problem: `Container port ${p} isn't a port number` };
		if (!ports.includes(n)) ports.push(n);
	}
	if (name && !files.length) return { problem: 'A stack name needs compose files' };
	// What docker compose accepts as a project name.
	if (name && !/^[a-z0-9][a-z0-9_-]*$/.test(name)) return { problem: `Stack name ${name} needs lowercase letters, digits, - and _` };
	if (files.some(f => isAbsolute(f) || f.split('/').includes('..'))) return { problem: "Compose files are relative to the thread's worktree, inside it" };
	const compose = files.length ? { files, ...(name ? { name } : {}) } : undefined;
	return { container: { image, ports, allow: [...new Set(list(text.allow))], ...(compose ? { compose } : {}) } };
}

export function newThreadId(state: State): string {
	const max = state.threads.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
	return String(max + 1);
}
