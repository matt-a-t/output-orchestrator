import { useEffect, useRef, useState } from 'react';
import { Box, Text, measureElement, useApp, useInput, useWindowSize, type DOMElement } from 'ink';
import type { PrStatus } from './github.js';
import { loop } from './input.js';
import { ProjectsView } from './projects.js';
import { ThreadView } from './thread.js';
import type { Board } from './board/board.js';
import { Card, cardHeight, cardLines, LIST_TOP, LOCAL_BORDER_LINES } from './board/card.js';
import { runBinding } from './board/bindings.js';
import { openThread, resumeId, stalled } from './board/claude.js';
import { useDoubleClick } from './board/doubleClick.js';
import { Footer } from './board/footer.js';
import { ImportList, ImportProject } from './board/importPicker.js';
import { KeysView } from './board/keysView.js';
import { usePendingLocal } from './board/local.js';
import { NewThread, useRecentTickets } from './board/newThread.js';
import { fetchReviews, ReviewList, type Review } from './board/reviewList.js';
import { checkPr } from './board/pr.js';
import { useRequests } from './board/requests.js';
import { useLiveWindows, usePrPoll, useRestoreCarried, useStateFile, useStatuses, useUnreviewed } from './board/watchers.js';
import { COLORS, COLUMN_LABELS, COLUMNS, type Column, type Project, type Thread } from './state.js';
import { listOutsideThreads, type OutsideThread } from './transcripts.js';
import { mouse, type MouseEvent } from './mouse.js';
import { setColumn as moveTo } from './threads.js';
import { threadWindowName } from './tmux.js';

