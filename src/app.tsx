import { useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import type { PrStatus } from './github.js';
import { loop } from './input.js';
import { ProjectsView } from './projects.js';
import { SearchBox, useSearch } from './search.js';
import { ThreadView } from './thread.js';
import type { Board } from './board/board.js';
import { runBinding } from './board/bindings.js';
import { Columns, newColumnsLayout } from './board/columns.js';
import { Footer } from './board/footer.js';
import { ImportList, ImportProject } from './board/importPicker.js';
import { KeysView } from './board/keysView.js';
import { usePendingLocal } from './board/local.js';
import { useMessageDelivery } from './board/messages.js';
import { NewThread, useRecentTickets } from './board/newThread.js';
import { fetchReviews, ReviewList, type Review } from './board/reviewList.js';
import { checkPr } from './board/pr.js';
import { useRequests } from './board/requests.js';
import { useLiveWindows, usePrPoll, useRestoreCarried, useStateFile, useStatuses, useUnreviewed } from './board/watchers.js';
import { COLORS, COLUMNS, type Column, type Project, type Thread } from './state.js';
import { listOutsideThreads, type OutsideThread } from './transcripts.js';
import { applyRequest, blockers, matchesSearch, setColumn as moveTo } from './threads.js';
import { closeOoWindows, ooWindows, threadWindowName } from './tmux.js';

export function App() {
	const { exit } = useApp();
	const { columns: width, rows: height } = useWindowSize();
	const { state, setState, stateRef } = useStateFile();
	const [cursor, setCursor] = useState({ col: 0, row: 0 });
	const [filter, setFilter] = useState<string | null>(null);
	const filterRef = useRef(filter);
	filterRef.current = filter;
	// Narrows the board along with the project filter; the highlighted thread stays highlighted while it still matches.
	const search = useSearch(query =>
		setCursor(selected && matchesSearch(selected, query) ? positionOf(selected, filter, query) : { col: cursor.col, row: 0 }),
	);
	const searchRef = useRef(search.query);
	searchRef.current = search.query;
	// A shows an ARCHIVED column after Done; the search covers it too.
	const [showArchived, setShowArchived] = useState(false);
	const showArchivedRef = useRef(showArchived);
	showArchivedRef.current = showArchived;
	const shownColumns: readonly Column[] = showArchived ? [...COLUMNS, 'archived'] : COLUMNS;
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
	const { liveWindowsRef, refreshWindows } = useLiveWindows();
	const unreviewed = useUnreviewed(stateRef);
	useRestoreCarried(stateRef);
	const pendingLocal = useRef(new Map<string, boolean>());
	// The merge status of open PRs, from the PR poll; not saved, since the poll refills it on startup.
	const [merge, setMerge] = useState<Record<string, PrStatus>>({});
	// The import list (i), replacing the columns while it's open.
	const [picker, setPicker] = useState<{ project: string; threads: OutsideThread[] } | null>(null);
	// The review requests list (R), replacing the columns while it's open.
	const [reviews, setReviews] = useState<Review[] | null>(null);
	// The columns' measured height and scroll positions, kept while another screen covers them.
	const columnsLayout = useRef(newColumnsLayout());
	// The thread B is picking a blocker for, while the cursor moves to the one it waits on.
	const [picking, setPicking] = useState<string | null>(null);
	// An action waiting on y (any other key cancels); its question is shown as the message.
	const [confirm, setConfirm] = useState<(() => void) | null>(null);
	const ask = (question: string, action: () => void) => {
		setConfirm(() => action);
		setMessage(`${question} y to confirm`);
	};

	const projectByName = (name: string) => stateRef.current.projects.find(p => p.name === name);

	const visible = (t: Thread, f = filter, q = search.query, archived = showArchived) =>
		(archived || t.column !== 'archived') && (!f || t.project === f) && matchesSearch(t, q);
	const columnThreads = (column: Column, f = filter, q = search.query) => state.threads.filter(t => t.column === column && visible(t, f, q));

	const colThreads = columnThreads(shownColumns[cursor.col]!);
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

	/** Q: quit and close every thread and hook window, warning about claudes still working in them. */
	const quitClosingWindows = async () => {
		const windows = await ooWindows();
		if (windows.length === 0) return ask('Quit?', exit);
		const working = stateRef.current.threads
			.filter(t => statusesRef.current[t.id] === 'working' && windows.includes(threadWindowName(t.id)))
			.map(t => `#${t.id}`);
		const warning = working.length ? ` ⚠ ${working.join(', ')} ${working.length === 1 ? 'is' : 'are'} still working` : '';
		const count = `${windows.length} window${windows.length === 1 ? '' : 's'}`;
		ask(`Close ${count} and quit?${warning}`, () =>
			void run(async () => {
				await closeOoWindows();
				exit();
			}, 'closing windows'),
		);
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
		shown: () => stateRef.current.threads.filter(t => visible(t, filterRef.current, searchRef.current, showArchivedRef.current)),
		showAtEnd: column =>
			setCursor({
				col: COLUMNS.indexOf(column as (typeof COLUMNS)[number]),
				row: stateRef.current.threads.filter(t => t.column === column && visible(t, filterRef.current, searchRef.current, showArchivedRef.current)).length,
			}),
	};
	useRequests(board);
	usePendingLocal(board, statuses);
	useMessageDelivery(board, state, statuses);
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

	/** Where the thread is shown with `f` as the filter and `q` as the search: its column, and its row there. */
	const positionOf = (thread: Thread, f: string | null, q = search.query) => {
		const col = shownColumns.indexOf(thread.column);
		return { col, row: columnThreads(thread.column, f, q).indexOf(thread) };
	};

	/** Jump to the column/row a thread is shown at, clearing the filter and search if they hide it. */
	const showThread = (thread: Thread) => {
		if (thread.column === 'archived' && !showArchived) return false;
		const shown = filter && filter !== thread.project ? null : filter;
		const query = matchesSearch(thread, search.query) ? search.query : '';
		setFilter(shown);
		search.set(query);
		setCursor(positionOf(thread, shown, query));
		return true;
	};

	/**
	 * ⏎ while picking: `target` blocks `thread` (its branch building on target's, if it can), or stops
	 * blocking it if it already did; `thread` itself clears them all. The same rules as `oo thread block`.
	 */
	const pickBlocker = (thread: Thread, target: Thread) => {
		setPicking(null);
		showThread(thread);
		const request =
			target.id === thread.id
				? ({ op: 'unblock', thread: thread.id } as const)
				: ({ op: thread.blockedBy?.includes(target.id) ? 'unblock' : 'block', thread: thread.id, blocker: target.id } as const);
		void run(async () => {
			const response = await applyRequest(board.store, { ...request, id: '' });
			setMessage(response.ok ? response.message : `⚠ ${response.message}`);
		}, 'blocking');
	};
	const pickingThread = picking ? state.threads.find(t => t.id === picking) : undefined;

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
		if (picking) {
			// Only moving, ⏎ and esc while picking.
			if (key.escape || !pickingThread) {
				setPicking(null);
				if (pickingThread) showThread(pickingThread);
				return setMessage('Cancelled');
			}
			if (key.return) return selected && pickBlocker(pickingThread, selected);
			if (!/^[hjkl]$/.test(input) && !key.leftArrow && !key.rightArrow && !key.upArrow && !key.downArrow) return;
		}
		if (search.key(input, key)) return;
		if (input === 'q') return ask('Quit?', exit);
		if (input === 'Q') return void run(quitClosingWindows, 'listing windows');
		// esc drops the search, then the project filter.
		if (key.escape && (search.query || filter)) {
			const f = search.query ? filter : null;
			search.set('');
			setFilter(f);
			// Stay on the same thread now that the rest of its column is back.
			if (selected) setCursor(positionOf(selected, f, ''));
			return;
		}
		if (input === '/') return search.open();
		if (input === 'h' || key.leftArrow) return setCursor({ col: loop(cursor.col, -1, shownColumns.length), row });
		if (input === 'l' || key.rightArrow) return setCursor({ col: loop(cursor.col, 1, shownColumns.length), row });
		if (input === 'j' || key.downArrow) return setCursor({ col: cursor.col, row: loop(row, 1, colThreads.length) });
		if (input === 'k' || key.upArrow) return setCursor({ col: cursor.col, row: loop(row, -1, colThreads.length) });
		if (input === 'n') return newThread();
		if (input === 'P') return setShowProjects(true);
		if (input === 'R') return openReviews();
		if (input === '?') return setShowKeys(true);
		if (input === 'A') {
			setShowArchived(!showArchived);
			// Out of the ARCHIVED column as it goes, into Done.
			if (showArchived && cursor.col >= COLUMNS.length) setCursor({ col: COLUMNS.indexOf('done'), row: 0 });
			return;
		}
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
		if (input === 'B') {
			if (selected.column === 'done' || selected.column === 'archived') return setMessage(`⚠ #${selected.id} is finished, so nothing blocks it`);
			return setPicking(selected.id);
		}
		if (input === 'C') {
			const current = selected.color ?? projectByName(selected.project)?.color ?? COLORS[0];
			return updateThread(selected.id, { color: COLORS[(COLORS.indexOf(current) + 1) % COLORS.length] });
		}
	});

	return (
		<Box flexDirection="column" height={height}>
			<Box justifyContent="space-between" width={width}>
				<Text bold>
					output-orchestrator{busy ? <Text color="cyan"> ● busy</Text> : null}
				</Text>
				<Text dimColor>
					filter: {filter ?? 'all'}
					{search.query ? ` · /${search.query}` : ''}
					{showArchived ? ' · +archived' : ''}
				</Text>
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
				<Columns
					board={board}
					shown={shownColumns}
					columns={shownColumns.map(column => columnThreads(column))}
					cursor={{ col: cursor.col, row }}
					setCursor={setCursor}
					active={!busy && !newThreadIn && !choosingImport && !confirm && !search.typing}
					unreviewed={unreviewed}
					merge={merge}
					layout={columnsLayout}
					onPick={pickingThread ? target => pickBlocker(pickingThread, target) : undefined}
				/>
			)}
			<Footer
				// About the highlighted card, so not while the import or review list covers the board.
				thread={picker || reviews ? undefined : selected}
				merge={selected && merge[selected.id]}
				blockers={selected && !picker && !reviews ? blockers(state, selected) : []}
				busy={busy}
				message={
					pickingThread
						? `Blocked by? Move to the thread #${pickingThread.id} waits on, ⏎ picks (again unpicks, on #${pickingThread.id} clears), esc cancels`
						: message
				}
				confirming={!!confirm}
				width={width}
				hidden={showProjects || showKeys || !!editing}
			>
				{choosingImport ? <ImportProject board={board} active={!busy} onPick={openPicker} onClose={() => setChoosingImport(false)} /> : null}
				<SearchBox search={search} />
				{newThreadIn ? <NewThread board={board} project={newThreadIn} recent={recent} active={!busy} onClose={() => setNewThreadIn(null)} /> : null}
			</Footer>
		</Box>
	);
}
