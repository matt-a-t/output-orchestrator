// The board's background polls: each keeps a bit of what's shown in step with the world outside.

import { readFileSync, unwatchFile, watchFile } from 'node:fs';
import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { isDirty, restoreChanges } from '../git.js';
import type { PrStatus } from '../github.js';
import { STATE_FILE, loadState, saveState, type State, type Thread } from '../state.js';
import { EVENTS_FILE, EventReader, fromThreadDir, nextStatus, type Status } from '../status.js';
import { noRepo, threadDir } from '../threads.js';
import { windowNames } from '../tmux.js';

type SetState = Dispatch<SetStateAction<State>>;

/**
 * The board's state, saved whenever it changes and reloaded when something else writes it, e.g.
 * `oo project add` from another shell. The ref is for callbacks that outlive a render (the polls).
 */
export function useStateFile() {
	const [state, setState] = useState<State>(loadState);
	const stateRef = useRef(state);
	stateRef.current = state;
	const lastWritten = useRef<string | null>(null);
	useEffect(() => {
		lastWritten.current = saveState(state);
	}, [state]);
	useEffect(() => {
		watchFile(STATE_FILE, { interval: 1000 }, () => {
			try {
				if (readFileSync(STATE_FILE, 'utf8') !== lastWritten.current) setState(loadState());
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
 */
export function useStatuses(stateRef: RefObject<State>, setState: SetState) {
	const [statuses, setStatuses] = useState<Record<string, Status>>({});
	const statusesRef = useRef(statuses);
	statusesRef.current = statuses;
	const sessionStarts = useRef(new Map<string, number>());
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
	return { statuses, statusesRef, sessionStarts: sessionStarts.current };
}

/** The open tmux windows; badges only mean something while the thread's window is open. */
export function useLiveWindows() {
	const [liveWindows, setLiveWindows] = useState<Set<string>>(new Set());
	const refreshWindows = () =>
		windowNames()
			.then(names => setLiveWindows(new Set(names)))
			.catch(() => {});
	useEffect(() => {
		refreshWindows();
		const timer = setInterval(refreshWindows, 2000);
		return () => clearInterval(timer);
	}, []);
	return { liveWindows, refreshWindows };
}

/** Threads with uncommitted changes, i.e. a step waiting to be reviewed and approved. */
export function useUnreviewed(stateRef: RefObject<State>) {
	const [unreviewed, setUnreviewed] = useState<Set<string>>(new Set());
	useEffect(() => {
		let checking = false;
		const check = async () => {
			if (checking) return;
			checking = true;
			try {
				const dirty = new Set<string>();
				const threads = stateRef.current.threads.filter(t => t.column !== 'archived' && !noRepo(stateRef.current, t));
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
	return unreviewed;
}

/** Keep open PRs' merge status current with `checkPr` (the latest render's), which also moves threads whose PR has merged to Done. */
export function usePrPoll(stateRef: RefObject<State>, setMerge: Dispatch<SetStateAction<Record<string, PrStatus>>>, checkPr: (thread: Thread) => Promise<void>) {
	const checkPrRef = useRef(checkPr);
	checkPrRef.current = checkPr;
	useEffect(() => {
		let polling = false;
		const poll = async () => {
			if (polling) return;
			polling = true;
			try {
				const threads = stateRef.current.threads;
				// Threads that left PR (by hand, or closed) no longer have a status worth showing.
				setMerge(m => Object.fromEntries(Object.entries(m).filter(([id]) => threads.some(t => t.id === id && t.column === 'pr' && t.pr))));
				for (const thread of threads) await checkPrRef.current(thread);
			} finally {
				polling = false;
			}
		};
		poll();
		const timer = setInterval(poll, 60_000);
		return () => clearInterval(timer);
	}, []);
}
