import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
export const COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue', 'red', 'white'] as const;

const ColumnSchema = z.enum([...COLUMNS, 'archived']);
export type Column = z.infer<typeof ColumnSchema>;

const ProjectSchema = z.object({
	name: z.string(),
	path: z.string(),
	color: z.enum(COLORS),
});
export type Project = z.infer<typeof ProjectSchema>;

const ThreadSchema = z.object({
	id: z.string(),
	title: z.string(),
	plan: z.string().default(''),
	project: z.string(),
	column: ColumnSchema,
	color: z.enum(COLORS).optional(),
	// Latest claude session for this thread, reported by the SessionStart hook; used to resume.
	sessionId: z.string().optional(),
	transcriptPath: z.string().optional(),
	// Imported sessions (see sessions.ts) keep running where they were started instead of in a worktree.
	cwd: z.string().optional(),
	// Set when the thread's worktree is first created (see git.ts); the branch outlives the worktree.
	branch: z.string().optional(),
	// What the branch was created from; the thread diff is against its merge-base.
	base: z.string().optional(),
	// Opened on moving to PR; polled so the thread moves to Done once it's merged.
	pr: z.object({ number: z.number(), url: z.string() }).optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
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

export function loadState(): State {
	let raw: string;
	try {
		raw = readFileSync(STATE_FILE, 'utf8');
	} catch {
		return { version: 1, projects: [], threads: [] };
	}
	return StateSchema.parse(JSON.parse(raw));
}

export function saveState(state: State): string {
	mkdirSync(DATA_DIR, { recursive: true });
	const tmp = `${STATE_FILE}.tmp`;
	const json = JSON.stringify(state, null, 2);
	writeFileSync(tmp, json);
	renameSync(tmp, STATE_FILE);
	return json;
}

export function newThreadId(state: State): string {
	const max = state.threads.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
	return String(max + 1);
}
