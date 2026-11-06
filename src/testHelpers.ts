import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { TestContext } from 'node:test';
import { execa } from 'execa';
import type { Board } from './board/board.js';
import type { PrStatus } from './github.js';
import { COLUMNS, saveState, type State, type Thread } from './state.js';
import { setColumn } from './threads.js';

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
		projects: [{ name: 'p', abbrev: '', path: project, worktrees: true, color: 'cyan', wakePrompt: '', closeIdleAfter: 30, hooks: {}, tracker: 'none', jiraSite: '', jiraProject: '' }],
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

// Tests stand in for gh with fakeGh. Should the real one be reached anyway, it has no login to act with.
process.env.GH_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'oo-gh-config-'));
for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete process.env[name];

/** A Board over `state` held in memory, recording what it says. Pass `overrides` for anything a test needs to see or steer. */
export function fakeBoard(state: State, overrides: Partial<Board> = {}): Board & { messages: string[]; merge: () => Record<string, PrStatus> } {
	let current = state;
	let merge: Record<string, PrStatus> = {};
	const messages: string[] = [];
	const setState: Board['setState'] = next => void (current = typeof next === 'function' ? next(current) : next);
	return {
		store: { get: () => current, update: fn => void (current = fn(current)) },
		state: () => current,
		setState,
		updateThread: (id, patch) => setState(s => ({ ...s, threads: s.threads.map(t => (t.id === id ? { ...t, ...patch } : t)) })),
		setColumn: (id, column, patch = {}) => setState(s => setColumn(s, id, column, patch)),
		project: name => current.projects.find(p => p.name === name),
		statuses: () => ({}),
		statusSince: new Map(),
		liveWindows: () => new Set(),
		sessionStarts: new Map(),
		refreshWindows: async () => {},
		setMerge: next => void (merge = typeof next === 'function' ? next(merge) : next),
		pendingLocal: new Map(),
		setMessage: message => void messages.push(message),
		setBusy: () => {},
		run: async fn => {
			try {
				await fn();
			} catch (err) {
				messages.push(`✗ ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		ask: question => void messages.push(question),
		shown: () => current.threads,
		shownColumns: () => COLUMNS,
		showAtEnd: () => {},
		...overrides,
		messages,
		merge: () => merge,
	};
}

/** Run git in `cwd`, with an identity so commits work anywhere. */
export const git = (cwd: string, ...args: string[]) => execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...args]);

/**
 * fixture(), with project "p" a git repo on main with one commit, pushed to a bare repo on disk as its
 * origin (`<dir>/origin.git`), so pushes and pulls work offline. Threads without a `worktree` get one
 * under `<dir>/worktrees`, so nothing lands in the real data dir.
 */
export async function gitFixture(threads: Partial<Thread>[] = []): Promise<{ dir: string; project: string; origin: string; state: State }> {
	const { dir, project, state } = fixture(threads);
	for (const t of state.threads) if (!t.cwd) t.worktree ??= join(dir, 'worktrees', t.id);
	const origin = join(dir, 'origin.git');
	await execa('git', ['init', '-q', '--bare', '-b', 'main', origin]);
	await execa('git', ['init', '-q', '-b', 'main', project]);
	writeFileSync(join(project, 'README'), 'hello\n');
	await git(project, 'add', 'README');
	await git(project, 'commit', '-q', '-m', 'init');
	await git(project, 'remote', 'add', 'origin', origin);
	await git(project, 'push', '-q', '-u', 'origin', 'main');
	return { dir, project, origin, state };
}

/** What the fake gh prints for a call whose arguments start with the key, e.g. `'pr view'`. */
export type GhAnswer = { stdout?: string; exitCode?: number };

/**
 * Put a fake gh first on PATH for this test. It answers calls whose arguments start with one of
 * `answers`' keys (the longest that matches) and fails any other, so it never hands off to the real gh.
 * `calls()` lists each call's arguments.
 */
export function fakeGh(t: TestContext, answers: Record<string, GhAnswer>): { calls: () => string[][] } {
	const bin = mkdtempSync(join(tmpdir(), 'oo-fake-gh-'));
	const log = join(bin, 'calls.jsonl');
	writeFileSync(join(bin, 'answers.json'), JSON.stringify(answers));
	const script = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const answers = JSON.parse(readFileSync(${JSON.stringify(join(bin, 'answers.json'))}, 'utf8'));
const line = args.join(' ');
const key = Object.keys(answers).filter(k => line === k || line.startsWith(k + ' ')).sort((a, b) => b.length - a.length)[0];
if (key === undefined) {
	process.stderr.write('fake gh: no answer for: ' + line + '\\n');
	process.exit(1);
}
process.stdout.write(answers[key].stdout ?? '');
process.exit(answers[key].exitCode ?? 0);
`;
	writeFileSync(join(bin, 'gh'), script, { mode: 0o755 });
	const path = process.env.PATH;
	process.env.PATH = `${bin}${delimiter}${path}`;
	t.after(() => void (process.env.PATH = path));
	return {
		calls: () =>
			existsSync(log)
				? readFileSync(log, 'utf8')
						.split('\n')
						.filter(Boolean)
						.map(l => JSON.parse(l) as string[])
				: [],
	};
}
