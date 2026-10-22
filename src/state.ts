import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
export const HOOK_EVENTS = ['enterLocal', 'leaveLocal'] as const;
export type ProjectHook = (typeof HOOK_EVENTS)[number];
export const HOOK_LABELS: Record<ProjectHook, string> = { enterLocal: 'enter local', leaveLocal: 'leave local' };

const ProjectSchema = z.object({
	name: z.string(),
	// Shown on board cards in place of the name, when set.
	abbrev: z.string().default(''),
	path: z.string(),
	color: z.enum(COLORS),
	hooks: z.partialRecord(z.enum(HOOK_EVENTS), z.string()).default({}),
});
export type Project = z.infer<typeof ProjectSchema>;

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
		// Opened on moving to PR; polled so the thread moves to Done once it's merged.
		pr: z.object({ number: z.number(), url: z.string() }).optional(),
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
		return { version: 1, projects: [], threads: [] };
	}
	return StateSchema.parse(JSON.parse(raw));
}

export function saveState(state: State, file = STATE_FILE): string {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	const json = JSON.stringify(state, null, 2);
	writeFileSync(tmp, json);
	renameSync(tmp, file);
	return json;
}

/** Why `project` can't be saved over the project currently named `original` (undefined for a new one), if it can't. */
export function projectProblem(state: State, project: Project, original?: string): string | undefined {
	if (!project.name) return 'Name is empty';
	if (project.name !== original && state.projects.some(p => p.name === project.name)) return `Project "${project.name}" already exists`;
	if (!existsSync(project.path)) return `No such directory: ${project.path}`;
}

export function newThreadId(state: State): string {
	const max = state.threads.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
	return String(max + 1);
}
