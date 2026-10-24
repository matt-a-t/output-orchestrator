import { existsSync } from 'node:fs';
import { useEffect, useRef, useState } from 'react';
import { Box, Text, measureElement, useApp, useInput, useWindowSize, type DOMElement, type Key } from 'ink';
import { openPrInBrowser, reviewRequests, type PrStatus, type ReviewRequest } from './github.js';
import { runNewThreadHook } from './hooks.js';
import { loop } from './input.js';
import { NEW_THREAD_LABELS, newThreadFields, newThreadForm, newThreadKey, type NewThreadField, type NewThreadForm, type NewThreadSubmit } from './newThreadForm.js';
import { ProjectsView } from './projects.js';
import { ThreadView } from './thread.js';
import type { Board } from './board/board.js';
import { Card, cardHeight, cardLines, LOCAL_BORDER_LINES } from './board/card.js';
import { launchClaude, openBeside, openThread, resumeId, stalled, wake, wakeStalled } from './board/claude.js';
import { Footer } from './board/footer.js';
import { KeysView } from './board/keysView.js';
import { toggleLocal, usePendingLocal } from './board/local.js';
import { archiveThread, finishThread, moveColumn } from './board/moves.js';
import { browsePr, checkPr, viewPr, viewThreadPr } from './board/pr.js';
import { useRequests } from './board/requests.js';
import { commentOnDiff, diffThread, listChanges, updateFromMain } from './board/review.js';
import { useLiveWindows, usePrPoll, useRestoreCarried, useStateFile, useStatuses, useUnreviewed } from './board/watchers.js';
import { COLORS, COLUMN_LABELS, COLUMNS, type Column, type Project, type Thread } from './state.js';
import { fetchTicket, recentTickets, ticketUrl, type Ticket } from './tickets.js';
import { listOutsideThreads, recentlyActive, timeAgo, type OutsideThread } from './transcripts.js';
import { mouse, type MouseEvent } from './mouse.js';
import { addThread, createWorktree as worktreeFor, setColumn as moveTo } from './threads.js';
import { threadWindowName } from './tmux.js';

/** Picking the project to import from (`i` with no filter). */
type Prompt = { step: 'project'; index: number };
const NEW_THREAD_LABEL_WIDTH = Math.max(...Object.values(NEW_THREAD_LABELS).map(l => l.length)) + 2;

// The columns and the import list start below the title bar, a header and a rule.
const LIST_TOP = 3;

