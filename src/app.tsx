import { existsSync, readFileSync, watchFile, unwatchFile } from 'node:fs';
import { useEffect, useRef, useState } from 'react';
import { Box, Text, measureElement, useApp, useInput, useWindowSize, type DOMElement, type Key } from 'ink';
import { editPr } from './editor.js';
import { checkout, currentRef, defaultBranch, hasWorktree, isDirty, commit, pushBranch, removeWorktree, stageAll, worktreePath } from './git.js';
import { createPr, draftPr, findPr, openPrInBrowser, prState } from './github.js';
import { editText, loop } from './input.js';
import { ProjectsView } from './projects.js';
import { RequestReader, requestsFile, respond } from './requests.js';
import { draftCommit, openChanges, reviewDiff, showDiff } from './review.js';
import { ThreadView } from './thread.js';
import {
	COLORS,
	COLUMN_LABELS,
	COLUMNS,
	STATE_FILE,
	loadState,
	saveState,
	type Column,
	type Project,
	type State,
	type Thread,
} from './state.js';
import { copyTranscript, listOutsideThreads, recentlyActive, timeAgo, type OutsideThread } from './transcripts.js';
import { mouse, type MouseEvent } from './mouse.js';
import { CLAUDE_SETTINGS_FILE, EVENTS_FILE, EventReader, fromThreadDir, nextStatus, type Status } from './status.js';
import {
	addThread,
	applyRequest,
	archiveProblem,
	createWorktree as worktreeFor,
	moveWarning,
	setColumn as moveTo,
	syncWorktree as syncWorktreeFor,
	threadDir,
	type Store,
	type WorktreeChange,
} from './threads.js';
import { killWindow, openWindow, pasteInto, threadWindowName, windowNames } from './tmux.js';

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
	['±', 'magenta', 'changes to review'],
];

/**
 * The `n` flow (pick a project, then type the title), picking the project to import from (`i`
 * with no filter), or approving a step from its diff: edit the
 * subject of the commit message claude drafted (its body is kept as is).
 */
type Prompt =
	| { step: 'project'; index: number; then: 'new' | 'import' }
	| { step: 'title'; project: string; title: string }
	| { step: 'commit'; thread: Thread; cwd: string; subject: string; body: string };

// The columns and the import list start below the title bar, a header and a rule; each card is two lines.
const LIST_TOP = 3;
const CARD_HEIGHT = 2;
const DOUBLE_CLICK_MS = 400;

