import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { saveState, type State, type Thread } from './state.js';

// Moves to Done/archived close the thread's tmux window; point tmux at a socket dir with no server
// so tests can't touch the real board's windows.
delete process.env.TMUX;
process.env.TMUX_TMPDIR = mkdtempSync(join(tmpdir(), 'oo-tmux-'));

/**
 * A data dir with state.json holding project "p" (at `<dir>/p`, with a `sub` folder) and `threads`.
 * Give threads a `cwd` (like imported ones) so they have a directory without git worktrees.
 */
export function fixture(threads: Partial<Thread>[] = []): { dir: string; project: string; state: State } {
	const dir = mkdtempSync(join(tmpdir(), 'oo-test-'));
	const project = join(dir, 'p');
	mkdirSync(join(project, 'sub'), { recursive: true });
	const now = new Date().toISOString();
	const state: State = {
		version: 1,
		projects: [{ name: 'p', abbrev: '', path: project, color: 'cyan', wakePrompt: '', hooks: {} }],
		threads: threads.map((t, i) => ({
			id: String(i + 1),
			title: `thread ${i + 1}`,
			plan: '',
			project: 'p',
			column: 'planned',
			createdAt: now,
			updatedAt: now,
			...t,
		})),
	};
	saveState(state, join(dir, 'state.json'));
	return { dir, project, state };
}

/** Collect what's printed with console.log/error during the test. */
export function capture(t: TestContext): { out: () => string; err: () => string } {
	const out: string[] = [];
	const err: string[] = [];
	t.mock.method(console, 'log', (...args: unknown[]) => void out.push(args.join(' ')));
	t.mock.method(console, 'error', (...args: unknown[]) => void err.push(args.join(' ')));
	return { out: () => out.join('\n'), err: () => err.join('\n') };
}
