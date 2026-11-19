import { useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { errorMessage, resultMessage } from './errors.js';
import type { PrStatus } from './prHost.js';
import { loop } from './input.js';
import { ProjectsView } from './projects.js';
import { SearchBox, useSearch } from './search.js';
import type { Board } from './board/board.js';
import { runBinding } from './board/bindings.js';
import { Columns, newColumnsLayout } from './board/columns.js';
import { Details, type DetailTab } from './board/details.js';
import { Footer } from './board/footer.js';
import { useIdleClose } from './board/idle.js';
import { useContainerSweep } from './board/containers.js';
import { useFreshStarts } from './board/claude.js';
import { ImportList, ImportProject } from './board/importPicker.js';
import { KeysView } from './board/keysView.js';
import { jobsWarning, useJobs } from './board/jobs.js';
import { usePendingLocal } from './board/local.js';
import { useMessageDelivery } from './board/messages.js';
import { NewThread } from './board/newThread.js';
import { checkPr } from './board/pr.js';
import { useRequests } from './board/requests.js';
import { RunPicker, runTarget, type RunTarget } from './board/runPicker.js';
import { usePrPoll, useRestoreCarried, useStateFile, useStatuses, useTmux, useUnreviewed } from './board/watchers.js';
import { killRunSessions } from './commands.js';
import { COLUMNS, PRIORITIES, type Column, type Project, type Thread } from './state.js';
import { listOutsideThreads, type OutsideThread } from './transcripts.js';
import { applyRequest, byPriority, matchesSearch, priorityOf, setColumn as moveTo, withPriority } from './threads.js';
import { closeOoWindows, ooWindows, threadWindowName } from './tmux.js';

/** What fills the space between the title and the footer: the columns, or a view in their place. */
type Screen =
	| { kind: 'board' }
	| { kind: 'projects' } // P
	| { kind: 'keys' } // ?
	| { kind: 'details'; threadId: string; tab: DetailTab } // e, t and z: the thread's details, on its fields, steps or quiz
	| { kind: 'importProject' } // N with no filter: which project to import from
	| { kind: 'import'; project: string; threads: OutsideThread[] }; // N, the threads to import

/** A form over the bottom of the board, below the columns. */
type Overlay = { kind: 'newThread'; project: Project } | { kind: 'run'; target: RunTarget } | null;

const BOARD: Screen = { kind: 'board' };

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
	// I shows an IDEAS column before Planned, and A an ARCHIVED one after Done; the search covers them too.
	const [showIdeas, setShowIdeas] = useState(false);
	const [showArchived, setShowArchived] = useState(false);
	const shownColumns: readonly Column[] = [...(showIdeas ? ['ideas' as const] : []), ...COLUMNS, ...(showArchived ? ['archived' as const] : [])];
	const shownColumnsRef = useRef(shownColumns);
	shownColumnsRef.current = shownColumns;
	const [message, setMessage] = useState('');
	const [busy, setBusy] = useState<string | null>(null);
	// Local in/out and waking, running per thread while the board stays usable.
	const jobs = useJobs(setMessage);
	const [screen, setScreen] = useState<Screen>(BOARD);
	const toBoard = () => setScreen(BOARD);
	// The new-thread form (n) or the project's commands to run (r).
	const [overlay, setOverlay] = useState<Overlay>(null);
	const closeOverlay = () => setOverlay(null);
	const { statuses, statusesRef, sessionStarts, statusSince } = useStatuses(stateRef, setState);
	const { liveWindowsRef, refreshWindows, runsRef, refreshRuns } = useTmux();
	const { unreviewed, recheckUnreviewed } = useUnreviewed(stateRef, statuses, liveWindowsRef);
	useRestoreCarried(stateRef);
	const pendingLocal = useRef(new Map<string, boolean>());
	// The merge status of open PRs, from the PR poll; not saved, since the poll refills it on startup.
	const [merge, setMerge] = useState<Record<string, PrStatus>>({});
	const detailsThread = screen.kind === 'details' ? state.threads.find(t => t.id === screen.threadId) : undefined;
	// The screen as shown: the board again if the thread whose details were open has gone.
	const shown: Screen = screen.kind === 'details' && !detailsThread ? BOARD : screen;
	// Every view but the keys screen takes its own keys, as do the overlays.
	const ownKeys = (shown.kind !== 'board' && shown.kind !== 'keys') || !!overlay;
	// Views that take the whole window, footer and all.
	const fullScreen = shown.kind === 'projects' || shown.kind === 'keys' || shown.kind === 'details';
	// The columns' measured height and scroll positions, kept while another screen covers them.
	const columnsLayout = useRef(newColumnsLayout());
	// The thread B is picking a blocker for, while the cursor moves to the one it waits on.
	const [picking, setPicking] = useState<string | null>(null);
	// An action waiting on y, and maybe another on n (any other key cancels); its question is shown as the message.
	const [confirm, setConfirm] = useState<{ yes: () => void; no?: () => void } | null>(null);
	const ask = (question: string, yes: () => void, no?: () => void) => {
		setConfirm({ yes, no });
		// A question with an n answer says what y and n do itself.
		setMessage(no ? question : `${question} y to confirm`);
	};

	const projectByName = (name: string) => stateRef.current.projects.find(p => p.name === name);

	const visible = (t: Thread, f = filter, q = search.query, columns = shownColumns) =>
		columns.includes(t.column) && (!f || t.project === f) && matchesSearch(t, q);
	const columnThreads = (column: Column, f = filter, q = search.query) => byPriority(state.threads.filter(t => t.column === column && visible(t, f, q)));

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
		// The column keeps priorities together, so J/K only moves a thread among its own.
		if (priorityOf(neighbour) !== priorityOf(thread)) {
			return setMessage(`⚠ #${thread.id} is at the ${delta < 0 ? 'top' : 'bottom'} of its ${priorityOf(thread)} priority threads — ! changes its priority`);
		}
		setState(s => {
			const threads = [...s.threads];
			const a = threads.findIndex(t => t.id === thread.id);
			const b = threads.findIndex(t => t.id === neighbour.id);
			[threads[a], threads[b]] = [threads[b]!, threads[a]!];
			return { ...s, threads };
		});
		setCursor({ col: cursor.col, row: row + delta });
	};

	/** !: the next priority (normal, high, low), keeping the cursor on the thread as it moves up or down the column. */
	const cyclePriority = (thread: Thread) => {
		const priority = PRIORITIES[(PRIORITIES.indexOf(priorityOf(thread)) + 2) % PRIORITIES.length]!;
		updateThread(thread.id, withPriority(priority));
		const column = byPriority(colThreads.map(t => (t.id === thread.id ? { ...t, ...withPriority(priority) } : t)));
		setCursor({ col: cursor.col, row: column.findIndex(t => t.id === thread.id) });
		setMessage(`#${thread.id} is ${priority} priority`);
	};

	const run = async (fn: () => Promise<void>, label = 'waiting for popup') => {
		setBusy(label);
		try {
			await fn();
		} catch (err) {
			setMessage(`✗ ${errorMessage(err)}`);
		} finally {
			setBusy(null);
		}
	};

	/** Q: quit and close every thread and hook window and stop every run (r), warning about claudes still working in them. */
	const quitClosingWindows = async () => {
		const windows = await ooWindows();
		const runs = runsRef.current.size;
		if (windows.length === 0 && runs === 0) return ask(`Quit?${jobsWarning(jobs.jobs())}`, exit);
		const working = stateRef.current.threads
			.filter(t => statusesRef.current[t.id] === 'working' && windows.includes(threadWindowName(t.id)))
			.map(t => `#${t.id}`);
		const warning = (working.length ? ` ⚠ ${working.join(', ')} ${working.length === 1 ? 'is' : 'are'} still working` : '') + jobsWarning(jobs.jobs());
		const count = [
			windows.length ? `${windows.length} window${windows.length === 1 ? '' : 's'}` : '',
			runs ? `${runs} run${runs === 1 ? '' : 's'}` : '',
		]
			.filter(Boolean)
			.join(' and ');
		ask(`Close ${count} and quit?${warning}`, () =>
			void run(async () => {
				await closeOoWindows();
				await killRunSessions();
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
		statusSince,
		liveWindows: () => liveWindowsRef.current,
		sessionStarts,
		refreshWindows,
		runs: () => runsRef.current,
		refreshRuns,
		recheckUnreviewed,
		setMerge,
		pendingLocal: pendingLocal.current,
		setMessage,
		setBusy,
		run,
		jobs: jobs.jobs,
		startJob: jobs.startJob,
		ask,
		shown: () => stateRef.current.threads.filter(t => visible(t, filterRef.current, searchRef.current, shownColumnsRef.current)),
		shownColumns: () => shownColumnsRef.current,
		showAtEnd: column =>
			setCursor({
				col: shownColumnsRef.current.indexOf(column),
				row: stateRef.current.threads.filter(t => t.column === column && visible(t, filterRef.current, searchRef.current, shownColumnsRef.current)).length,
			}),
	};
	useRequests(board);
	usePendingLocal(board, statuses, jobs.shown);
	useMessageDelivery(board, state, statuses);
	useIdleClose(board);
	useContainerSweep(board);
	useFreshStarts(board, state, statuses);
	usePrPoll(stateRef, setMerge, thread => checkPr(board, thread));

	/** Open the new-thread form on the filtered or highlighted project. */
	const newThread = () => {
		const project = projectByName(filter ?? selected?.project ?? '') ?? state.projects[0]!;
		setOverlay({ kind: 'newThread', project });
	};

	/** Import from the filtered project, asking which one when there's no filter (and more than one). */
	const startImport = () => {
		const filtered = filter ? projectByName(filter) : state.projects.length === 1 ? state.projects[0] : undefined;
		if (filtered) return openPicker(filtered);
		setScreen({ kind: 'importProject' });
	};

	const openPicker = (project: Project) =>
		run(async () => {
			const threads = await listOutsideThreads(project.path);
			if (threads.length === 0) return setMessage(`No claude threads to import in ${project.path}`);
			setScreen({ kind: 'import', project: project.name, threads });
		}, 'looking for threads');

	/** Where the thread is shown with `f` as the filter and `q` as the search: its column, and its row there. */
	const positionOf = (thread: Thread, f: string | null, q = search.query) => {
		const col = shownColumns.indexOf(thread.column);
		return { col, row: columnThreads(thread.column, f, q).indexOf(thread) };
	};

	/** Jump to the column/row a thread is shown at, clearing the filter and search if they hide it. */
	const showThread = (thread: Thread) => {
		if (!shownColumns.includes(thread.column)) return false;
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
			setMessage(resultMessage(response));
		}, 'blocking');
	};
	const pickingThread = picking ? state.threads.find(t => t.id === picking) : undefined;

	useInput((input, key) => {
		// The form, the import and todo lists and the import project picker take their own keys.
		if (busy || ownKeys) return;
		setMessage('');
		if (shown.kind === 'keys') {
			if (input === '?' || input === 'q' || key.escape) toBoard();
			return;
		}
		if (confirm) {
			setConfirm(null);
			if (input === 'y') return confirm.yes();
			if (input === 'n' && confirm.no) return confirm.no();
			return setMessage('Cancelled');
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
		if (input === 'q') return ask(`Quit?${jobsWarning(jobs.jobs())}`, exit);
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
		if (input === 'P') return setScreen({ kind: 'projects' });
		if (input === '?') return setScreen({ kind: 'keys' });
		if (input === 'A') {
			setShowArchived(!showArchived);
			// Out of the ARCHIVED column as it goes, into Done.
			if (showArchived && shownColumns[cursor.col] === 'archived') setCursor({ col: cursor.col - 1, row: 0 });
			return;
		}
		if (input === 'I') {
			setShowIdeas(!showIdeas);
			// The columns shift by one, so stay on the same one (or out of IDEAS, into Planned).
			if (!showIdeas) return setCursor({ col: cursor.col + 1, row });
			return setCursor(cursor.col === 0 ? { col: 0, row: 0 } : { col: cursor.col - 1, row });
		}
		if (input === 'N') return startImport();
		if (input === 'r') {
			const project = projectByName(selected?.project ?? filter ?? '') ?? (state.projects.length === 1 ? state.projects[0] : undefined);
			if (!project) return setMessage('⚠ Run whose commands? Highlight a thread, or p to filter to a project');
			return setOverlay({ kind: 'run', target: runTarget(board, project, selected) });
		}
		if (input === 'p') {
			const names = [null, ...state.projects.map(p => p.name)];
			setFilter(names[(names.indexOf(filter) + 1) % names.length]!);
			return setCursor({ col: cursor.col, row: 0 });
		}
		if (runBinding(board, input, key, selected)) return;
		if (!selected) return;
		if (input === 'K') return reorder(selected, -1);
		if (input === 'J') return reorder(selected, 1);
		if (input === 'e') return setScreen({ kind: 'details', threadId: selected.id, tab: 'overview' });
		if (input === 't') return setScreen({ kind: 'details', threadId: selected.id, tab: 'steps' });
		if (input === 'z') return setScreen({ kind: 'details', threadId: selected.id, tab: 'quiz' });
		if (input === 'B') {
			if (selected.column === 'done' || selected.column === 'archived') return setMessage(`⚠ #${selected.id} is finished, so nothing blocks it`);
			return setPicking(selected.id);
		}
		if (input === '!') return cyclePriority(selected);
	});

	/** The columns, or the view open in their place. Grows to fill the window, which keeps the footer at the bottom. */
	const renderScreen = () => {
		switch (shown.kind) {
			case 'projects':
				return <ProjectsView state={state} setState={setState} onClose={toBoard} />;
			case 'details':
				return (
					<Details
						key={shown.threadId}
						board={board}
						state={state}
						thread={detailsThread!}
						tab={shown.tab}
						setTab={tab => setScreen({ ...shown, tab })}
						merge={merge[shown.threadId]}
						active={!busy}
						onClose={closing => {
							toBoard();
							setMessage(closing);
						}}
					/>
				);
			case 'keys':
				return <KeysView active={!busy} />;
			case 'importProject':
				return <ImportProject board={board} active={!busy} onPick={openPicker} onClose={toBoard} />;
			case 'import':
				return <ImportList board={board} project={shown.project} threads={shown.threads} active={!busy} onClose={toBoard} onShow={showThread} />;
			case 'board':
				return (
					<Columns
						board={board}
						shown={shownColumns}
						columns={shownColumns.map(column => columnThreads(column))}
						cursor={{ col: cursor.col, row }}
						setCursor={setCursor}
						active={!busy && !overlay && !confirm && !search.typing}
						unreviewed={unreviewed}
						merge={merge}
						jobs={jobs.shown}
						layout={columnsLayout}
						onPick={pickingThread ? target => pickBlocker(pickingThread, target) : undefined}
					/>
				);
		}
	};

	return (
		<Box flexDirection="column" height={height}>
			<Box justifyContent="space-between" width={width}>
				<Text bold>
					output-orchestrator
					{busy ? <Text color="cyan"> ● busy</Text> : jobs.shown.size ? <Text color="cyan"> ● {jobs.shown.size} in background</Text> : null}
				</Text>
				<Text dimColor>
					filter: {filter ?? 'all'}
					{search.query ? ` · /${search.query}` : ''}
					{showIdeas ? ' · +ideas' : ''}
					{showArchived ? ' · +archived' : ''}
				</Text>
			</Box>
			{/* Grows to fill the window, which keeps the info below at the bottom. */}
			{renderScreen()}
			<Footer
				busy={busy}
				message={
					pickingThread
						? `Blocked by? Move to the thread #${pickingThread.id} waits on, ⏎ picks (again unpicks, on #${pickingThread.id} clears), esc cancels`
						: message
				}
				confirming={!!confirm}
				width={width}
				hidden={fullScreen}
			>
				{overlay?.kind === 'run' ? <RunPicker board={board} target={overlay.target} active={!busy} onClose={closeOverlay} /> : null}
				<SearchBox search={search} />
				{overlay?.kind === 'newThread' ? (
					<NewThread board={board} project={overlay.project} active={!busy} onClose={closeOverlay} />
				) : null}
			</Footer>
		</Box>
	);
}
