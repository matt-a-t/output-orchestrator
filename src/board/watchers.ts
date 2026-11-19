// The board's background polls: each keeps a bit of what's shown in step with the world outside.

import { unwatchFile, watchFile } from 'node:fs';
import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { tmuxSnapshot, type RunStatus } from '../commands.js';
import { isDirty, restoreChanges } from '../git.js';
import { prHost, type PrStatus } from '../prHost.js';
import { STATE_FILE, loadState, saveState, stillSaved, type Saved, type State, type Thread } from '../state.js';
import { EVENTS_FILE, EventReader, fromThreadDir, nextStatus, type Status } from '../status.js';
import { threadDir } from '../threads.js';
import { CHECK_CONCURRENCY, SWEEP_INTERVAL, eachLimited, settled, threadsToCheck } from './unreviewed.js';

type SetState = Dispatch<SetStateAction<State>>;

/**
 * The board's state, saved whenever it changes and reloaded when something else writes it, e.g.
 * `oo project add` from another shell. The ref is for callbacks that outlive a render (the polls).
 */
export function useStateFile() {
	const [state, setState] = useState<State>(loadState);
	const stateRef = useRef(state);
	stateRef.current = state;
	const saved = useRef<Saved | null>(null);
	useEffect(() => {
		saved.current = saveState(state);
	}, [state]);
	useEffect(() => {
		// watchFile stats the file; only a write by something else is worth reading the whole file for.
		watchFile(STATE_FILE, { interval: 1000 }, curr => {
			// A zeroed stat: the file's gone (mid-rename, or deleted), so there's nothing to load.
			if (curr.mtimeMs === 0 || stillSaved(saved.current, curr)) return;
			try {
				setState(loadState());
			} catch {}
		});
		return () => unwatchFile(STATE_FILE);
	}, []);
	return { state, setState, stateRef };
}

/** Undo the commit carrying a thread's uncommitted changes, if a move into or out of Local died before it could. */
export function useRestoreCarried(stateRef: RefObject<State>) {
	useEffect(() => {
		const { threads, projects } = stateRef.current;
		const dirs = new Set([...threads.filter(t => !t.cwd).map(t => threadDir(stateRef.current, t)), ...projects.map(p => p.path)]);
		for (const dir of dirs) if (dir) void restoreChanges(dir).catch(() => {});
	}, []);
}

/**
 * Fold claude hook events (see status.ts) into per-thread status and the latest claude session ID.
 * `sessionStarts` counts how many times each thread's claude has started this run, so waking can wait for the one it starts.
 * `statusSince` is when each thread's status last changed (ms), from the events' own times, so it holds across a board restart.
 */
