import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execaSync } from 'execa';
import { z } from 'zod';

export const COLUMNS = ['planned', 'active', 'polish', 'pr', 'done'] as const;
export const COLUMN_LABELS: Record<Column, string> = {
	planned: 'PLANNED',
	active: 'ACTIVE',
	polish: 'POLISH',
	pr: 'PR',
	done: 'DONE',
	archived: 'ARCHIVED',
};
export const LOCAL_LABEL = 'LOCAL';
export const COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue', 'red', 'white'] as const;

const ColumnSchema = z.enum([...COLUMNS, 'archived']);
export type Column = z.infer<typeof ColumnSchema>;

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
	hooks: z.partialRecord(z.enum(HOOK_EVENTS), z.string()).default({}),
	// Where the project's tickets live (see tickets.ts); jira needs the site and the key prefix.
	tracker: z.enum(TRACKERS).default('none'),
	jiraSite: z.string().default(''),
	jiraProject: z.string().default(''),
});
export type Project = z.infer<typeof ProjectSchema>;

export const DEFAULT_WAKE_PROMPT = 'You were interrupted (your session was closed). Pick up where you left off and keep going.';

/** A thread's checkpoints: each is worked on (active), handed over (review), then approved and committed (done). */
export const TODO_STATUSES = ['pending', 'active', 'review', 'done'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
const TodoSchema = z.object({ subject: z.string(), status: z.enum(TODO_STATUSES) });
export type Todo = z.infer<typeof TodoSchema>;
/** A message from another thread's claude (or `user`, from outside one), held until it's put to this thread's claude. */
const MessageSchema = z.object({ from: z.string(), text: z.string(), ts: z.string(), delivered: z.boolean() });
export type Message = z.infer<typeof MessageSchema>;

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
		color: z.enum(COLORS).optional(),
		// Claude's session ID for the thread's latest run, reported by the SessionStart hook; used to resume.
		sessionId: z.string().optional(),
		transcriptPath: z.string().optional(),
		// Imported threads (see transcripts.ts) keep running where they were started instead of in a worktree.
		cwd: z.string().optional(),
		// Set when the thread's worktree is first created (see git.ts); the branch outlives the worktree.
		branch: z.string().optional(),
		// What the branch was created from; the thread diff is against its merge-base.
		base: z.string().optional(),
		// Where the worktree lives; recorded when the project is renamed (see worktreePath).
		worktree: z.string().optional(),
		// The Jira ticket (AV-123) or GitHub issue (#45) the thread works on; names the branch and PR.
		ticket: z.object({ key: z.string(), url: z.string() }).optional(),
		// Opened on moving to PR; polled so the thread moves to Done once it's merged.
		pr: z.object({ number: z.number(), url: z.string() }).optional(),
		// Checkpoints to review and commit, kept across claude runs (see `oo thread todo`).
		todos: z.array(TodoSchema).optional(),
		// Messages from related threads (see `oo thread send`), kept once delivered so `oo thread inbox` can list them.
		inbox: z.array(MessageSchema).optional(),
		// Messages the thread's claude wrote ahead of review (see `oo thread draft`), so the commit and PR
		// forms open filled in instead of waiting on a fresh draft. Each is cleared once used.
		drafts: z.object({ commit: z.string().optional(), pr: z.object({ title: z.string(), body: z.string() }).optional() }).optional(),
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
	const project: Project = { name, abbrev: '', path: home, worktrees: false, color: 'white', wakePrompt: '', hooks: {}, tracker: 'none', jiraSite: '', jiraProject: '' };
	return { ...state, projects: [...state.projects, project] };
}

export function saveState(state: State, file = STATE_FILE): string {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	const json = JSON.stringify(state, null, 2);
	writeFileSync(tmp, json);
	renameSync(tmp, file);
	return json;
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
	if (project.tracker === 'jira' && !project.jiraSite) return 'Jira tickets need a jira site';
	if (project.jiraSite && !isJiraCloudHost(project.jiraSite)) return JIRA_CLOUD_ONLY;
}

export function newThreadId(state: State): string {
	const max = state.threads.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
	return String(max + 1);
}