const HELP =
	'h/l j/k move  H/L column  J/K reorder  n new  e edit  ⏎ open  d/D step/thread diff (a in a step diff approves)  c comment  o open changes  b open PR  i import thread  C colour  p filter  esc clear filter  P projects  x archive  q quit';

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
	// The thread form (e), replacing the board while it's open.
	const [editing, setEditing] = useState<string | null>(null);
	const lastWritten = useRef<string | null>(null);
	const [statuses, setStatuses] = useState<Record<string, Status>>({});
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
		let queue = Promise.resolve();
		const poll = () => {
			for (const request of reader.read()) {
				queue = queue.then(async () => {
					const response = await applyRequest(store, request).catch(err => ({
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
	const columnThreads = (column: Column) =>
		state.threads.filter(t => t.column === column && (!filter || t.project === filter));

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
		const column = COLUMNS[col]!;
		const warning = moveWarning(state, thread, column);
		if (warning) setMessage(warning);
		if (column === 'uitest') return void run(() => startUiTest(thread), 'checking out for UI testing');
		// From UI testing too: it only leaves once the PR is open.
		if (column === 'pr') return void run(() => openPr(thread), 'opening PR');
		if (thread.column === 'uitest') return void run(async () => void (await endUiTest(thread, column)), 'leaving UI testing');
		setColumn(thread.id, column);
		setCursor({ col, row: columnThreads(column).length });
		run(() => syncWorktree({ ...thread, column }), 'updating worktree');
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

	/** Keep the worktree in step with the column (see threads.ts). */
	const syncWorktree = async (thread: Thread) => {
		const project = projectByName(thread.project);
		if (!project) return setMessage(`✗ Unknown project "${thread.project}"`);
		applyChange(thread, await syncWorktreeFor(project, thread));
		await refreshWindows();
	};

	/** Close the thread's claude window, if it's open; returns whether it was. */
	const closeClaude = async (thread: Thread): Promise<boolean> => {
		const open = (await windowNames()).includes(threadWindowName(thread.id));
		await killWindow(threadWindowName(thread.id));
		await refreshWindows();
		return open;
	};

	/** Copy the thread's transcript to where `claude --resume` looks from `cwd`. */
	const moveTranscript = (thread: Thread, cwd: string): Pick<Thread, 'transcriptPath'> => {
		const transcriptPath = thread.transcriptPath && copyTranscript(thread.transcriptPath, cwd);
		return transcriptPath ? { transcriptPath } : {};
	};

	/**
	 * Check the thread's branch out in the project's own checkout, so changes show up in the
	 * local dev environment, and move claude there with it. The worktree is removed meanwhile.
	 */
	const startUiTest = async (thread: Thread) => {
		const project = projectByName(thread.project);
		if (!project) return setMessage(`✗ Unknown project "${thread.project}"`);
		const other = stateRef.current.threads.find(t => t.column === 'uitest' && t.project === thread.project);
		if (other) return setMessage(`✗ ${thread.project} is already UI testing #${other.id} ${other.title}`);
		// Imported threads already run in their own directory, with no branch to move.
		if (thread.cwd) {
			setColumn(thread.id, 'uitest');
			return setCursor({ col: COLUMNS.indexOf('uitest'), row: columnThreads('uitest').length });
		}
		if (!thread.branch) return setMessage(`#${thread.id} has no branch yet — open it first`);
		if (statuses[thread.id] === 'working') return setMessage(`⚠ claude is still working on #${thread.id}`);
		if (hasWorktree(thread) && (await isDirty(worktreePath(thread)))) {
			return setMessage(`⚠ #${thread.id} has uncommitted changes — approve them (d, then a) or discard them first`);
		}
		// Untracked files there are yours and get in the way only if the branch has them too, which checkout catches.
		if (await isDirty(project.path, { untracked: false })) {
			return setMessage(`⚠ ${project.path} has uncommitted changes — commit or stash them first`);
		}
		const restoreRef = await currentRef(project.path);
		const wasOpen = await closeClaude(thread);
		if (hasWorktree(thread)) await removeWorktree(project.path, thread);
		await checkout(project.path, thread.branch);
		const moved: Thread = { ...thread, column: 'uitest', restoreRef, ...moveTranscript(thread, project.path) };
		setColumn(thread.id, 'uitest', moved);
		setCursor({ col: COLUMNS.indexOf('uitest'), row: columnThreads('uitest').length });
		if (wasOpen) await launchClaude(moved, project.path, { background: true });
		setMessage(`${project.name} checkout is on ${thread.branch}; claude works there until it leaves UI testing`);
	};

	/**
	 * Put the project's checkout back on its previous branch and move the thread back into its worktree,
	 * in `column` with `patch` applied; returns whether it did.
	 */
	const endUiTest = async (thread: Thread, column: Column, patch: Partial<Thread> = {}): Promise<boolean> => {
		const fail = (message: string) => {
			setMessage(message);
			return false;
		};
		const project = projectByName(thread.project);
		if (!project) return fail(`✗ Unknown project "${thread.project}"`);
		const showAt = () => setCursor({ col: COLUMNS.indexOf(column as (typeof COLUMNS)[number]), row: columnThreads(column).length });
		if (thread.cwd) {
			setColumn(thread.id, column, patch);
			showAt();
			return true;
		}
		if (statuses[thread.id] === 'working') return fail(`⚠ claude is still working on #${thread.id}`);
		// Including untracked files: anything new there is the thread's work.
		if (await isDirty(project.path)) {
			return fail(`⚠ #${thread.id} has uncommitted changes — approve them (d, then a) or discard them first`);
		}
		const restoreRef = thread.restoreRef ?? thread.base;
		if (!restoreRef) return fail(`✗ Don't know what ${project.path} was on before #${thread.id}`);
		const wasOpen = await closeClaude(thread);
		await checkout(project.path, restoreRef);
		const back: Thread = { ...thread, ...patch, column, restoreRef: undefined };
		const cwd = await createWorktree(project, back);
		Object.assign(back, moveTranscript(thread, cwd));
		setColumn(thread.id, column, back);
		if (wasOpen) await launchClaude(back, cwd, { background: true });
		showAt();
		setMessage(`${project.name} checkout is back on ${restoreRef}`);
		return true;
	};

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
		const uiTesting = thread.column === 'uitest';
		if (uiTesting && statuses[thread.id] === 'working') return setMessage(`⚠ claude is still working on #${thread.id}`);
		// While UI testing the branch is checked out in the project itself; otherwise this reopens the worktree if the thread is coming back from Done.
		const cwd = thread.cwd ?? (uiTesting ? project.path : await createWorktree(project, thread));
		if (await isDirty(cwd)) return setMessage(`⚠ #${thread.id} has uncommitted changes — approve them (d, then a) or discard them first`);
		const existing = thread.pr ?? (await findPr(cwd, thread.branch));
		let pr = existing;
		if (pr) {
			await pushBranch(cwd, thread.branch);
		} else {
			setBusy('claude is writing the PR description');
			// The PR goes into the default branch (see createPr), so describe the changes against that.
			const target = await defaultBranch(cwd);
			const written = await draftPr(cwd, thread, target ? `origin/${target}` : (thread.base ?? 'HEAD'));
			if (!written) setMessage('⚠ claude couldn\'t write the PR description; starting from the thread');
			setBusy('opening PR');
			const draft = await editPr(written ?? { title: thread.title, body: thread.plan }, thread.branch);
			if (!draft) return setMessage('Cancelled');
			await pushBranch(cwd, thread.branch);
			pr = await createPr(cwd, thread, draft.title, draft.body);
		}
		const patch = { pr, branch: thread.branch, base: thread.base };
		const done = `${existing ? 'Pushed' : 'Opened'} PR #${pr.number}: ${pr.url}`;
		if (uiTesting) {
			// Recorded first, so if leaving UI testing fails, trying again finds the PR instead of opening another.
			updateThread(thread.id, patch);
			// It stays in UI testing until the PR exists, so a cancel leaves it where it was.
			if (await endUiTest({ ...thread, ...patch }, 'pr', patch)) setMessage(done);
			return;
		}
		setColumn(thread.id, 'pr', patch);
		setCursor({ col: COLUMNS.indexOf('pr'), row: columnThreads('pr').length });
		setMessage(done);
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
			if (thread.column === 'uitest') return setMessage(`✗ Unknown project "${thread.project}"`);
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

	/** Approve the step: stage everything in `cwd` and have claude draft the message to edit in the commit prompt. */
	const approveStep = async (cwd: string, thread: Thread) => {
		if (!(await stageAll(cwd))) return setMessage('Nothing to commit');
		setBusy('claude is writing the commit message');
		const message = await draftCommit(cwd, thread);
		if (!message) setMessage('⚠ claude couldn\'t write a commit message; type one');
		const [subject = '', ...body] = (message ?? '').split('\n');
		setPrompt({ step: 'commit', thread, cwd, subject, body: body.join('\n').trim() });
	};

	const promptInput = (prompt: Prompt, input: string, key: Key) => {
		if (key.escape) {
			setPrompt(null);
			return setMessage(prompt.step === 'commit' ? '⚠ Commit cancelled (changes left staged)' : 'Cancelled');
		}
		if (prompt.step === 'commit') {
			if (key.return) {
				const subject = prompt.subject.trim();
				if (!subject) return;
				setPrompt(null);
				return void run(async () => {
					await commit(prompt.cwd, prompt.body ? `${subject}\n\n${prompt.body}\n` : `${subject}\n`);
					setMessage(`Committed step on ${prompt.thread.branch ?? prompt.cwd}`);
				}, 'committing');
			}
			const subject = editText(prompt.subject, input, key);
			if (subject !== undefined) setPrompt({ ...prompt, subject });
			return;
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
	 */
	const launchClaude = async (thread: Thread, cwd: string, { background = false, resumeAnyway = false } = {}) => {
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
				run(() => launchClaude(thread, cwd, { resumeAnyway: true })),
			);
		}
		const command = ['claude', '--settings', CLAUDE_SETTINGS_FILE, ...(sessionId ? ['--resume', sessionId] : [])];
		const result = await openWindow(window, cwd, command, { OO_THREAD_ID: thread.id }, { background });
		await refreshWindows();
		if (result === 'selected') setMessage('');
		else setMessage(`${sessionId ? 'Resumed' : 'Started'} claude for #${thread.id}`);
	};

	const openThread = (thread: Thread) =>
		run(async () => {
			const project = projectByName(thread.project);
			if (!project) return setMessage(`✗ Unknown project "${thread.project}"`);
			const cwd = thread.cwd ?? (thread.column === 'uitest' ? project.path : await createWorktree(project, thread));
			await launchClaude(thread, cwd);
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

	/** Jump to the column/row a thread is shown at, clearing the filter if it hides it. */
	const showThread = (thread: Thread) => {
		const col = COLUMNS.indexOf(thread.column as (typeof COLUMNS)[number]);
		if (col < 0) return false;
		const visible = filter && filter !== thread.project ? null : filter;
		setFilter(visible);
		const rowIn = state.threads.filter(t => t.column === thread.column && (!visible || t.project === visible));
		setCursor({ col, row: rowIn.indexOf(thread) });
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
			if (selected) setCursor({ col: cursor.col, row: state.threads.filter(t => t.column === selected.column).indexOf(selected) });
			return;
		}
		if (input === 'h' || key.leftArrow) return setCursor({ col: loop(cursor.col, -1, COLUMNS.length), row });
		if (input === 'l' || key.rightArrow) return setCursor({ col: loop(cursor.col, 1, COLUMNS.length), row });
		if (input === 'j' || key.downArrow) return setCursor({ col: cursor.col, row: loop(row, 1, colThreads.length) });
		if (input === 'k' || key.upArrow) return setCursor({ col: cursor.col, row: loop(row, -1, colThreads.length) });
		if (input === 'n') return newThread();
		if (input === 'P') return setShowProjects(true);
		if (input === 'i') return startImport();
		if (input === 'p') {
			const names = [null, ...state.projects.map(p => p.name)];
			setFilter(names[(names.indexOf(filter) + 1) % names.length]!);
			return setCursor({ col: cursor.col, row: 0 });
		}
		if (!selected) return;
		if (input === 'H') return moveColumn(selected, -1);
		if (input === 'L') return moveColumn(selected, 1);
		if (input === 'K') return reorder(selected, -1);
		if (input === 'J') return reorder(selected, 1);
		if (input === 'e') return setEditing(selected.id);
		if (key.return) return openThread(selected);
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
						await syncWorktree({ ...selected, column: 'archived' });
						setMessage(`Archived #${selected.id}`);
					}, 'archiving'),
				);
			}, 'checking for uncommitted changes');
		}
		if (input === 'd' || input === 'D') {
			const kind = input === 'd' ? 'step' : 'thread';
			return inWorktree(selected, async cwd => {
				const result = await showDiff(cwd, kind, selected);
				if (result === 'empty') setMessage(`No ${kind} changes`);
				if (result === 'approved') await approveStep(cwd, selected);
			});
		}
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
		if (busy || showProjects || editing || prompt || confirm) return;
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
		// The column's header.
		if (y < LIST_TOP) return setCursor({ col, row });
		const r = Math.floor((y - LIST_TOP) / CARD_HEIGHT);
		const thread = columnThreads(COLUMNS[col]!)[r];
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
				<Box flexGrow={1} overflow="hidden">
					{COLUMNS.map((column, c) => (
						<Box key={column} flexDirection="column" width={colWidth} paddingRight={1}>
							<Text bold color={c === cursor.col ? 'white' : 'gray'}>
								{COLUMN_LABELS[column]} ({columnThreads(column).length})
							</Text>
							<Text dimColor>{'─'.repeat(colWidth - 1)}</Text>
							{columnThreads(column).map((t, r) => {
								const isSelected = c === cursor.col && r === row;
								const color = t.color ?? projectByName(t.project)?.color;
								const [badge, badgeColor] = liveWindows.has(threadWindowName(t.id))
									? (BADGES[statuses[t.id]!] ?? ['○', 'gray'])
									: resumeId(t)
										? ['↻', 'gray']
										: [' ', undefined];
								return (
									<Box key={t.id} flexDirection="column">
										<Text wrap="truncate" inverse={isSelected}>
											<Text color={badgeColor}>{badge} </Text>
											<Text bold>#{t.id} </Text>
											<Text color={color}>{projectByName(t.project)?.abbrev || t.project}</Text>
											{unreviewed.has(t.id) ? (
												<Text color="magenta" bold>
													{' '}±
												</Text>
											) : null}
										</Text>
										<Text wrap="truncate" inverse={isSelected}>
											{'  '}
											{t.title}
										</Text>
									</Box>
								);
							})}
						</Box>
					))}
				</Box>
			)}
			<Box marginTop={1} flexDirection="column" display={showProjects || editing ? 'none' : 'flex'}>
				{/* About the highlighted card, so not while the import list covers the board. */}
				{selected?.plan && !picker ? (
					<Text dimColor wrap="truncate-end">
						{selected.plan.split('\n').slice(0, 3).join(' · ')}
					</Text>
				) : null}
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
				{prompt?.step === 'commit' ? (
					<Box flexDirection="column">
						<Text>
							<Text bold>Commit #{prompt.thread.id}: </Text>
							{prompt.subject}
							<Text inverse> </Text>
							<Text dimColor>  (⏎ commit, esc cancel)</Text>
						</Text>
						{prompt.body ? (
							<Text dimColor wrap="truncate-end">
								{prompt.body.split('\n').filter(Boolean).slice(0, 3).join(' · ')}
							</Text>
						) : null}
					</Box>
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
				<Text dimColor>{HELP}</Text>
			</Box>
		</Box>
	);
}