/** A PR asking you for a review, and the project it's in. */
type Review = ReviewRequest & { project: Project };
const DOUBLE_CLICK_MS = 400;

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
	const [prompt, setPrompt] = useState<Prompt | null>(null);
	// The new-thread form (n), over the bottom of the board.
	const [form, setForm] = useState<NewThreadForm | null>(null);
	// The form's recent tickets, for the project they're from; a string is why they couldn't be listed.
	const [recent, setRecent] = useState<{ project: string; tickets: Ticket[] | string | null } | null>(null);
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
	const [picker, setPicker] = useState<{ project: string; threads: OutsideThread[]; row: number } | null>(null);
	// The review requests list (R), replacing the columns while it's open.
	const [reviews, setReviews] = useState<{ requests: Review[]; row: number } | null>(null);
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
		showAtEnd: column =>
			setCursor({
				col: COLUMNS.indexOf(column as (typeof COLUMNS)[number]),
				row: stateRef.current.threads.filter(t => t.column === column && visible(t, filterRef.current)).length,
			}),
	};
	useRequests(board);
	usePendingLocal(board, statuses);
	usePrPoll(stateRef, setMerge, thread => checkPr(board, thread));

	/**
	 * The open PRs asking you for a review, across projects (those with a repo), most recently
	 * updated first. Projects gh can't ask about are named in the message.
	 */
	const fetchReviews = async (): Promise<Review[]> => {
		const projects = state.projects.filter(p => p.worktrees && existsSync(p.path));
		const failed: string[] = [];
		const found = await Promise.all(
			projects.map(project =>
				reviewRequests(project.path).then(
					requests => requests.map(r => ({ ...r, project })),
					() => (failed.push(project.name), []),
				),
			),
		);
		if (failed.length) setMessage(`⚠ gh couldn't list PRs in ${failed.join(', ')}`);
		return found.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	};

	const openReviews = () =>
		run(async () => {
			const requests = await fetchReviews();
			if (requests.length === 0) return setMessage(m => m || 'No PRs waiting for your review');
			setReviews({ requests, row: 0 });
		}, 'looking for review requests');

	/** View a review request's PR, then refresh the list, since one you've reviewed drops off it. */
	const viewReview = (review: Review) =>
		run(async () => {
			if (!(await viewPr(board, review.project.path, review.number))) return;
			const requests = await fetchReviews();
			setReviews(r => r && { requests, row: Math.min(r.row, Math.max(0, requests.length - 1)) });
		}, `loading PR #${review.number}`);

	const newThread = () => {
		const project = projectByName(filter ?? selected?.project ?? '') ?? state.projects[0]!;
		setForm(newThreadForm(project.name));
		loadRecent(project);
	};

	/** List the project's recent tickets for the form, if it has a tracker. */
	const loadRecent = (project: Project) => {
		if (project.tracker === 'none') return setRecent(null);
		if (recent?.project === project.name && Array.isArray(recent.tickets)) return;
		setRecent({ project: project.name, tickets: null });
		recentTickets(project).then(
			tickets => setRecent(r => (r?.project === project.name ? { ...r, tickets } : r)),
			(err: unknown) => setRecent(r => (r?.project === project.name ? { ...r, tickets: err instanceof Error ? err.message : String(err) } : r)),
		);
	};

	const recentFor = (project: string) => (recent?.project === project && Array.isArray(recent.tickets) ? recent.tickets : []);

	const formInput = (form: NewThreadForm, input: string, key: Key) => {
		const next = newThreadKey(form, input, key, { projects: state.projects, tickets: recentFor(form.project) });
		if ('problem' in next) return setMessage(`✗ ${next.problem}`);
		if ('done' in next) {
			setForm(null);
			return next.done ? submitNewThread(next.done) : setMessage('Cancelled');
		}
		if (next.project !== form.project) loadRecent(projectByName(next.project)!);
		setForm(next);
	};

	/**
	 * Create the thread from the form, titled and planned from its ticket when it has one, then run the
	 * project's new thread hook and start its claude in the background on the initial prompt, if there
	 * is one. With a prompt, the worktree comes first so the hook runs in it.
	 */
	const submitNewThread = ({ project: name, ticketKey, ticket: known, title, prompt }: NewThreadSubmit) =>
		run(async () => {
			const project = projectByName(name)!;
			const thread = await threadFromForm(project, title, ticketKey, known);
			if (!thread) return;
			const change = prompt && !thread.cwd ? await worktreeFor(project, thread) : undefined;
			if (change?.patch) updateThread(thread.id, change.patch);
			const created = { ...thread, ...change?.patch };
			const ran = await runNewThreadHook(project, created, prompt);
			if (prompt) await launchClaude(board, created, created.cwd ?? change!.path, { background: true, prompt });
			const done = `Created #${thread.id}${thread.ticket ? ` for ${thread.ticket.key}` : ''}`;
			if (ran || prompt) setMessage([done, ran, prompt && 'started claude on your prompt'].filter(Boolean).join(' · '));
		}, ticketKey ? `reading ${ticketKey}` : 'creating thread');

	const threadFromForm = async (project: Project, title: string, ticketKey?: string, known?: Ticket): Promise<Thread | undefined> => {
		if (!ticketKey) return createThread(project.name, title);
		const ticket = await fetchTicket(project, ticketKey).catch((err: unknown) => {
			setMessage(`⚠ Couldn't read ${ticketKey}: ${err instanceof Error ? err.message : String(err)}`);
			return known;
		});
		if (ticket) return createThread(project.name, title || ticket.summary, { ticket: { key: ticketKey, url: ticket.url }, plan: ticket.description });
		// Without the ticket there's nothing to title the thread after.
		if (!title) return void setMessage(`✗ Couldn't read ${ticketKey}, so it needs a title — press n to try again`);
		const url = await ticketUrl(project, ticketKey).catch(() => '');
		return createThread(project.name, title, { ticket: { key: ticketKey, url } });
	};

	const createThread = (project: string, title: string, fields: Partial<Pick<Thread, 'ticket' | 'plan'>> = {}) => {
		const { thread } = addThread(stateRef.current, { project, title, ...fields });
		setState(s => ({ ...s, threads: [...s.threads, thread] }));
		setCursor({ col: 0, row: stateRef.current.threads.filter(t => t.column === 'planned' && (!filter || t.project === filter)).length });
		setMessage(`Created #${thread.id}${thread.ticket ? ` for ${thread.ticket.key}` : ''}${thread.plan ? '' : ' — e to add a plan'}`);
		return thread;
	};

	const promptInput = (prompt: Prompt, input: string, key: Key) => {
		if (key.escape) {
			setPrompt(null);
			return setMessage('Cancelled');
		}
		const count = state.projects.length;
		if (input === 'j' || key.downArrow) return setPrompt({ ...prompt, index: (prompt.index + 1) % count });
		if (input === 'k' || key.upArrow) return setPrompt({ ...prompt, index: (prompt.index + count - 1) % count });
		if (key.return) {
			setPrompt(null);
			return openPicker(state.projects[prompt.index]!);
		}
	};

	/** Import from the filtered project, asking which one when there's no filter (and more than one). */
	const startImport = () => {
		const filtered = filter ? projectByName(filter) : state.projects.length === 1 ? state.projects[0] : undefined;
		if (filtered) return openPicker(filtered);
		setPrompt({ step: 'project', index: 0 });
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
		if (form) return formInput(form, input, key);
		if (prompt) return promptInput(prompt, input, key);
		if (picker) {
			const count = picker.threads.length;
			if (input === 'q' || input === 'i' || key.escape) return setPicker(null);
			if (input === 'j' || key.downArrow) return setPicker({ ...picker, row: loop(picker.row, 1, count) });
			if (input === 'k' || key.upArrow) return setPicker({ ...picker, row: loop(picker.row, -1, count) });
			if (key.return) return importThread(picker.project, picker.threads[picker.row]!);
			return;
		}
		if (reviews) {
			const count = reviews.requests.length;
			const review = reviews.requests[reviews.row];
			if (input === 'q' || input === 'R' || key.escape) return setReviews(null);
			if (input === 'j' || key.downArrow) return setReviews({ ...reviews, row: loop(reviews.row, 1, count) });
			if (input === 'k' || key.upArrow) return setReviews({ ...reviews, row: loop(reviews.row, -1, count) });
			if (input === 'r') {
				return run(async () => {
					const requests = await fetchReviews();
					setReviews({ requests, row: Math.min(reviews.row, Math.max(0, requests.length - 1)) });
				}, 'looking for review requests');
			}
			if (!review) return;
			if (key.return || input === 'v') return viewReview(review);
			if (input === 'b') return run(() => openPrInBrowser(review), 'opening PR in the browser');
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
		if (input === 'W') return wakeStalled(board, state.threads.filter(t => visible(t)));
		if (input === 'P') return setShowProjects(true);
		if (input === 'R') return openReviews();
		if (input === '?') return setShowKeys(true);
		if (input === 'i') return startImport();
		if (input === 'p') {
			const names = [null, ...state.projects.map(p => p.name)];
			setFilter(names[(names.indexOf(filter) + 1) % names.length]!);
			return setCursor({ col: cursor.col, row: 0 });
		}
		if (!selected) return;
		if (input === 'H') return moveColumn(board, selected, -1);
		if (input === 'L') return moveColumn(board, selected, 1);
		if (input === 'F') return finishThread(board, selected);
		if (input === 'K') return reorder(selected, -1);
		if (input === 'J') return reorder(selected, 1);
		if (input === 't') return toggleLocal(board, selected);
		if (input === 'e') return setEditing(selected.id);
		if (key.return) return openThread(board, selected);
		if (input === 'w') return wake(board, selected);
		if (input === 'u') return updateFromMain(board, selected);
		if (input === 'C') {
			const current = selected.color ?? projectByName(selected.project)?.color ?? COLORS[0];
			return updateThread(selected.id, { color: COLORS[(COLORS.indexOf(current) + 1) % COLORS.length] });
		}
		if (input === 'x') return archiveThread(board, selected);
		if (key.meta && (input === 'd' || input === 'D')) return openBeside(board, selected, 'diff');
		if (input === 'd' || input === 'D') return diffThread(board, selected, input === 'd' ? 'step' : 'thread');
		if (input === 's') return openBeside(board, selected, 'shell');
		if (input === 'c') return commentOnDiff(board, selected);
		if (input === 'b') return browsePr(board, selected);
		if (input === 'v') return viewThreadPr(board, selected);
		if (input === 'o') return listChanges(board, selected);
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
	// measured after each render, starting at entry `pickerTop`. The review list shares the measuring.
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
	// Review requests are a line each.
	const reviewsTop = useRef(0);
	if (reviews) {
		reviewsTop.current = Math.min(reviewsTop.current, reviews.row);
		reviewsTop.current = Math.max(reviewsTop.current, reviews.row - Math.max(1, pickerLines) + 1);
	} else reviewsTop.current = 0;

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
		if (busy || showProjects || showKeys || editing || form || prompt || confirm) return;
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
		if (reviews) {
			const last = reviews.requests.length - 1;
			if (wheel) return setReviews(r => r && { ...r, row: Math.max(0, Math.min(last, r.row + wheel)) });
			const r = reviewsTop.current + y - LIST_TOP;
			if (button !== 'left' || y < LIST_TOP || r > last || r >= reviewsTop.current + pickerLines) return;
			setReviews(rs => rs && { ...rs, row: r });
			if (isDoubleClick(reviews.requests[r]!.url)) viewReview(reviews.requests[r]!);
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
		if (isDoubleClick(thread.id)) openThread(board, thread);
	};
	const onMouseRef = useRef(onMouse);
	onMouseRef.current = onMouse;
	useEffect(() => {
		const listener = (event: MouseEvent) => onMouseRef.current(event);
		mouse.on('press', listener);
		return () => void mouse.off('press', listener);
	}, []);

	/** The `n` form: a field per line, with the recent tickets under the ticket field while it's active. */
	const newThreadBox = (form: NewThreadForm) => {
		const project = projectByName(form.project);
		const tickets = recent?.project === form.project ? recent.tickets : null;
		const cursor = <Text inverse> </Text>;
		const value = (field: NewThreadField, active: boolean) => {
			if (field === 'project') return <Text color={project?.color}>{active ? `‹ ${form.project} ›` : form.project}</Text>;
			if (field === 'ticket') {
				return (
					<Text color="blue">
						{form.ticketKey}
						{active ? cursor : null}
						{!form.ticketKey ? <Text dimColor>{active ? '  type a key or ←/→ for recent' : 'none'}</Text> : null}
					</Text>
				);
			}
			return (
				<Text>
					{form[field]}
					{active ? cursor : null}
					{field === 'prompt' && !form.prompt && !active ? <Text dimColor>none — claude isn't started</Text> : null}
				</Text>
			);
		};
		return (
			<Box flexDirection="column" borderStyle="round" borderColor={project?.color} paddingX={1}>
				<Text bold>New thread</Text>
				{newThreadFields(project).map(field => {
					const active = field === form.field;
					return (
						<Box key={field} flexDirection="column">
							<Text wrap="wrap">
								<Text dimColor={!active}>
									{active ? '› ' : '  '}
									{`${NEW_THREAD_LABELS[field]}:`.padEnd(NEW_THREAD_LABEL_WIDTH)}
								</Text>
								{value(field, active)}
							</Text>
							{field === 'ticket' && active ? (
								<Box flexDirection="column" marginLeft={NEW_THREAD_LABEL_WIDTH + 2}>
									{tickets === null ? <Text dimColor>loading recent tickets…</Text> : null}
									{typeof tickets === 'string' ? <Text dimColor>{tickets}</Text> : null}
									{Array.isArray(tickets) && tickets.length === 0 ? <Text dimColor>none open and assigned to you</Text> : null}
									{Array.isArray(tickets)
										? tickets.map((t, i) => (
												<Text key={t.key} wrap="truncate" inverse={i === form.ticket}>
													<Text color="blue">{t.key}</Text> {t.summary}
												</Text>
											))
										: null}
								</Box>
							) : null}
						</Box>
					);
				})}
				<Text dimColor>tab or ↑/↓ field  ←/→ project / ticket  ⏎ create  esc cancel  ctrl-u clear  ctrl-w delete word</Text>
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
			) : reviews ? (
				<Box flexGrow={1} overflow="hidden" flexDirection="column">
					<Text bold>
						PRs waiting for your review <Text dimColor>(j/k move  ⏎/v view  b browser  r refresh  esc/q/R close, or click, double-click, scroll)</Text>
					</Text>
					<Text dimColor>
						{'─'.repeat(Math.max(0, width - 13))} {String(reviews.row + 1).padStart(4)} of {String(reviews.requests.length).padEnd(3)}
					</Text>
					<Box ref={pickerList} flexGrow={1} flexBasis={0} flexDirection="column" overflow="hidden">
						{reviews.requests.slice(reviewsTop.current, reviewsTop.current + Math.max(1, pickerLines)).map((r, i) => (
							<Text key={r.url} wrap="truncate" inverse={reviewsTop.current + i === reviews.row}>
								<Text dimColor>{timeAgo(new Date(r.updatedAt)).padEnd(9)}</Text>
								<Text color={r.project.color}>{(r.project.abbrev || r.project.name).padEnd(6)} </Text>
								<Text color="cyan">#{r.number} </Text>
								{r.isDraft ? <Text dimColor>draft </Text> : null}
								{r.title} <Text dimColor>— {r.author.login}</Text>
							</Text>
						))}
					</Box>
				</Box>
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
				{prompt ? (
					<Box flexDirection="column">
						<Text bold>Import — project? (j/k move, ⏎ choose, esc cancel)</Text>
						{state.projects.map((p, i) => (
							<Text key={p.name} inverse={i === prompt.index}>
								{'  '}
								<Text color={p.color}>{p.name}</Text>
								<Text dimColor> {p.path}</Text>
							</Text>
						))}
					</Box>
				) : null}
				{form ? newThreadBox(form) : null}
			</Footer>
		</Box>
	);
}
