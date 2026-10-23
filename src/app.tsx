import { existsSync, readFileSync, watchFile, unwatchFile } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { useEffect, useRef, useState } from 'react';
import { Box, Text, measureElement, useApp, useInput, useWindowSize, type DOMElement, type Key } from 'ink';
import { commitText, EDITOR, parseCommit, parsePr, prText } from './editor.js';
import { runColumnHook, tryHook } from './hooks.js';
import { checkout, currentRef, defaultBranch, hasWorktree, isDirty, commit, pushBranch, removeWorktree, stageAll, worktreePath } from './git.js';
import { createPr, draftPr, findPr, openPrInBrowser, prState } from './github.js';
import { editText, loop } from './input.js';
import { KEY_SECTIONS } from './keys.js';
import { ProjectsView } from './projects.js';
import { RequestReader, requestsFile, respond, type Request, type Response } from './requests.js';
import { diffPaneCommand, draftCommit, openChanges, reviewDiff, showDiff } from './review.js';
import { ThreadView } from './thread.js';
import { approvedPrompt } from './threadCommand.js';
import {
	COLORS,
	COLUMN_LABELS,
	COLUMNS,
	DEFAULT_WAKE_PROMPT,
	STATE_FILE,
	TODO_MARKS,
	loadState,
	saveState,
	type Column,
	type Project,
	type ProjectHook,
	type State,
	type Thread,
	type Todo,
	type TodoStatus,
} from './state.js';
import { copyTranscript, listOutsideThreads, recentlyActive, timeAgo, type OutsideThread } from './transcripts.js';
import { mouse, type MouseEvent } from './mouse.js';
import { CLAUDE_SETTINGS_FILE, EVENTS_FILE, EventReader, fromThreadDir, nextStatus, type Status } from './status.js';
import {
	addThread,
	applyRequest,
	archiveProblem,
	doneProblem,
	createWorktree as worktreeFor,
	moveWarning,
	setColumn as moveTo,
	syncWorktree as syncWorktreeFor,
	approvedTodo,
	setTodoStatus,
	threadDir,
	todoProgress,
	todoWindow,
	type Store,
	type WorktreeChange,
} from './threads.js';
import { CLOSED, killWindow, openSplit, openWindow, pasteInto, progressPopup, threadWindowLabel, threadWindowName, windowNames } from './tmux.js';

type PermissionMode = 'plan' | 'auto';
type LocalOutcome = { ok: boolean; message: string };
type LocalMoves = {
	enterLocal: (thread: Thread) => Promise<LocalOutcome>;
	leaveLocal: (thread: Thread) => Promise<LocalOutcome>;
	localProblem: (thread: Thread, entering: boolean) => Promise<string | undefined>;
};

const BADGES: Partial<Record<Status, [string, string]>> = {
	working: ['⚙', 'yellow'],
	waiting: ['⏸', 'red'],
	stopped: ['✓', 'green'],
};

/** Claude session ID to resume the thread with, if its transcript still exists. */
function resumeId(thread: Thread): string | undefined {
	if (thread.sessionId && thread.transcriptPath && existsSync(thread.transcriptPath)) return thread.sessionId;
}

const LEGEND: [string, string | undefined, string][] = [
	['⚙', 'yellow', 'working'],
	['⏸', 'red', 'needs you'],
	['✓', 'green', 'stopped'],
	['○', 'gray', 'open, no activity yet'],
	['↻', 'gray', 'closed, resumable'],
	['↻', 'red', 'closed mid-work, w wakes it'],
	['±', 'magenta', 'changes to review'],
];

/** The `n` flow (pick a project, then type the title), or picking the project to import from (`i` with no filter). */
type Prompt = { step: 'project'; index: number; then: 'new' | 'import' } | { step: 'title'; project: string; title: string };

// The columns and the import list start below the title bar, a header and a rule; each card is two lines, or one in Done.
const LIST_TOP = 3;
const CARD_HEIGHT = 2;
const cardHeight = (column: Column) => (column === 'done' ? 1 : CARD_HEIGHT);
// A thread in Local stays in its column, its card outlined in yellow, which takes a line above and below.
const LOCAL_BORDER_LINES = 2;
const cardLines = (t: Thread) => cardHeight(t.column) + (t.local ? LOCAL_BORDER_LINES : 0);
const DOUBLE_CLICK_MS = 400;
// The highlighted thread's todos shown below the board; the rest are summed up as "N more".
const MAX_TODO_LINES = 5;
const TODO_COLORS: Record<TodoStatus, string> = { pending: 'gray', active: 'yellow', review: 'magenta', done: 'green' };

const HELP = 'h/l j/k move  ⏎ open  n new  d diff  s/M-d shell/diff beside claude  q quit';

