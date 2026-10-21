import { existsSync, readFileSync, watchFile, unwatchFile } from 'node:fs';
import { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { editThread } from './editor.js';
import { ensureWorktree, hasWorktree, isDirty, removeWorktree, worktreePath } from './git.js';
import { commitStep, openChanges, reviewDiff, showDiff } from './review.js';
import {
	COLORS,
	COLUMN_LABELS,
	COLUMNS,
	STATE_FILE,
	loadState,
	newThreadId,
	saveState,
	type Column,
	type Project,
	type State,
	type Thread,
} from './state.js';
import { CLAUDE_SETTINGS_FILE, EVENTS_FILE, EventReader, nextStatus, type Status } from './status.js';
import { killWindow, openWindow, pasteInto, threadWindowName, windowNames } from './tmux.js';

const BADGES: Partial<Record<Status, [string, string]>> = {
	working: ['⚙', 'yellow'],
	waiting: ['⏸', 'red'],
	stopped: ['✓', 'green'],
};

/** Session ID to resume, if the thread has one whose transcript still exists. */
function resumableSession(thread: Thread): string | undefined {
	if (thread.sessionId && thread.transcriptPath && existsSync(thread.transcriptPath)) return thread.sessionId;
}

const HELP =
	'h/l j/k move  H/L column  J/K reorder  n new  e edit  ⏎ open  d/D step/thread diff  c comment  a accept  o open changes  C colour  p filter  x archive  q quit';

export function App() {
	const { exit } = useApp();
	const { columns: width } = useWindowSize();
	const [state, setState] = useState<State>(loadState);
	const [cursor, setCursor] = useState({ col: 0, row: 0 });
	const [filter, setFilter] = useState<string | null>(null);
	const [message, setMessage] = useState('');
	const [busy, setBusy] = useState<string | null>(null);
	const lastWritten = useRef<string | null>(null);
	const [statuses, setStatuses] = useState<Record<string, Status>>({});
	const [liveWindows, setLiveWindows] = useState<Set<string>>(new Set());

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

	// Fold hook events (see status.ts) into per-thread status and the latest session ID.
	useEffect(() => {
		const reader = new EventReader();
		const poll = () => {
			const events = reader.read();
			if (events.length === 0) return;
			setStatuses(prev => {
				const next = { ...prev };
				for (const e of events) {
					const status = nextStatus(next[e.thread], e);
					if (status) next[e.thread] = status;
				}
				return next;
			});
			const sessions = new Map<string, { sessionId: string; transcriptPath?: string }>();
			for (const e of events) {
				if (e.event === 'SessionStart' && e.session) {
					sessions.set(e.thread, { sessionId: e.session, transcriptPath: e.transcript });
				}
			}
			if (sessions.size === 0) return;
			setState(s => {
				const changed = s.threads.some(t => {
					const session = sessions.get(t.id);
					return session && (session.sessionId !== t.sessionId || session.transcriptPath !== t.transcriptPath);
				});
				if (!changed) return s;
				return { ...s, threads: s.threads.map(t => ({ ...t, ...sessions.get(t.id) })) };
			});
		};
		poll();
		watchFile(EVENTS_FILE, { interval: 500 }, poll);
		return () => unwatchFile(EVENTS_FILE, poll);
	}, []);

	// Badges only mean something while the thread's window is open.
	useEffect(() => {
		refreshWindows();
		const timer = setInterval(refreshWindows, 2000);
		return () => clearInterval(timer);
	}, []);

	const projectByName = (name: string) => state.projects.find(p => p.name === name);
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

	const moveColumn = (thread: Thread, delta: number) => {
		const col = COLUMNS.indexOf(thread.column as (typeof COLUMNS)[number]) + delta;
		if (col < 0 || col >= COLUMNS.length) return;
		const column = COLUMNS[col]!;
		if (column === 'active') {
			const other = state.threads.find(t => t.column === 'active' && t.project === thread.project);
			if (other) setMessage(`⚠ ${thread.project} already has an active thread: #${other.id} ${other.title}`);
		}
		const moved = { ...thread, column, updatedAt: new Date().toISOString() };
		// Moving to the end of the array puts it at the bottom of the target column.
		setState(s => ({ ...s, threads: [...s.threads.filter(t => t.id !== thread.id), moved] }));
		setCursor({ col, row: columnThreads(column).length });
		run(() => syncWorktree(moved), 'updating worktree');
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

	/** Create the thread's worktree if it's missing; returns its path. */
	const createWorktree = async (project: Project, thread: Thread): Promise<string> => {
		const created = await ensureWorktree(project.path, thread);
		if (created) {
			// Earlier sessions ran in the main checkout, so `claude --resume` wouldn't find them from here.
			updateThread(thread.id, { ...created, sessionId: undefined, transcriptPath: undefined });
			setMessage(`Created worktree for #${thread.id} on ${created.branch}`);
		}
		return worktreePath(thread);
	};

	/** Keep the worktree in step with the column: there from Active on, removed (branch kept) once Done/archived. */
	const syncWorktree = async (thread: Thread) => {
		const project = projectByName(thread.project);
		if (!project) return setMessage(`✗ Unknown project "${thread.project}"`);
		if (thread.column === 'planned') return;
		if (thread.column !== 'done' && thread.column !== 'archived') return void (await createWorktree(project, thread));
		if (!hasWorktree(thread)) return;
		if (await isDirty(worktreePath(thread))) {
			return setMessage(`⚠ Kept #${thread.id}'s worktree: it has uncommitted changes`);
		}
		// claude can't carry on in a deleted directory.
		await killWindow(threadWindowName(thread.id));
		await removeWorktree(project.path, thread);
		await refreshWindows();
		setMessage(`Removed #${thread.id}'s worktree (kept branch ${thread.branch})`);
	};

	/** Run fn in the thread's worktree, if it has one. */
	const inWorktree = (thread: Thread, fn: (cwd: string) => Promise<void>) =>
		run(async () => {
			if (!hasWorktree(thread)) return setMessage(`#${thread.id} has no worktree — open it or move it out of Planned`);
			await fn(worktreePath(thread));
		});

	const newThread = () =>
		run(async () => {
			if (state.projects.length === 0) {
				setMessage('No projects yet — run: oo project add <path>');
				return;
			}
			const project = filter ?? selected?.project ?? state.projects[0]!.name;
			const draft = await editThread(
				{ project, title: '', plan: '' },
				state.projects.map(p => p.name),
			);
			if (!draft) return setMessage('Cancelled');
			if (!projectByName(draft.project)) return setMessage(`✗ Unknown project "${draft.project}"`);
			const now = new Date().toISOString();
			const thread: Thread = { id: newThreadId(state), ...draft, column: 'planned', createdAt: now, updatedAt: now };
			setState(s => ({ ...s, threads: [...s.threads, thread] }));
			setCursor({ col: 0, row: columnThreads('planned').length });
			setMessage(`Created #${thread.id}`);
		});

	const editSelected = (thread: Thread) =>
		run(async () => {
			const draft = await editThread(thread, state.projects.map(p => p.name));
			if (!draft) return setMessage('Cancelled');
			if (!projectByName(draft.project)) return setMessage(`✗ Unknown project "${draft.project}"`);
			updateThread(thread.id, draft);
		});

	const openThread = (thread: Thread) =>
		run(async () => {
			const project = projectByName(thread.project);
			if (!project) return setMessage(`✗ Unknown project "${thread.project}"`);
			const cwd = await createWorktree(project, thread);
			// No branch yet means the worktree was just created, so there's nothing to resume in it.
			const sessionId = thread.branch ? resumableSession(thread) : undefined;
			const command = ['claude', '--settings', CLAUDE_SETTINGS_FILE, ...(sessionId ? ['--resume', sessionId] : [])];
			const result = await openWindow(threadWindowName(thread.id), cwd, command, { OO_THREAD_ID: thread.id });
			await refreshWindows();
			if (result === 'selected') setMessage('');
			else setMessage(`${sessionId ? 'Resumed' : 'Started'} claude for #${thread.id}`);
		});

	useInput((input, key) => {
		if (busy) return;
		setMessage('');
		if (input === 'q') return exit();
		if (input === 'h' || key.leftArrow) return setCursor({ col: Math.max(0, cursor.col - 1), row });
		if (input === 'l' || key.rightArrow) return setCursor({ col: Math.min(COLUMNS.length - 1, cursor.col + 1), row });
		if (input === 'j' || key.downArrow) return setCursor({ col: cursor.col, row: Math.min(colThreads.length - 1, row + 1) });
		if (input === 'k' || key.upArrow) return setCursor({ col: cursor.col, row: Math.max(0, row - 1) });
		if (input === 'n') return newThread();
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
		if (input === 'e') return editSelected(selected);
		if (key.return) return openThread(selected);
		if (input === 'C') {
			const current = selected.color ?? projectByName(selected.project)?.color ?? COLORS[0];
			return updateThread(selected.id, { color: COLORS[(COLORS.indexOf(current) + 1) % COLORS.length] });
		}
		if (input === 'x') {
			updateThread(selected.id, { column: 'archived' });
			setMessage(`Archived #${selected.id}`);
			return run(() => syncWorktree({ ...selected, column: 'archived' }), 'updating worktree');
		}
		if (input === 'd' || input === 'D') {
			const kind = input === 'd' ? 'step' : 'thread';
			return inWorktree(selected, async cwd => {
				if (!(await showDiff(cwd, kind, selected))) setMessage(`No ${kind} changes`);
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
		if (input === 'o') {
			return inWorktree(selected, async cwd => {
				if (!(await openChanges(cwd, selected))) setMessage('No changes');
			});
		}
		if (input === 'a') {
			return inWorktree(selected, async cwd => {
				const result = await commitStep(cwd);
				setMessage(
					{
						nothing: 'Nothing to commit',
						committed: `Committed step on ${selected.branch}`,
						aborted: '⚠ Commit aborted (changes left staged)',
					}[result],
				);
			});
		}
	});

	const colWidth = Math.max(16, Math.floor(width / COLUMNS.length));

	return (
		<Box flexDirection="column">
			<Box justifyContent="space-between" width={width}>
				<Text bold>output-orchestrator</Text>
				<Text dimColor>filter: {filter ?? 'all'}</Text>
			</Box>
			<Box>
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
								: resumableSession(t)
									? ['↻', 'gray']
									: [' ', undefined];
							return (
								<Text key={t.id} wrap="truncate" inverse={isSelected}>
									<Text color={badgeColor}>{badge} </Text>
									<Text color={color}>{t.project}</Text>
									<Text dimColor> #{t.id} </Text>
									{t.title}
								</Text>
							);
						})}
					</Box>
				))}
			</Box>
			<Box marginTop={1} flexDirection="column">
				{selected?.plan ? (
					<Text dimColor wrap="truncate-end">
						{selected.plan.split('\n').slice(0, 3).join(' · ')}
					</Text>
				) : null}
				<Text color={message.startsWith('✗') ? 'red' : message.startsWith('⚠') ? 'yellow' : 'green'}>
					{busy ? `… ${busy}` : message}
				</Text>
				<Text dimColor>{HELP}</Text>
			</Box>
		</Box>
	);
}