export function useStatuses(stateRef: RefObject<State>, setState: SetState) {
	const [statuses, setStatuses] = useState<Record<string, Status>>({});
	const statusesRef = useRef(statuses);
	statusesRef.current = statuses;
	const sessionStarts = useRef(new Map<string, number>());
	const statusSince = useRef(new Map<string, number>());
	useEffect(() => {
		const reader = new EventReader();
		// Folded into here as they're read, rather than in a state update, so statusSince sees each change.
		const latest: Record<string, Status> = {};
		const poll = () => {
			const dirs = new Map(stateRef.current.threads.map(t => [t.id, threadDir(stateRef.current, t)]));
			const events = reader.read().filter(e => fromThreadDir(e, dirs.get(e.thread)));
			if (events.length === 0) return;
			let changed = false;
			for (const e of events) {
				const status = nextStatus(latest[e.thread], e);
				if (!status || status === latest[e.thread]) continue;
				latest[e.thread] = status;
				statusSince.current.set(e.thread, Date.parse(e.ts) || Date.now());
				changed = true;
			}
			// Most events (each tool call while working) change nothing, and a new object would redraw the board.
			if (changed) setStatuses({ ...latest });
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
	return { statuses, statusesRef, sessionStarts: sessionStarts.current, statusSince: statusSince.current };
}

/**
 * What the board polls tmux for, in one call every 2s: the open windows (badges only mean something
 * while the thread's window is open) and the project commands' run sessions (r) and how each is going,
 * for the run picker and the ► on cards.
 */
export function useTmux() {
	const [liveWindows, setLiveWindows] = useState<Set<string>>(new Set());
	const liveWindowsRef = useRef(liveWindows);
	liveWindowsRef.current = liveWindows;
	const runsRef = useRef(new Map<string, RunStatus>());
	// Cards read the runs from runsRef; this only redraws them when one of the runs changed.
	const [, setRunsKey] = useState('');
	const refresh = () =>
		tmuxSnapshot()
			.then(({ windows, runs }) => {
				runsRef.current = runs;
				setRunsKey(JSON.stringify([...runs]));
				setLiveWindows(prev => (prev.size === windows.length && windows.every(w => prev.has(w)) ? prev : new Set(windows)));
			})
			.catch(() => {});
	useEffect(() => {
		refresh();
		const timer = setInterval(refresh, 2000);
		return () => clearInterval(timer);
	}, []);
	return { liveWindows, liveWindowsRef, refreshWindows: refresh, runsRef, refreshRuns: refresh };
}

/**
 * Threads with uncommitted changes, i.e. a step waiting to be reviewed and approved. A thread is checked
 * when its claude stops working and after the board's own git actions on it (`recheck`). Every thread
 * whose files can change is also swept every SWEEP_INTERVAL, for edits made outside claude.
 */
export function useUnreviewed(stateRef: RefObject<State>, statuses: Record<string, Status>, liveWindowsRef: RefObject<Set<string>>) {
	const [unreviewed, setUnreviewed] = useState<Set<string>>(new Set());
	// What's waiting to be checked: some threads, or 'all' for a sweep. One check runs at a time.
	const pending = useRef<Set<string> | 'all'>(new Set());
	const running = useRef(false);
	const recheck = useRef(async (ids: string[] | 'all') => {
		if (ids === 'all') pending.current = 'all';
		else if (pending.current !== 'all') for (const id of ids) pending.current.add(id);
		if (running.current) return;
		running.current = true;
		try {
			while (pending.current === 'all' || pending.current.size > 0) {
				const want = pending.current;
				pending.current = new Set();
				const candidates = threadsToCheck(stateRef.current, liveWindowsRef.current);
				const ids = want === 'all' ? [...candidates.keys()] : [...want].filter(id => candidates.has(id));
				const dirty = new Map<string, boolean>();
				await eachLimited(ids, CHECK_CONCURRENCY, async id => void dirty.set(id, await isDirty(candidates.get(id)!).catch(() => false)));
				setUnreviewed(prev => {
					const next = new Set(prev);
					// Threads that can't change any more (Done, closed) drop their mark.
					for (const id of prev) if (!candidates.has(id)) next.delete(id);
					for (const [id, d] of dirty) d ? next.add(id) : next.delete(id);
					return next.size === prev.size && [...next].every(id => prev.has(id)) ? prev : next;
				});
			}
		} finally {
			running.current = false;
		}
	}).current;
	useEffect(() => {
		void recheck('all');
		const timer = setInterval(() => void recheck('all'), SWEEP_INTERVAL);
		return () => clearInterval(timer);
	}, []);
	const lastStatuses = useRef(statuses);
	useEffect(() => {
		const stopped = settled(lastStatuses.current, statuses);
		lastStatuses.current = statuses;
		if (stopped.length > 0) void recheck(stopped);
	}, [statuses]);
	return { unreviewed, recheckUnreviewed: (id: string) => void recheck([id]) };
}

/** Whether a PR last checked at `last` (ms, never if undefined) is due another check, allowing for the poll's own jitter. */
export const prPollDue = (last: number | undefined, now: number, every: number) => last === undefined || now - last >= every - PR_POLL / 2;

const PR_POLL = 60_000;

/** Keep open PRs' merge status current with `checkPr` (the latest render's), which also moves threads whose PR has merged to Done. */
export function usePrPoll(stateRef: RefObject<State>, setMerge: Dispatch<SetStateAction<Record<string, PrStatus>>>, checkPr: (thread: Thread) => Promise<void>) {
	const checkPrRef = useRef(checkPr);
	checkPrRef.current = checkPr;
	useEffect(() => {
		let polling = false;
		// When each thread's PR was last checked, for hosts that are checked less often than the poll runs.
		const lastPolled = new Map<string, number>();
		const poll = async () => {
			if (polling) return;
			polling = true;
			try {
				const { threads, projects } = stateRef.current;
				// Threads that left PR (by hand, or closed) no longer have a status worth showing.
				setMerge(m => Object.fromEntries(Object.entries(m).filter(([id]) => threads.some(t => t.id === id && t.column === 'pr' && t.pr))));
				for (const thread of threads) {
					const project = projects.find(p => p.name === thread.project);
					if (thread.column !== 'pr' || !thread.pr || !project) continue;
					const host = await prHost(project.path);
					if (!prPollDue(lastPolled.get(thread.id), Date.now(), host.pollEvery)) continue;
					lastPolled.set(thread.id, Date.now());
					await checkPrRef.current(thread);
				}
			} finally {
				polling = false;
			}
		};
		poll();
		const timer = setInterval(poll, PR_POLL);
		return () => clearInterval(timer);
	}, []);
}