export function App() {
	const { exit } = useApp();
	const { columns: width, rows: height } = useWindowSize();
	const [state, setState] = useState<State>(loadState);
	// For callbacks that outlive a render (the PR poll).
	const stateRef = useRef(state);
	stateRef.current = state;
	const [cursor, setCursor] = useState({ col: 0, row: 0 });
	const [filter, setFilter] = useState<string | null>(null);
	const [message, setMessage] = useState('');
	const [busy, setBusy] = useState<string | null>(null);
	const [prompt, setPrompt] = useState<Prompt | null>(null);
	const [showProjects, setShowProjects] = useState(false);
	const [showKeys, setShowKeys] = useState(false);
	// The thread form (e), replacing the board while it's open.
	const [editing, setEditing] = useState<string | null>(null);
	const lastWritten = useRef<string | null>(null);
	const [statuses, setStatuses] = useState<Record<string, Status>>({});
	const statusesRef = useRef(statuses);
	statusesRef.current = statuses;
	// The latest render's Local moves, for the request poll, whose effect only sees the first render's.
	const localMoves = useRef<LocalMoves>(null!);
	// `oo thread local` moves waiting for the thread's claude to finish its turn: thread id → entering.
	const pendingLocal = useRef(new Map<string, boolean>());
	// How many times each thread's claude has started this run, so waking can wait for the one it starts.
	const sessionStarts = useRef(new Map<string, number>());
	const [liveWindows, setLiveWindows] = useState<Set<string>>(new Set());
	// Threads with uncommitted changes, i.e. a step waiting to be reviewed and approved.
	const [unreviewed, setUnreviewed] = useState<Set<string>>(new Set());
	// The import list (i), replacing the columns while it's open.
	const [picker, setPicker] = useState<{ project: string; threads: OutsideThread[]; row: number } | null>(null);
	// An action waiting on y (any other key cancels); its question is shown as the message.
	const [confirm, setConfirm] = useState<(() => void) | null>(null);
	const ask = (question: string, action: () => void) => {
		setConfirm(() => action);
		setMessage(`${question} y to confirm`);
	};
	// Lines the columns get, measured after layout (0 until then); taller columns scroll.
	const boardRef = useRef<DOMElement>(null);
	const [boardHeight, setBoardHeight] = useState(0);
	const scrollOffsets = useRef<Partial<Record<Column, number>>>({});

	const refreshWindows = () =>
		windowNames()
			.then(names => setLiveWindows(new Set(names)))
			.catch(() => {});

	useEffect(() => {
		lastWritten.current = saveState(state);
	}, [state]);

	// Pick up external changes, e.g. `oo project add` from another shell.
	useEffect(() => {
		watchFile(STATE_FILE, { interval: 1000 }, () => {
			try {
				if (readFileSync(STATE_FILE, 'utf8') !== lastWritten.current) setState(loadState());
			} catch {}
		});
		return () => unwatchFile(STATE_FILE);
	}, []);

	// Fold hook events (see status.ts) into per-thread status and the latest claude session ID.
	useEffect(() => {
		const reader = new EventReader();
		const poll = () => {
			const dirs = new Map(stateRef.current.threads.map(t => [t.id, threadDir(stateRef.current, t)]));
			const events = reader.read().filter(e => fromThreadDir(e, dirs.get(e.thread)));
			if (events.length === 0) return;
			setStatuses(prev => {
				const next = { ...prev };
				for (const e of events) {
					const status = nextStatus(next[e.thread], e);
					if (status) next[e.thread] = status;
				}
				return next;
			});
			const started = new Map<string, { sessionId: string; transcriptPath?: string }>();
			for (const e of events) {
				if (e.event === 'SessionStart') sessionStarts.current.set(e.thread, (sessionStarts.current.get(e.thread) ?? 0) + 1);
				if (e.event === 'SessionStart' && e.session) {
					started.set(e.thread, { sessionId: e.session, transcriptPath: e.transcript });
				}
			}
			if (started.size === 0) return;
			setState(s => {
				const changed = s.threads.some(t => {
					const latest = started.get(t.id);
					return latest && (latest.sessionId !== t.sessionId || latest.transcriptPath !== t.transcriptPath);
				});
				if (!changed) return s;
				return { ...s, threads: s.threads.map(t => ({ ...t, ...started.get(t.id) })) };
			});
		};
		poll();
		watchFile(EVENTS_FILE, { interval: 500 }, poll);
		return () => unwatchFile(EVENTS_FILE, poll);
	}, []);

	// Apply `oo thread …` requests (see requests.ts), one at a time.
	useEffect(() => {
		const reader = new RequestReader();
		const store: Store = {
			get: () => stateRef.current,
			// The ref is updated now rather than on the next render, so a request queued right behind sees this one.
			update: fn => {
				stateRef.current = fn(stateRef.current);
				setState(fn);
			},
		};
		// Like t, except that it waits for the thread's claude instead of refusing: it's often the one asking.
		const localRequest = async ({ id, thread: threadId, local }: Extract<Request, { op: 'local' }>): Promise<Response> => {
			const thread = stateRef.current.threads.find(t => t.id === threadId);
			if (!thread) return { id, ok: false, message: `No thread #${threadId}` };
			const answer = (outcome: LocalOutcome): Response => ({ id, ...outcome, thread: thread.id });
			const entering = local === 'toggle' ? !thread.local : local;
			if (entering === !!thread.local) return answer({ ok: true, message: `#${thread.id} is already ${entering ? 'in' : 'out of'} Local` });
			const moves = localMoves.current;
			const problem = await moves.localProblem(thread, entering);
			if (problem) return answer({ ok: false, message: problem });
			if (!thread.cwd && statusesRef.current[thread.id] === 'working') {
				pendingLocal.current.set(thread.id, entering);
				const where = entering ? 'goes into Local' : 'comes out of Local, back to its worktree,';
				return answer({ ok: true, message: `#${thread.id} ${where} when its claude's turn ends` });
			}
			setBusy(entering ? 'checking out for Local' : 'leaving Local');
			try {
				return answer(await (entering ? moves.enterLocal : moves.leaveLocal)(thread));
			} finally {
				setBusy(null);
			}
		};
		let queue = Promise.resolve();
		const poll = () => {
			for (const request of reader.read()) {
				queue = queue.then(async () => {
					const response = await (request.op === 'local' ? localRequest(request) : applyRequest(store, request)).catch(err => ({
						id: request.id,
						ok: false,
						message: err instanceof Error ? err.message : String(err),
					}));
					respond(response);
					setMessage(`${response.ok ? '' : '✗ '}oo thread: ${response.message.replaceAll('\n', ' · ')}`);
					await refreshWindows();
				});
			}
		};
		poll();
		watchFile(requestsFile(), { interval: 500 }, poll);
		return () => unwatchFile(requestsFile(), poll);
	}, []);

	// Badges only mean something while the thread's window is open.
	useEffect(() => {
		refreshWindows();
		const timer = setInterval(refreshWindows, 2000);
		return () => clearInterval(timer);
	}, []);

	const projectByName = (name: string) => stateRef.current.projects.find(p => p.name === name);

	useEffect(() => {
		let checking = false;
		const check = async () => {
			if (checking) return;
			checking = true;
			try {
				const dirty = new Set<string>();
				const threads = stateRef.current.threads.filter(t => t.column !== 'archived');
				await Promise.all(
					threads.map(async t => {
						const dir = threadDir(stateRef.current, t);
						if (dir && (await isDirty(dir).catch(() => false))) dirty.add(t.id);
					}),
				);
				setUnreviewed(prev => (prev.size === dirty.size && [...dirty].every(id => prev.has(id)) ? prev : dirty));
			} finally {
				checking = false;
			}
		};
		check();
		const timer = setInterval(check, 3000);
		return () => clearInterval(timer);
	}, []);
	const visible = (t: Thread, f = filter) => t.column !== 'archived' && (!f || t.project === f);
	const columnThreads = (column: Column, f = filter) => state.threads.filter(t => t.column === column && visible(t, f));

	const colThreads = columnThreads(COLUMNS[cursor.col]!);
	const row = Math.min(cursor.row, Math.max(0, colThreads.length - 1));
	const selected: Thread | undefined = colThreads[row];

	const updateThread = (id: string, patch: Partial<Thread>) =>
		setState(s => ({
			...s,
			threads: s.threads.map(t => (t.id === id ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t)),
		}));

	/** Move the thread to the bottom of the column. */
	const setColumn = (id: string, column: Column, patch: Partial<Thread> = {}) => setState(s => moveTo(s, id, column, patch));

	const moveColumn = (thread: Thread, delta: number) => {
		const col = COLUMNS.indexOf(thread.column as (typeof COLUMNS)[number]) + delta;
		if (col < 0 || col >= COLUMNS.length) return;
		moveThread(thread, COLUMNS[col]!);
	};

	const moveThread = (thread: Thread, column: (typeof COLUMNS)[number]) => {
		if (thread.column === column) return;
		const col = COLUMNS.indexOf(column);
		// Its branch is checked out in the project's checkout, not its worktree, until it comes back.
		if (thread.local) return setMessage(`⚠ #${thread.id} is in Local — t brings it back to the board first`);
		// Its claude is in plan mode just while it's Planned (see launchClaude), so an open one restarts on the way in or out.
		const restart = (thread.column === 'planned') !== (column === 'planned') && liveWindows.has(threadWindowName(thread.id));
		if (restart && statuses[thread.id] === 'working') return setMessage(`⚠ claude is still working on #${thread.id}`);
		const warning = moveWarning(state, thread, column);
		if (warning) setMessage(warning);
		// Done closes its claude window.
		if (column === 'done' && statuses[thread.id] === 'working') return setMessage(`⚠ claude is still working on #${thread.id}`);
		if (column === 'pr') return void run(() => openPr(thread), 'opening PR');
		const move = async () => {
			setColumn(thread.id, column);
			setCursor({ col, row: columnThreads(column).length });
			await syncWorktree({ ...thread, column }, thread.column);
			if (restart) await restartClaude({ ...thread, column }, column === 'planned' ? 'plan' : 'auto');
		};
		const project = projectByName(thread.project);
		if (column !== 'done' || !thread.pr || !project) return void run(move, 'updating worktree');
		run(async () => {
			const problem = await doneProblem(project, thread);
			if (problem) return setMessage(problem);
			await move();
		}, 'checking PR');
	};

	const reorder = (thread: Thread, delta: number) => {
		const neighbour = colThreads[row + delta];
		if (!neighbour) return;
		setState(s => {
			const threads = [...s.threads];
			const a = threads.findIndex(t => t.id === thread.id);
			const b = threads.findIndex(t => t.id === neighbour.id);
			[threads[a], threads[b]] = [threads[b]!, threads[a]!];
			return { ...s, threads };
		});
		setCursor({ col: cursor.col, row: row + delta });
	};

	const run = async (fn: () => Promise<void>, label = 'waiting for popup') => {
		setBusy(label);
		try {
			await fn();
		} catch (err) {
			setMessage(`✗ ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusy(null);
		}
	};

	const applyChange = (thread: Thread, { patch, message }: WorktreeChange) => {
		if (patch) updateThread(thread.id, patch);
		if (message) setMessage(message);
	};

	/** Create the thread's worktree if it's missing; returns its path. */
	const createWorktree = async (project: Project, thread: Thread): Promise<string> => {
		const change = await worktreeFor(project, thread);
		applyChange(thread, change);
		return change.path;
	};

	/** Keep the worktree in step with the column (see threads.ts), then run the project's hook for leaving `from`, if any. */
	const syncWorktree = async (thread: Thread, from?: Column) => {
		const project = projectByName(thread.project);
		if (!project) return setMessage(`✗ Unknown project "${thread.project}"`);
		const change = await syncWorktreeFor(project, thread);
		const ran = from && (await runColumnHook(project, from, { ...thread, ...change.patch }));
		applyChange(thread, { ...change, message: [change.message, ran].filter(Boolean).join('; ') || undefined });
		await refreshWindows();
	};

	/** Close the thread's claude window, if it's open; returns whether it was. */
	const closeClaude = async (thread: Thread): Promise<boolean> => {
		const open = (await windowNames()).includes(threadWindowName(thread.id));
		await killWindow(threadWindowName(thread.id));
		await refreshWindows();
		return open;
	};

	/** Close the thread's claude and resume it in the background in `mode`. */
	const restartClaude = async (thread: Thread, mode: PermissionMode) => {
		const cwd = threadDir(stateRef.current, thread);
		if (!cwd || !(await closeClaude(thread))) return;
		await launchClaude(thread, cwd, { background: true, mode });
		setMessage(`Restarted claude for #${thread.id} in ${mode} mode`);
	};

	/** Copy the thread's transcript to where `claude --resume` looks from `cwd`. */
	const moveTranscript = (thread: Thread, cwd: string): Pick<Thread, 'transcriptPath'> => {
		const transcriptPath = thread.transcriptPath && copyTranscript(thread.transcriptPath, cwd);
		return transcriptPath ? { transcriptPath } : {};
	};

	/** Run the project's hook; returns `done` with how it went. A hook that can't start doesn't undo the move. */
	const hook = async (project: Project, event: ProjectHook, thread: Thread, cwd: string, done: string): Promise<string> => {
		const ran = await tryHook(project, event, thread, cwd);
		return ran ? `${done}; ${ran}` : done;
	};

	/**
	 * Why the thread can't go into (`entering`) or come out of Local now, if it can't; shared by t and
	 * `oo thread local`. Claude still working is checked separately, since the command waits for it instead.
	 */
	const localProblem = async (thread: Thread, entering: boolean): Promise<string | undefined> => {
		const project = projectByName(thread.project);
		if (!project) return `Unknown project "${thread.project}"`;
		if (entering) {
			const other = stateRef.current.threads.find(t => t.local && t.project === thread.project);
			if (other) return `${thread.project} already has #${other.id} ${other.title} in Local`;
			if (thread.column === 'done') return `#${thread.id} is done — move it back to Polish first`;
		}
		// Imported threads already run in their own directory, with no branch to move.
		if (thread.cwd) return;
		if (entering) {
			if (!thread.branch) return `#${thread.id} has no branch yet — open it first`;
			if (hasWorktree(thread) && (await isDirty(worktreePath(thread)))) {
				return `#${thread.id} has uncommitted changes — approve them (d, then a) or discard them first`;
			}
			// Untracked files there are yours and get in the way only if the branch has them too, which checkout catches.
			if (await isDirty(project.path, { untracked: false })) return `${project.path} has uncommitted changes — commit or stash them first`;
		} else if (await isDirty(project.path)) {
			// Including untracked files: anything new there is the thread's work.
			return `#${thread.id} has uncommitted changes — approve them (d, then a) or discard them first`;
		}
	};

	/**
	 * Check the thread's branch out in the project's own checkout, so changes show up in the local
	 * dev environment, and move claude there with it, then run the project's enter local hook.
	 * The worktree is removed meanwhile. Only one thread per project fits.
	 */
	const enterLocal = async (thread: Thread): Promise<LocalOutcome> => {
		const problem = await localProblem(thread, true);
		if (problem) return { ok: false, message: problem };
		const project = projectByName(thread.project)!;
		if (thread.cwd) {
			updateThread(thread.id, { local: true });
			return { ok: true, message: await hook(project, 'enterLocal', thread, thread.cwd, `#${thread.id} is in Local`) };
		}
		if (statuses[thread.id] === 'working') return { ok: false, message: `claude is still working on #${thread.id}` };
		const wasOpen = await closeClaude(thread);
		if (hasWorktree(thread)) await removeWorktree(project.path, thread);
		await checkout(project.path, thread.branch!);
		const moved: Thread = { ...thread, local: true, ...moveTranscript(thread, project.path) };
		updateThread(thread.id, moved);
		if (wasOpen) await launchClaude(moved, project.path, { background: true });
		const done = `${project.name} checkout is on ${thread.branch}; claude works there until it leaves Local`;
		return { ok: true, message: await hook(project, 'enterLocal', moved, project.path, done) };
	};

	/**
	 * Put the project's checkout back on the default branch and move the thread back into its
	 * worktree, then run the project's leave local hook.
	 */
	const leaveLocal = async (thread: Thread): Promise<LocalOutcome> => {
		const problem = await localProblem(thread, false);
		if (problem) return { ok: false, message: problem };
		const project = projectByName(thread.project)!;
		if (thread.cwd) {
			updateThread(thread.id, { local: undefined });
			return { ok: true, message: await hook(project, 'leaveLocal', thread, project.path, `#${thread.id} is out of Local`) };
		}
		if (statuses[thread.id] === 'working') return { ok: false, message: `claude is still working on #${thread.id}` };
		const main = (await defaultBranch(project.path)) ?? 'main';
		const wasOpen = await closeClaude(thread);
		await checkout(project.path, main);
		const back: Thread = { ...thread, local: undefined };
		const cwd = await createWorktree(project, back);
		Object.assign(back, moveTranscript(thread, cwd));
		updateThread(thread.id, back);
		if (wasOpen) await launchClaude(back, cwd, { background: true });
		const done = `${project.name} checkout is back on ${main}; #${thread.id} is back in its worktree`;
		return { ok: true, message: await hook(project, 'leaveLocal', back, project.path, done) };
	};

	/** Into or out of Local, saying how it went on the message line. */
	const moveLocal = (thread: Thread, entering: boolean) =>
		run(async () => {
			const { ok, message } = await (entering ? enterLocal : leaveLocal)(thread);
			setMessage(ok ? message : `⚠ ${message}`);
		}, entering ? 'checking out for Local' : 'leaving Local');
	localMoves.current = { enterLocal, leaveLocal, localProblem };

	// Moves asked for while the thread's claude was working run once its turn ends (a permission prompt is still mid-turn).
	useEffect(() => {
		for (const [id, entering] of pendingLocal.current) {
			if (statuses[id] === 'working' || statuses[id] === 'waiting') continue;
			pendingLocal.current.delete(id);
			const thread = stateRef.current.threads.find(t => t.id === id);
			if (thread && entering !== !!thread.local) void moveLocal(thread, entering);
		}
	}, [statuses]);

	/** Push the thread's branch and open its PR (unless it has one already), then move it to PR. */
	const openPr = async (thread: Thread) => {
		const project = projectByName(thread.project);
		if (!project) return setMessage(`✗ Unknown project "${thread.project}"`);
		if (thread.cwd) {
			if (!existsSync(thread.cwd)) return setMessage(`✗ ${thread.cwd} no longer exists`);
			// An imported thread has no branch of its own until now: it's whatever its directory is on.
			if (!thread.branch) {
				const branch = await currentRef(thread.cwd);
				const base = await defaultBranch(thread.cwd);
				if (/^[0-9a-f]{40}$/.test(branch) || branch === base) {
					return setMessage(`⚠ ${thread.cwd} is on ${branch} — switch #${thread.id}'s work onto a branch there first`);
				}
				thread = { ...thread, branch, base };
			}
		}
		if (!thread.branch) return setMessage(`#${thread.id} has no branch yet — open it first`);
		// This reopens the worktree if the thread is coming back from Done.
		const cwd = thread.cwd ?? (await createWorktree(project, thread));
		if (await isDirty(cwd)) return setMessage(`⚠ #${thread.id} has uncommitted changes — approve them (d, then a) or discard them first`);
		// Open from here until the PR is, so the board isn't left looking usable while it waits.
		const progress = progressPopup(' pull request ', EDITOR);
		let existing: Thread['pr'];
		let pr: Thread['pr'];
		try {
			progress.status('looking for a PR');
			existing = pr = thread.pr ?? (await findPr(cwd, thread.branch));
			if (!pr) {
				// The PR goes into the default branch (see createPr), so describe the changes against that.
				const target = await defaultBranch(cwd);
				const base = target ? `origin/${target}` : (thread.base ?? 'HEAD');
				const written = await progress.cancellable('claude is writing the PR description', signal => draftPr(cwd, thread, base, signal));
				if (written === CLOSED) return setMessage('Cancelled');
				const edited = await progress.edit(
					written
						? prText(written, thread.branch)
						: prText({ title: thread.title, body: thread.plan }, thread.branch, "claude couldn't write the PR description; this is from the thread."),
				);
				const draft = edited === CLOSED ? null : parsePr(edited);
				if (!draft) return setMessage('Cancelled');
				progress.status(`pushing ${thread.branch}`);
				await pushBranch(cwd, thread.branch);
				progress.status('opening PR');
				pr = await createPr(cwd, thread, draft.title, draft.body);
			} else {
				progress.status(`pushing ${thread.branch}`);
				await pushBranch(cwd, thread.branch);
			}
		} finally {
			await progress.close();
		}
		const patch = { pr, branch: thread.branch, base: thread.base };
		setColumn(thread.id, 'pr', patch);
		setCursor({ col: COLUMNS.indexOf('pr'), row: columnThreads('pr').length });
		const opened = `${existing ? 'Pushed' : 'Opened'} PR #${pr.number}: ${pr.url}`;
		const ran = await runColumnHook(project, thread.column, { ...thread, ...patch, column: 'pr' });
		setMessage(ran ? `${opened}; ${ran}` : opened);
	};

	// Move threads whose PR has merged to Done (which also cleans up the worktree).
	useEffect(() => {
		let polling = false;
		const poll = async () => {
			if (polling) return;
			polling = true;
			try {
				for (const thread of stateRef.current.threads) {
					const project = projectByName(thread.project);
					if (thread.column !== 'pr' || !thread.pr || !project) continue;
					// gh failing (offline, logged out) just means trying again next time.
					if ((await prState(project.path, thread.pr).catch(() => undefined)) !== 'MERGED') continue;
					setColumn(thread.id, 'done');
					setMessage(`#${thread.id}'s PR #${thread.pr.number} merged → Done`);
					await syncWorktree({ ...thread, column: 'done' }).catch(err =>
						setMessage(`✗ ${err instanceof Error ? err.message : String(err)}`),
					);
				}
			} finally {
				polling = false;
			}
		};
		poll();
		const timer = setInterval(poll, 60_000);
		return () => clearInterval(timer);
	}, []);

	/** Run fn in the thread's worktree (or an imported thread's directory), if it has one. */
	const inWorktree = (thread: Thread, fn: (cwd: string) => Promise<void>) =>
		run(async () => {
			const dir = threadDir(stateRef.current, thread);
			if (dir) return await fn(dir);
			if (thread.local) return setMessage(`✗ Unknown project "${thread.project}"`);
			setMessage(`#${thread.id} has no worktree — open it or move it out of Planned`);
		});

	const newThread = () => {
		if (state.projects.length === 0) return setMessage('No projects yet — run: oo project add <path>');
		// One project means nothing to choose.
		if (state.projects.length === 1) return setPrompt({ step: 'title', project: state.projects[0]!.name, title: '' });
		const current = filter ?? selected?.project;
		setPrompt({ step: 'project', index: Math.max(0, state.projects.findIndex(p => p.name === current)), then: 'new' });
	};

	const createThread = (project: string, title: string) => {
		const { thread } = addThread(state, { project, title });
		setState(s => ({ ...s, threads: [...s.threads, thread] }));
		setCursor({ col: 0, row: columnThreads('planned').length });
		setMessage(`Created #${thread.id} — e to add a plan`);
	};

	/**
	 * Approve the step: stage everything in `cwd`, have claude draft the message, and commit it once
	 * it's edited. A claude stopped for the review is then told to move on.
	 */
	const approveStep = async (cwd: string, thread: Thread) => {
		if (!(await stageAll(cwd))) return setMessage('Nothing to commit');
		const window = threadWindowName(thread.id);
		// Not one that's working or waiting on a question, where the paste would land as an answer.
		const waiting = statusesRef.current[thread.id] === 'stopped' && (await windowNames()).includes(window);
		let message: string | null;
		const progress = progressPopup(' commit ', EDITOR);
		try {
			const drafted = await progress.cancellable('claude is writing the commit message', signal => draftCommit(cwd, thread, signal));
			const edited =
				drafted === CLOSED
					? CLOSED
					: await progress.edit(drafted ? commitText(drafted) : commitText('', "claude couldn't write a commit message; write one."));
			message = edited === CLOSED ? null : parseCommit(edited);
			if (!message) return setMessage('⚠ Commit cancelled (changes left staged)');
			progress.status('committing');
			await commit(cwd, message);
		} finally {
			await progress.close();
		}
		// Approving the step is what ticks off the checkpoint claude handed over.
		const todos = stateRef.current.threads.find(t => t.id === thread.id)?.todos ?? [];
		const item = approvedTodo(todos);
		const ticked = item === -1 ? todos : setTodoStatus(todos, item, 'done');
		if (item !== -1) updateThread(thread.id, { todos: ticked });
		const told = waiting && (await windowNames()).includes(window);
		if (told) await pasteInto(window, approvedPrompt(ticked, item, message.split('\n')[0]!));
		setMessage(`Committed step on ${thread.branch ?? cwd}${item === -1 ? '' : ` · ✓ ${todos[item]!.subject}`}${told ? ' · told claude' : ''}`);
	};

	const promptInput = (prompt: Prompt, input: string, key: Key) => {
		if (key.escape) {
			setPrompt(null);
			return setMessage('Cancelled');
		}
		if (prompt.step === 'project') {
			const count = state.projects.length;
			if (input === 'j' || key.downArrow) return setPrompt({ ...prompt, index: (prompt.index + 1) % count });
			if (input === 'k' || key.upArrow) return setPrompt({ ...prompt, index: (prompt.index + count - 1) % count });
			if (key.return) {
				const project = state.projects[prompt.index]!;
				if (prompt.then === 'import') {
					setPrompt(null);
					return openPicker(project);
				}
				return setPrompt({ step: 'title', project: project.name, title: '' });
			}
			return;
		}
		if (key.return) {
			const title = prompt.title.trim();
			if (!title) return;
			setPrompt(null);
			return createThread(prompt.project, title);
		}
		const title = editText(prompt.title, input, key);
		if (title !== undefined) setPrompt({ ...prompt, title });
	};

	/**
	 * Jump to the thread's claude window, starting claude in `cwd` (resuming the thread if it can) if needed.
	 * `background` starts it without leaving the board; `resumeAnyway` skips the check for it being open elsewhere.
	 * A thread in Planned is for planning only, so its claude starts in plan mode unless `mode` says otherwise.
	 */
	const launchClaude = async (
		thread: Thread,
		cwd: string,
		{ background = false, resumeAnyway = false, mode = thread.column === 'planned' ? 'plan' : undefined }: { background?: boolean; resumeAnyway?: boolean; mode?: PermissionMode } = {},
	) => {
		// No branch yet means the worktree was just created, so there's nothing to resume in it.
		const sessionId = thread.branch || thread.cwd ? resumeId(thread) : undefined;
		const window = threadWindowName(thread.id);
		// A thread the board hasn't heard from this run but that was written to just now is
		// probably still open in another terminal; two claudes on one thread would clash.
		if (
			sessionId &&
			!liveWindows.has(window) &&
			statuses[thread.id] === undefined &&
			recentlyActive(thread.transcriptPath!) &&
			!resumeAnyway
		) {
			return ask(`⚠ #${thread.id} was active elsewhere in the last few minutes — close it there first, or resume anyway?`, () =>
				run(() => launchClaude(thread, cwd, { background, mode, resumeAnyway: true })),
			);
		}
		const command = [
			'claude',
			'--settings',
			CLAUDE_SETTINGS_FILE,
			...(sessionId ? ['--resume', sessionId] : []),
			...(mode ? ['--permission-mode', mode] : []),
		];
		const result = await openWindow(window, threadWindowLabel(thread), cwd, command, { OO_THREAD_ID: thread.id }, { background });
		await refreshWindows();
		if (result === 'selected') setMessage('');
		else setMessage(`${sessionId ? 'Resumed' : 'Started'} claude for #${thread.id}`);
	};

	const openThread = (thread: Thread) =>
		run(async () => {
			const project = projectByName(thread.project);
			if (!project) return setMessage(`✗ Unknown project "${thread.project}"`);
			const cwd = thread.cwd ?? (thread.local ? project.path : await createWorktree(project, thread));
			await launchClaude(thread, cwd);
		});

	/**
	 * Closed while claude was still working, e.g. its window was killed. Still working with no window
	 * covers a claude killed too hard to report SessionEnd.
	 */
	const stalled = (thread: Thread) =>
		!liveWindows.has(threadWindowName(thread.id)) && (statuses[thread.id] === 'interrupted' || statuses[thread.id] === 'working');

	/** Resume the thread's claude in the background if it's closed, then tell it to keep going; returns whether it did. */
	const wakeThread = async (thread: Thread): Promise<boolean> => {
		const project = projectByName(thread.project);
		if (!project) {
			setMessage(`✗ Unknown project "${thread.project}"`);
			return false;
		}
		const cwd = thread.cwd ?? (thread.local ? project.path : await createWorktree(project, thread));
		const window = threadWindowName(thread.id);
		if (!(await windowNames()).includes(window)) {
			const starts = sessionStarts.current.get(thread.id) ?? 0;
			await launchClaude(thread, cwd, { background: true });
			// It may be waiting on "resume anyway?" instead.
			if (!(await windowNames()).includes(window)) return false;
			const deadline = Date.now() + 30_000;
			while ((sessionStarts.current.get(thread.id) ?? 0) === starts) {
				if (Date.now() > deadline) {
					setMessage(`✗ #${thread.id}'s claude didn't start in time; not woken`);
					return false;
				}
				await sleep(250);
			}
			// SessionStart comes a little before the prompt takes input.
			await sleep(1000);
		}
		await pasteInto(window, project.wakePrompt || DEFAULT_WAKE_PROMPT);
		setMessage(`Woke #${thread.id}`);
		return true;
	};

	/** Open claude with a shell or a live diff beside it, starting claude first if it isn't running. */
	const openBeside = (thread: Thread, role: 'shell' | 'diff') =>
		inWorktree(thread, async cwd => {
			const window = threadWindowName(thread.id);
			if (!(await windowNames()).includes(window)) {
				await launchClaude(thread, cwd, { background: true });
				// It may be waiting on "resume anyway?" instead.
				if (!(await windowNames()).includes(window)) return;
			}
			const command = role === 'shell' ? [process.env.SHELL || 'bash'] : await diffPaneCommand(cwd, thread);
			await openSplit(window, cwd, role, command, { OO_THREAD_ID: thread.id });
		});

	/** Import from the filtered project, asking which one when there's no filter (and more than one). */
	const startImport = () => {
		if (state.projects.length === 0) return setMessage('No projects yet — run: oo project add <path>');
		const filtered = filter ? projectByName(filter) : state.projects.length === 1 ? state.projects[0] : undefined;
		if (filtered) return openPicker(filtered);
		setPrompt({ step: 'project', index: 0, then: 'import' });
	};

	const openPicker = (project: Project) =>
		run(async () => {
			const threads = await listOutsideThreads(project.path);
			if (threads.length === 0) return setMessage(`No claude threads to import in ${project.path}`);
			setPicker({ project: project.name, threads, row: 0 });
		}, 'looking for threads');

	const linkedThread = (outside: OutsideThread) => state.threads.find(t => t.sessionId === outside.id);

	/** Where the thread is shown with `f` as the filter: its column, and its row there. */
	const positionOf = (thread: Thread, f: string | null) => {
		const col = COLUMNS.indexOf(thread.column as (typeof COLUMNS)[number]);
		return { col, row: columnThreads(thread.column, f).indexOf(thread) };
	};

	/** Jump to the column/row a thread is shown at, clearing the filter if it hides it. */
	const showThread = (thread: Thread) => {
		if (thread.column === 'archived') return false;
		const shown = filter && filter !== thread.project ? null : filter;
		setFilter(shown);
		setCursor(positionOf(thread, shown));
		return true;
	};

	const importThread = (project: string, outside: OutsideThread) => {
		setPicker(null);
		const linked = linkedThread(outside);
		if (linked) {
			if (!showThread(linked)) setMessage(`That thread is already imported as archived #${linked.id}`);
			return;
		}
		const { thread } = addThread(state, {
			title: outside.title,
			plan: outside.title === outside.firstPrompt ? '' : outside.firstPrompt,
			project,
			sessionId: outside.id,
			transcriptPath: outside.transcriptPath,
			cwd: outside.cwd,
		});
		setState(s => ({ ...s, threads: [...s.threads, thread] }));
		setCursor({ col: 0, row: columnThreads('planned').length });
		setMessage(
			recentlyActive(outside.transcriptPath)
				? `⚠ Imported #${thread.id}, but it looks active elsewhere — close it there before ⏎`
				: `Imported #${thread.id} — ⏎ resumes it`,
		);
	};

	useInput((input, key) => {
		if (busy || showProjects || editing) return;
		setMessage('');
		if (showKeys) {
			if (input === '?' || input === 'q' || key.escape) setShowKeys(false);
			return;
		}
		if (confirm) {
			setConfirm(null);
			return input === 'y' ? confirm() : setMessage('Cancelled');
		}
		if (prompt) return promptInput(prompt, input, key);
		if (picker) {
			const count = picker.threads.length;
			if (input === 'q' || input === 'i' || key.escape) return setPicker(null);
			if (input === 'j' || key.downArrow) return setPicker({ ...picker, row: loop(picker.row, 1, count) });
			if (input === 'k' || key.upArrow) return setPicker({ ...picker, row: loop(picker.row, -1, count) });
			if (key.return) return importThread(picker.project, picker.threads[picker.row]!);
			return;
		}
		if (input === 'q') return ask('Quit?', exit);
		if (key.escape && filter) {
			setFilter(null);
			// Stay on the same thread now that the rest of its column is back.
			if (selected) setCursor(positionOf(selected, null));
			return;
		}
		if (input === 'h' || key.leftArrow) return setCursor({ col: loop(cursor.col, -1, COLUMNS.length), row });
		if (input === 'l' || key.rightArrow) return setCursor({ col: loop(cursor.col, 1, COLUMNS.length), row });
		if (input === 'j' || key.downArrow) return setCursor({ col: cursor.col, row: loop(row, 1, colThreads.length) });
		if (input === 'k' || key.upArrow) return setCursor({ col: cursor.col, row: loop(row, -1, colThreads.length) });
		if (input === 'n') return newThread();
		if (input === 'W') {
			const woken = state.threads.filter(t => visible(t) && t.column !== 'done' && stalled(t));
			if (woken.length === 0) return setMessage('No interrupted threads');
			const ids = (threads: Thread[]) => threads.map(t => `#${t.id}`).join(', ');
			return ask(`Wake ${ids(woken)}?`, async () => {
				const failed: Thread[] = [];
				// One at a time, as each waits for its claude to start.
				for (const t of woken) await run(async () => void ((await wakeThread(t)) || failed.push(t)), `waking #${t.id}`);
				if (woken.length > 1) setMessage(failed.length ? `⚠ Woke all but ${ids(failed)}` : `Woke ${ids(woken)}`);
			});
		}
		if (input === 'P') return setShowProjects(true);
		if (input === '?') return setShowKeys(true);
		if (input === 'i') return startImport();
		if (input === 'p') {
			const names = [null, ...state.projects.map(p => p.name)];
			setFilter(names[(names.indexOf(filter) + 1) % names.length]!);
			return setCursor({ col: cursor.col, row: 0 });
		}
		if (!selected) return;
		if (input === 'H') return moveColumn(selected, -1);
		if (input === 'L') return moveColumn(selected, 1);
		if (input === 'F' && selected.column !== 'done') {
			// Imported threads keep their directory and window.
			const closes = selected.cwd ? '' : ' It closes its claude window and removes its worktree (branch kept).';
			return ask(`Move #${selected.id} ${selected.title} to Done?${closes}`, () => moveThread(selected, 'done'));
		}
		if (input === 'K') return reorder(selected, -1);
		if (input === 'J') return reorder(selected, 1);
		if (input === 't') {
			pendingLocal.current.delete(selected.id);
			return moveLocal(selected, !selected.local);
		}
		if (input === 'e') return setEditing(selected.id);
		if (key.return) return openThread(selected);
		if (input === 'w') {
			if (statuses[selected.id] === 'working' && !stalled(selected)) return setMessage(`⚠ claude is still working on #${selected.id}`);
			return run(async () => void (await wakeThread(selected)), `waking #${selected.id}`);
		}
		if (input === 'C') {
			const current = selected.color ?? projectByName(selected.project)?.color ?? COLORS[0];
			return updateThread(selected.id, { color: COLORS[(COLORS.indexOf(current) + 1) % COLORS.length] });
		}
		if (input === 'x') {
			return run(async () => {
				const problem = await archiveProblem(selected);
				if (problem) return setMessage(problem);
				ask(`Archive #${selected.id}?`, () =>
					run(async () => {
						updateThread(selected.id, { column: 'archived' });
						setMessage(`Archived #${selected.id}`);
						await syncWorktree({ ...selected, column: 'archived' }, selected.column);
					}, 'archiving'),
				);
			}, 'checking for uncommitted changes');
		}
		if (key.meta && (input === 'd' || input === 'D')) return openBeside(selected, 'diff');
		if (input === 'd' || input === 'D') {
			const kind = input === 'd' ? 'step' : 'thread';
			return inWorktree(selected, async cwd => {
				const result = await showDiff(cwd, kind, selected);
				if (result === 'empty') setMessage(`No ${kind} changes`);
				if (result === 'approved') await approveStep(cwd, selected);
			});
		}
		if (input === 's') return openBeside(selected, 'shell');
		if (input === 'c') {
			return inWorktree(selected, async cwd => {
				const window = threadWindowName(selected.id);
				// Checked first so notes aren't written only to be thrown away.
				if (!(await windowNames()).includes(window)) return setMessage(`#${selected.id} has no claude window — open it with ⏎ first`);
				const feedback = await reviewDiff(cwd, selected);
				if (feedback === null) return setMessage('No changes');
				if (!feedback) return setMessage('No comments');
				if (!(await windowNames()).includes(window)) return setMessage(`✗ #${selected.id}'s claude window closed; comments not sent`);
				await pasteInto(window, feedback);
				setMessage(`Sent comments to #${selected.id}`);
			});
		}
		if (input === 'b') {
			const { pr } = selected;
			if (!pr) return setMessage(`#${selected.id} has no PR`);
			return run(async () => {
				await openPrInBrowser(pr);
				setMessage(`Opened PR #${pr.number} in the browser`);
			}, 'opening PR in the browser');
		}
		if (input === 'o') {
			return inWorktree(selected, async cwd => {
				if (!(await openChanges(cwd, selected))) setMessage('No changes');
			});
		}
	});

	useEffect(() => {
		if (!boardRef.current) return;
		const measured = measureElement(boardRef.current).height;
		if (measured !== boardHeight) setBoardHeight(measured);
	});

	/** The slice of a column's threads that fits, keeping the cursor in view; `top` is the lines its "more" line above takes. */
	const visibleSlice = (column: Column, threads: Thread[], cursorRow: number | undefined) => {
		const count = threads.length;
		// Room for the borders of the cards in Local, whether or not they're scrolled into view.
		const lines = boardHeight - (LIST_TOP - 1) - LOCAL_BORDER_LINES * threads.filter(t => t.local).length;
		const rowLines = cardHeight(column);
		if (boardHeight === 0 || count * rowLines <= lines) return { start: 0, end: count, top: 0 };
		// Room for the "more" lines above and below.
		const fits = Math.max(1, Math.floor((lines - 2) / rowLines));
		const last = count - fits;
		let start = scrollOffsets.current[column] ?? (column === 'done' ? last : 0);
		if (cursorRow !== undefined) start = Math.min(Math.max(start, cursorRow - fits + 1), cursorRow);
		// Unless you're in it, Done shows the latest arrivals, which land at the bottom.
		else if (column === 'done') start = last;
		start = Math.min(Math.max(0, start), last);
		scrollOffsets.current[column] = start;
		return { start, end: start + fits, top: start > 0 ? 1 : 0 };
	};
	const columnSlice = (c: number) => visibleSlice(COLUMNS[c]!, columnThreads(COLUMNS[c]!), c === cursor.col ? row : undefined);

	const colWidth = Math.max(16, Math.floor(width / COLUMNS.length));

	// The import list scrolls to keep the selected entry in view; it shows what fits in the space
	// measured after each render, starting at entry `pickerTop`.
	const pickerList = useRef<DOMElement>(null);
	const [pickerLines, setPickerLines] = useState(0);
	useEffect(() => {
		if (!pickerList.current) return;
		const lines = measureElement(pickerList.current).height;
		if (lines !== pickerLines) setPickerLines(lines);
	});
	const pickerTop = useRef(0);
	const entryHeight = (t: OutsideThread) => (t.title === t.firstPrompt ? 1 : 2);
	const pickerShown: OutsideThread[] = [];
	if (picker) {
		const { threads, row: selectedRow } = picker;
		const linesFrom = (from: number, to: number) => threads.slice(from, to + 1).reduce((n, t) => n + entryHeight(t), 0);
		pickerTop.current = Math.min(pickerTop.current, selectedRow);
		while (pickerTop.current < selectedRow && linesFrom(pickerTop.current, selectedRow) > pickerLines) pickerTop.current++;
		let lines = 0;
		for (const t of threads.slice(pickerTop.current)) {
			lines += entryHeight(t);
			if (lines > pickerLines) break;
			pickerShown.push(t);
		}
	} else pickerTop.current = 0;

	const lastClick = useRef<{ target: string; at: number } | null>(null);
	/** Whether this click is on the same thing as the last, soon enough to make a double-click. */
	const isDoubleClick = (target: string) => {
		const now = Date.now();
		const double = lastClick.current?.target === target && now - lastClick.current.at < DOUBLE_CLICK_MS;
		lastClick.current = double ? null : { target, at: now };
		return double;
	};

	/** The import list's entry at screen row `y`; an entry is one line, or two when it shows its first prompt. */
	const pickerRowAt = (y: number) => {
		let top = LIST_TOP;
		for (const [r, t] of pickerShown.entries()) {
			top += entryHeight(t);
			if (y < top) return pickerTop.current + r;
		}
	};

	// The layout is a fixed grid, so a press's cell says what it's on. The wheel stops at the ends rather than looping.
	const onMouse = ({ button, x, y }: MouseEvent) => {
		if (busy || showProjects || showKeys || editing || prompt || confirm) return;
		setMessage('');
		const wheel = button === 'wheelDown' ? 1 : button === 'wheelUp' ? -1 : 0;
		if (picker) {
			const last = picker.threads.length - 1;
			if (wheel) return setPicker(p => p && { ...p, row: Math.max(0, Math.min(last, p.row + wheel)) });
			const r = y >= LIST_TOP ? pickerRowAt(y) : undefined;
			if (button !== 'left' || r === undefined) return;
			setPicker(p => p && { ...p, row: r });
			if (isDoubleClick(picker.threads[r]!.id)) importThread(picker.project, picker.threads[r]!);
			return;
		}
		if (wheel) return setCursor({ col: cursor.col, row: Math.max(0, Math.min(colThreads.length - 1, row + wheel)) });
		const col = Math.floor(x / colWidth);
		if (button !== 'left' || y < 1 || col >= COLUMNS.length) return;
		const slice = columnSlice(col);
		let top = LIST_TOP + slice.top;
		// The column's header, or its "more" line.
		if (y < top) return setCursor({ col, row });
		// Cards in Local are taller, so count down through the ones shown.
		const threads = columnThreads(COLUMNS[col]!);
		let r = slice.start;
		for (; r < Math.min(slice.end, threads.length); r++) {
			top += cardLines(threads[r]!);
			if (y < top) break;
		}
		const thread = r < slice.end ? threads[r] : undefined;
		if (!thread) return;
		setCursor({ col, row: r });
		if (isDoubleClick(thread.id)) openThread(thread);
	};
	const onMouseRef = useRef(onMouse);
	onMouseRef.current = onMouse;
	useEffect(() => {
		const listener = (event: MouseEvent) => onMouseRef.current(event);
		mouse.on('press', listener);
		return () => void mouse.off('press', listener);
	}, []);

	/** A thread's two lines on the board (one in Done), outlined in yellow while it's in Local. */
	const card = (t: Thread, isSelected: boolean) => {
		const oneLine = cardHeight(t.column) === 1;
		const color = t.color ?? projectByName(t.project)?.color;
		const live = liveWindows.has(threadWindowName(t.id));
		// Changes aren't ready to review until claude stops working on them.
		const working = live && statuses[t.id] === 'working';
		const [badge, badgeColor] = live
			? (BADGES[statuses[t.id]!] ?? ['○', 'gray'])
			: resumeId(t)
				? ['↻', stalled(t) ? 'red' : 'gray']
				: [' ', undefined];
		return (
			<Box key={t.id} flexDirection="column" {...(t.local ? { borderStyle: 'round', borderColor: 'yellow' } : {})}>
				<Text wrap="truncate" inverse={isSelected}>
					<Text color={badgeColor}>{badge} </Text>
					<Text bold>#{t.id} </Text>
					<Text color={color}>{projectByName(t.project)?.abbrev || t.project}</Text>
					{unreviewed.has(t.id) && !working ? (
						<Text color="magenta" bold>
							{' '}±
						</Text>
					) : null}
					{/* Finished threads get one line each so more of them fit. */}
					{oneLine ? ` ${t.title}` : null}
				</Text>
				{oneLine ? null : (
					<Text wrap="truncate" inverse={isSelected}>
						{'  '}
						{t.title}
					</Text>
				)}
			</Box>
		);
	};

	/** The highlighted thread's progress through claude's task list, with the current step in view. */
	const todoList = (todos: Todo[]) => {
		const { start, end } = todoWindow(todos, MAX_TODO_LINES);
		// Step numbers are right-aligned so the subjects line up past step 9.
		const width = String(todos.length).length;
		const indent = ' '.repeat(width + 4);
		const more = (n: number, arrow: string) =>
			n > 0 ? (
				<Text dimColor>
					{indent}
					{arrow} {n} more
				</Text>
			) : null;
		return (
			<Box flexDirection="column">
				<Text>
					<Text bold>todo</Text> {todoProgress(todos)}
				</Text>
				{more(start, '↑')}
				{todos.slice(start, end).map((todo, i) => (
					<Text key={start + i} wrap="truncate">
						{'  '}
						<Text color={TODO_COLORS[todo.status]} dimColor={todo.status === 'done'}>
							{String(start + i + 1).padStart(width)}.
						</Text>{' '}
						<Text color={TODO_COLORS[todo.status]}>{TODO_MARKS[todo.status]}</Text>{' '}
						<Text bold={todo.status === 'active' || todo.status === 'review'} dimColor={todo.status === 'done'}>
							{todo.subject}
						</Text>
					</Text>
				))}
				{more(todos.length - end, '↓')}
			</Box>
		);
	};

	return (
		<Box flexDirection="column" height={height}>
			<Box justifyContent="space-between" width={width}>
				<Text bold>
					output-orchestrator{busy ? <Text color="cyan"> ● busy</Text> : null}
				</Text>
				<Text dimColor>filter: {filter ?? 'all'}</Text>
			</Box>
			{/* Grows to fill the window, which keeps the info below at the bottom. */}
			{showProjects ? (
				<ProjectsView state={state} setState={setState} onClose={() => setShowProjects(false)} />
			) : editing ? (
				<ThreadView
					key={editing}
					state={state}
					threadId={editing}
					updateThread={updateThread}
					onClose={closing => {
						setEditing(null);
						setMessage(closing);
					}}
				/>
			) : showKeys ? (
				<KeysView />
			) : picker ? (
				<Box flexGrow={1} overflow="hidden" flexDirection="column">
					<Text bold>
						Import a {picker.project} thread <Text dimColor>(j/k move  ⏎ import  esc/q/i cancel, or click, double-click, scroll)</Text>
					</Text>
					<Text dimColor>
						{'─'.repeat(Math.max(0, width - 13))} {String(picker.row + 1).padStart(4)} of {String(picker.threads.length).padEnd(3)}
					</Text>
					<Box ref={pickerList} flexGrow={1} flexBasis={0} flexDirection="column" overflow="hidden">
						{pickerShown.map((s, i) => {
							const r = pickerTop.current + i;
							const linked = linkedThread(s);
							const active = recentlyActive(s.transcriptPath);
							return (
								<Box key={s.id} flexDirection="column" flexShrink={0}>
									<Text wrap="truncate" inverse={r === picker.row}>
										<Text dimColor>{timeAgo(s.lastActivity).padEnd(9)}</Text>
										{linked ? <Text color="cyan">#{linked.id} </Text> : null}
										{active ? <Text color="yellow">● active </Text> : null}
										{s.title}
									</Text>
									{s.title !== s.firstPrompt ? (
										<Text wrap="truncate" dimColor>
											{'         '}
											{s.firstPrompt}
										</Text>
									) : null}
								</Box>
							);
						})}
					</Box>
				</Box>
			) : (
				<Box ref={boardRef} flexGrow={1} overflow="hidden">
					{COLUMNS.map((column, c) => {
						const threads = columnThreads(column);
						const { start, end } = columnSlice(c);
						return (
							<Box key={column} flexDirection="column" width={colWidth} paddingRight={1}>
								<Text bold color={c === cursor.col ? 'white' : 'gray'}>
									{COLUMN_LABELS[column]} ({threads.length})
								</Text>
								<Text dimColor>{'─'.repeat(colWidth - 1)}</Text>
								{start > 0 ? <Text dimColor>  ↑ {start} more</Text> : null}
								{threads.slice(start, end).map((t, i) => card(t, c === cursor.col && start + i === row))}
								{end < threads.length ? <Text dimColor>  ↓ {threads.length - end} more</Text> : null}
							</Box>
						);
					})}
				</Box>
			)}
			<Box marginTop={1} flexDirection="column" display={showProjects || showKeys || editing ? 'none' : 'flex'}>
				{/* About the highlighted card, so not while the import list covers the board. */}
				{selected?.plan && !picker ? (
					<Text dimColor wrap="truncate-end">
						{selected.plan.split('\n').slice(0, 3).join(' · ')}
					</Text>
				) : null}
				{selected?.todos?.length && !picker ? todoList(selected.todos) : null}
				{selected?.pr && !picker ? (
					<Text dimColor>
						PR #{selected.pr.number} {selected.pr.url} (b opens it)
					</Text>
				) : null}
				{prompt?.step === 'project' ? (
					<Box flexDirection="column">
						<Text bold>{prompt.then === 'import' ? 'Import' : 'New thread'} — project? (j/k move, ⏎ choose, esc cancel)</Text>
						{state.projects.map((p, i) => (
							<Text key={p.name} inverse={i === prompt.index}>
								{'  '}
								<Text color={p.color}>{p.name}</Text>
								<Text dimColor> {p.path}</Text>
							</Text>
						))}
					</Box>
				) : null}
				{prompt?.step === 'title' ? (
					<Text>
						<Text bold>New thread in </Text>
						<Text color={projectByName(prompt.project)?.color}>{prompt.project}</Text>
						<Text bold> — title: </Text>
						{prompt.title}
						<Text inverse> </Text>
						<Text dimColor>  (⏎ create, esc cancel)</Text>
					</Text>
				) : null}
				{busy ? (
					<Text color="cyan">{busy}…</Text>
				) : (
					<Text color={message.startsWith('✗') ? 'red' : confirm || message.startsWith('⚠') ? 'yellow' : 'green'}>{message}</Text>
				)}
				<Text>
					{LEGEND.map(([badge, color, label]) => (
						<Text key={label}>
							<Text color={color}>{badge}</Text>
							<Text dimColor> {label}   </Text>
						</Text>
					))}
				</Text>
				{/* The way into every other key, kept in the corner so it's always in the same place. */}
				<Box justifyContent="space-between" width={width}>
					<Text dimColor wrap="truncate-end">
						{HELP}
					</Text>
					<Box flexShrink={0} marginLeft={2}>
						<Text dimColor>? all keys</Text>
					</Box>
				</Box>
			</Box>
		</Box>
	);
}

/** The `?` screen: every key, a section per box, as many side by side as fit. */
function KeysView() {
	return (
		<Box flexGrow={1} overflow="hidden" flexDirection="column">
			<Text bold>
				Keys <Text dimColor>(? / q / esc close · also in KEYS.md)</Text>
			</Text>
			<Box flexWrap="wrap">
				{KEY_SECTIONS.map(section => {
					const keyWidth = Math.max(...section.keys.map(([k]) => k.length)) + 2;
					return (
						<Box key={section.title} flexDirection="column" width={48} marginTop={1} marginRight={2}>
							<Text bold color="cyan">
								{section.title}
							</Text>
							{section.keys.map(([k, what]) => (
								<Box key={k}>
									<Box width={keyWidth} flexShrink={0}>
										<Text>{k}</Text>
									</Box>
									<Text dimColor>{what}</Text>
								</Box>
							))}
						</Box>
					);
				})}
			</Box>
		</Box>
	);
}