export function App() {
	const { exit } = useApp();
	const { columns: width, rows: height } = useWindowSize();
	const { state, setState, stateRef } = useStateFile();
	const [cursor, setCursor] = useState({ col: 0, row: 0 });
	const [filter, setFilter] = useState<string | null>(null);
	const filterRef = useRef(filter);
	filterRef.current = filter;
	const [message, setMessage] = useState('');
	const [busy, setBusy] = useState<string | null>(null);
	// Asking which project to import from (i with no filter), over the bottom of the board.
	const [choosingImport, setChoosingImport] = useState(false);
	// The new-thread form (n), over the bottom of the board, opened on this project.
	const [newThreadIn, setNewThreadIn] = useState<Project | null>(null);
	const recent = useRecentTickets();
	const [showProjects, setShowProjects] = useState(false);
	const [showKeys, setShowKeys] = useState(false);
	// The thread form (e), replacing the board while it's open.
	const [editing, setEditing] = useState<string | null>(null);
	const { statuses, statusesRef, sessionStarts } = useStatuses(stateRef, setState);
	const { liveWindows, liveWindowsRef, refreshWindows } = useLiveWindows();
	const unreviewed = useUnreviewed(stateRef);
	useRestoreCarried(stateRef);
	const pendingLocal = useRef(new Map<string, boolean>());
	// The merge status of open PRs, from the PR poll; not saved, since the poll refills it on startup.
	const [merge, setMerge] = useState<Record<string, PrStatus>>({});
	// The import list (i), replacing the columns while it's open.
	const [picker, setPicker] = useState<{ project: string; threads: OutsideThread[] } | null>(null);
	// The review requests list (R), replacing the columns while it's open.
	const [reviews, setReviews] = useState<Review[] | null>(null);
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

	const projectByName = (name: string) => stateRef.current.projects.find(p => p.name === name);

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

	const board: Board = {
		store: {
			get: () => stateRef.current,
			update: fn => {
				stateRef.current = fn(stateRef.current);
				setState(fn);
			},
		},
		state: () => stateRef.current,
		setState,
		updateThread,
		setColumn,
		project: projectByName,
		statuses: () => statusesRef.current,
		liveWindows: () => liveWindowsRef.current,
		sessionStarts,
		refreshWindows,
		setMerge,
		pendingLocal: pendingLocal.current,
		setMessage,
		setBusy,
		run,
		ask,
		shown: () => stateRef.current.threads.filter(t => visible(t, filterRef.current)),
		showAtEnd: column =>
			setCursor({
				col: COLUMNS.indexOf(column as (typeof COLUMNS)[number]),
				row: stateRef.current.threads.filter(t => t.column === column && visible(t, filterRef.current)).length,
			}),
	};
	useRequests(board);
	usePendingLocal(board, statuses);
	usePrPoll(stateRef, setMerge, thread => checkPr(board, thread));

	/** Open the new-thread form on the filtered or highlighted project. */
	const newThread = () => {
		const project = projectByName(filter ?? selected?.project ?? '') ?? state.projects[0]!;
		setNewThreadIn(project);
		recent.loadRecent(project);
	};

	/** Import from the filtered project, asking which one when there's no filter (and more than one). */
	const startImport = () => {
		const filtered = filter ? projectByName(filter) : state.projects.length === 1 ? state.projects[0] : undefined;
		if (filtered) return openPicker(filtered);
		setChoosingImport(true);
	};

	const openPicker = (project: Project) =>
		run(async () => {
			const threads = await listOutsideThreads(project.path);
			if (threads.length === 0) return setMessage(`No claude threads to import in ${project.path}`);
			setPicker({ project: project.name, threads });
		}, 'looking for threads');

	const openReviews = () =>
		run(async () => {
			const requests = await fetchReviews(board);
			if (requests.length === 0) return setMessage(m => m || 'No PRs waiting for your review');
			setReviews(requests);
		}, 'looking for review requests');

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

	useInput((input, key) => {
		// The form, the import and review lists and the import prompt take their own keys.
		if (busy || showProjects || editing || newThreadIn || choosingImport || picker || reviews) return;
		setMessage('');
		if (showKeys) {
			if (input === '?' || input === 'q' || key.escape) setShowKeys(false);
			return;
		}
		if (confirm) {
			setConfirm(null);
			return input === 'y' ? confirm() : setMessage('Cancelled');
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
		if (input === 'P') return setShowProjects(true);
		if (input === 'R') return openReviews();
		if (input === '?') return setShowKeys(true);
		if (input === 'i') return startImport();
		if (input === 'p') {
			const names = [null, ...state.projects.map(p => p.name)];
			setFilter(names[(names.indexOf(filter) + 1) % names.length]!);
			return setCursor({ col: cursor.col, row: 0 });
		}
		if (runBinding(board, input, key, selected)) return;
		if (!selected) return;
		if (input === 'K') return reorder(selected, -1);
		if (input === 'J') return reorder(selected, 1);
		if (input === 'e') return setEditing(selected.id);
		if (input === 'C') {
			const current = selected.color ?? projectByName(selected.project)?.color ?? COLORS[0];
			return updateThread(selected.id, { color: COLORS[(COLORS.indexOf(current) + 1) % COLORS.length] });
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

	const isDoubleClick = useDoubleClick();

	// The layout is a fixed grid, so a press's cell says what it's on. The wheel stops at the ends rather than looping.
	const onMouse = ({ button, x, y }: MouseEvent) => {
		if (busy || showProjects || showKeys || editing || newThreadIn || choosingImport || picker || reviews || confirm) return;
		setMessage('');
		const wheel = button === 'wheelDown' ? 1 : button === 'wheelUp' ? -1 : 0;
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
		if (isDoubleClick(thread.id)) openThread(board, thread);
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
			) : showKeys ? (
				<KeysView />
			) : reviews ? (
				<ReviewList board={board} requests={reviews} active={!busy} onClose={() => setReviews(null)} />
			) : picker ? (
				<ImportList
					board={board}
					project={picker.project}
					threads={picker.threads}
					active={!busy}
					onClose={() => setPicker(null)}
					onShow={showThread}
				/>
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
								{threads.slice(start, end).map((t, i) => (
									<Card
										key={t.id}
										thread={t}
										selected={c === cursor.col && start + i === row}
										project={projectByName(t.project)}
										live={liveWindows.has(threadWindowName(t.id))}
										status={statuses[t.id]}
										resumable={!!resumeId(t)}
										stalled={stalled(board, t)}
										unreviewed={unreviewed.has(t.id)}
										merge={merge[t.id]}
									/>
								))}
								{end < threads.length ? <Text dimColor>  ↓ {threads.length - end} more</Text> : null}
							</Box>
						);
					})}
				</Box>
			)}
			<Footer
				// About the highlighted card, so not while the import or review list covers the board.
				thread={picker || reviews ? undefined : selected}
				merge={selected && merge[selected.id]}
				busy={busy}
				message={message}
				confirming={!!confirm}
				width={width}
				hidden={showProjects || showKeys || !!editing}
			>
				{choosingImport ? <ImportProject board={board} active={!busy} onPick={openPicker} onClose={() => setChoosingImport(false)} /> : null}
				{newThreadIn ? <NewThread board={board} project={newThreadIn} recent={recent} active={!busy} onClose={() => setNewThreadIn(null)} /> : null}
			</Footer>
		</Box>
	);
}
