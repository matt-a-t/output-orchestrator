// A thread's details (e, t, z), in place of the columns: its fields to edit, and tabs for its plan, steps, messages,
// last pop quiz and where its work lives. It reads the thread live, so it keeps up as claude works.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Text, measureElement, useInput, useWindowSize, type DOMElement, type Key } from 'ink';
import { containerName, knownPorts, portsText } from '../container.js';
import { editPlan } from '../editor.js';
import { errorMessage, messageColor } from '../errors.js';
import { EDITING_HELP, FIELD_HELP, FieldText } from '../fieldText.js';
import { hasWorktree, renameBranch, worktreePath } from '../git.js';
import { choiceStep, fieldKey, fieldStep, isBack, isSubmit, loop, nextField, type Edit } from '../input.js';
import { mouse, type MouseEvent } from '../mouse.js';
import { mergeLabel, type PrStatus } from '../prHost.js';
import type { Quiz } from '../quiz.js';
import { QuizReview } from '../quizForm.js';
import { COLORS, COLUMN_LABELS, LOCAL_LABEL, PRIORITIES, PRIORITY_COLORS, type Priority, type State, type Thread } from '../state.js';
import type { Status } from '../status.js';
import { blockers, inCheckout, merged, priorityOf, senderLabel, todoProgress, todoWindow, undelivered, withPriority } from '../threads.js';
import { threadWindowName } from '../tmux.js';
import { normalizeKey, ticketUrl } from '../tickets.js';
import { contextUse, describeContext, shortDuration } from '../transcripts.js';
import { fitTabs, TAB_FRAME } from '../viewerModel.js';
import type { Board } from './board.js';
import { resumeId, stalled } from './claude.js';
import { ScrollBar } from './scrollList.js';
import { TodoRow } from './todoList.js';

export const DETAIL_TABS = ['overview', 'plan', 'steps', 'messages', 'quiz', 'info'] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

const FIELDS = ['title', 'ticket', 'project', 'color', 'priority', 'base'] as const;
type Field = (typeof FIELDS)[number];
const FIELD_LABELS: Record<Field, string> = { title: 'title', ticket: 'ticket', project: 'project', color: 'colour', priority: 'priority', base: 'base' };
const TEXT_FIELDS: readonly Field[] = ['title', 'ticket', 'base'];
// undefined means the project's colour.
const COLOR_CHOICES = [undefined, ...COLORS];
const LABEL_WIDTH = 13;
// Lines the wheel scrolls at a time.
const WHEEL_LINES = 3;

// The ticket is edited as its key, and normal priority is spelled out.
type Draft = Pick<Thread, 'title' | 'project' | 'color'> & { base: string; ticket: string; priority: Priority };
const draftOf = (t: Thread): Draft => ({ title: t.title, ticket: t.ticket?.key ?? '', project: t.project, color: t.color, priority: priorityOf(t), base: t.base ?? '' });
const sameDraft = (a: Draft, b: Draft) => FIELDS.every(f => a[f] === b[f]);

const STATUS_LABELS: Partial<Record<Status, [string, string]>> = {
	working: ['working', 'yellow'],
	waiting: ['needs you', 'red'],
	stopped: ['stopped', 'green'],
};

type Props = {
	board: Board;
	state: State;
	thread: Thread;
	tab: DetailTab;
	setTab: (tab: DetailTab) => void;
	merge: PrStatus | undefined;
	// Whether it takes keys and the wheel (not while the board is busy).
	active: boolean;
	onClose: (message: string) => void;
};

export function Details({ board, state, thread, tab, setTab, merge, active, onClose }: Props) {
	const { columns: width } = useWindowSize();
	// Unsaved changes to the Overview's fields; null shows the thread as it is.
	const [changes, setChanges] = useState<Draft | null>(null);
	const draft = changes ?? draftOf(thread);
	const [field, setField] = useState(0);
	// The focused text field is being edited (see fieldKey).
	const [edit, setEdit] = useState<Edit>(null);
	const [message, setMessage] = useState('');
	// Looking up the ticket, renaming the branch or editing the plan.
	const [working, setWorking] = useState<string | null>(null);
	const setDraft = (next: Draft) => setChanges(sameDraft(next, draftOf(thread)) ? null : next);

	const save = (draft: Draft) => {
		const title = draft.title.trim();
		if (!title) return setMessage('✗ Title is empty');
		// The branch and worktree belong to the old project's repo.
		if (draft.project !== thread.project && (thread.branch || thread.cwd)) {
			return setMessage(`✗ #${thread.id} already has work in ${thread.project}; it can't move project`);
		}
		const project = state.projects.find(p => p.name === draft.project);
		const key = draft.ticket.trim() && project ? normalizeKey(project, draft.ticket) : undefined;
		if (draft.ticket.trim() && !key) {
			if (project?.tracker === 'none') return setMessage(`✗ ${draft.project} has no ticket tracker; set one on the projects screen (P)`);
			return setMessage(`✗ Not a ${project?.tracker === 'github' ? 'GitHub issue number' : 'Jira key'}: ${draft.ticket.trim()}`);
		}
		const fields = { ...draft, title, base: draft.base.trim() || undefined, ...withPriority(draft.priority) };
		if (key === thread.ticket?.key) {
			board.updateThread(thread.id, { ...fields, ticket: thread.ticket });
			setChanges(null);
			return setMessage(`Saved #${thread.id}`);
		}
		setWorking('saving');
		(async () => {
			const ticket = key && project ? { key, url: await ticketUrl(project, key).catch(() => '') } : undefined;
			// The branch is named after the ticket (see branchName), so follow it while that's still safe.
			const renamed = project && thread.branch ? await renameBranch(project.path, { ...thread, title, ticket }) : {};
			board.updateThread(thread.id, { ...fields, ticket, ...(renamed.branch ? { branch: renamed.branch } : {}) });
			setChanges(null);
			// "Renamed…" or "⚠ Kept…" says it was saved too.
			setMessage(renamed.message ?? `Saved #${thread.id}`);
		})()
			.catch((err: unknown) => setMessage(`✗ ${errorMessage(err)}`))
			.finally(() => setWorking(null));
	};

	const close = () => onClose(changes ? `⚠ Didn't save the changes to #${thread.id}` : '');

	const writePlan = () => {
		setWorking('editing plan');
		editPlan(thread.plan, `#${thread.id} ${thread.title}`)
			.then(plan => {
				if (plan === thread.plan) return setMessage('Plan unchanged');
				board.updateThread(thread.id, { plan });
				setMessage(`Saved #${thread.id}'s plan`);
			})
			.catch((err: unknown) => setMessage(`✗ ${errorMessage(err)}`))
			.finally(() => setWorking(null));
	};

	/** The Overview's form keys, once fieldKey has passed one on. */
	const formKey = (input: string, key: Key) => {
		const name = FIELDS[field]!;
		if (isSubmit(input, key, edit)) return save(draft);
		const move = fieldStep(input, key);
		if (move) return setField(loop(field, move, FIELDS.length));
		if (key.return) {
			const next = nextField(field, FIELDS.length, i => (TEXT_FIELDS.includes(FIELDS[i]!) ? draft[FIELDS[i] as 'title'].length : undefined));
			setField(next.field);
			return setEdit(next.edit);
		}
		// h/l change tabs here as everywhere else, so a choice turns with ←/→ and space.
		const delta = input === 'h' || input === 'l' ? 0 : choiceStep(input, key);
		if (!delta || TEXT_FIELDS.includes(name)) return;
		const step = <T,>(choices: readonly T[], current: T) => choices[loop(choices.indexOf(current), delta, choices.length)]!;
		if (name === 'color') return setDraft({ ...draft, color: step(COLOR_CHOICES, draft.color) });
		if (name === 'priority') return setDraft({ ...draft, priority: step(PRIORITIES, draft.priority) });
		return setDraft({ ...draft, project: step(state.projects.map(p => p.name), draft.project) });
	};

	useInput(
		(input, key) => {
			if (working) return;
			setMessage('');
			const name = FIELDS[field]!;
			if (tab === 'overview' && TEXT_FIELDS.includes(name)) {
				const text = name as 'title' | 'ticket' | 'base';
				const next = fieldKey(draft[text], edit, input, key);
				if (next) {
					setEdit(next.edit);
					return setDraft({ ...draft, [text]: next.value });
				}
			}
			setEdit(null);
			if (isBack(input, key, edit)) return close();
			const index = DETAIL_TABS.indexOf(tab);
			if (input === 'h' || input === 'l') return setTab(DETAIL_TABS[loop(index, input === 'h' ? -1 : 1, DETAIL_TABS.length)]!);
			if (/^[1-6]$/.test(input)) return setTab(DETAIL_TABS[Number(input) - 1]!);
			if (tab === 'overview') return formKey(input, key);
			if (tab === 'plan' && key.return) return writePlan();
		},
		{ isActive: active },
	);

	const todos = thread.todos ?? [];
	const unheard = undelivered(thread.inbox).length;
	const labels: Record<DetailTab, string> = {
		overview: '1 overview',
		plan: '2 plan',
		steps: `3 steps${todos.length ? ` ${todoProgress(todos)}` : ''}`,
		messages: `4 messages${thread.inbox?.length ? ` ${thread.inbox.length}` : ''}${unheard ? ` (${unheard} new)` : ''}`,
		quiz: `5 quiz${thread.quiz ? ` ${thread.quiz.score}` : ''}`,
		info: '6 info',
	};
	const fitted = fitTabs(
		DETAIL_TABS.map(t => labels[t]),
		width,
	);
	const project = state.projects.find(p => p.name === thread.project);
	const tabRow = (draw: (label: string) => string) => (
		<Text wrap="truncate">
			{DETAIL_TABS.map((t, i) => (
				<Text key={t} color={t === tab ? 'cyan' : undefined} dimColor={t !== tab} bold={t === tab}>
					{draw(fitted[i]!)}
				</Text>
			))}
		</Text>
	);

	const scroll = (children: ReactNode, start?: (lines: number) => number) => (
		<Scroller key={tab} active={active && !working} start={start}>
			{children}
		</Scroller>
	);
	const body = () => {
		switch (tab) {
			case 'overview':
				return <Overview board={board} state={state} thread={thread} draft={draft} field={field} edit={edit} merge={merge} />;
			case 'plan':
				return scroll(thread.plan ? <Text>{thread.plan}</Text> : <Text dimColor>No plan yet — ⏎ writes one</Text>);
			case 'steps':
				return scroll(
					todos.length ? (
						todos.map((todo, i) => <TodoRow key={i} todo={todo} index={i} width={String(todos.length).length} merged={merged(thread)} />)
					) : (
						<Text dimColor>No steps yet — claude sets them with oo thread todo</Text>
					),
					// Opens with the current step in view.
					lines => todoWindow(todos, lines).start,
				);
			case 'messages':
				return scroll(<Messages thread={thread} />);
			case 'quiz':
				return scroll(
					thread.quiz ? (
						<>
							<Text>
								<Text color={thread.quiz.result === 'passed' ? 'green' : thread.quiz.result === 'overridden' ? 'yellow' : 'red'} bold>
									{thread.quiz.score} {thread.quiz.result === 'overridden' ? 'failed, PR opened anyway' : thread.quiz.result}
								</Text>
								<Text dimColor> · {new Date(thread.quiz.at).toLocaleString()}</Text>
							</Text>
							<QuizReview quiz={thread.quiz.questions as Quiz} answers={thread.quiz.answers} grades={thread.quiz.grades} />
						</>
					) : (
						<Text dimColor>No pop quiz yet — one runs when its PR opens from the board</Text>
					),
				);
			case 'info':
				return scroll(<Info thread={thread} />);
		}
	};

	const editing = typeof edit === 'number';
	const fieldName = FIELDS[field]!;
	const keys =
		tab === 'overview'
			? editing
				? EDITING_HELP
				: `${TEXT_FIELDS.includes(fieldName) ? FIELD_HELP : '←/→ change'}  j/k field  a save  h/l 1-6 tab  q/esc close`
			: `${tab === 'plan' ? '⏎ edit in $EDITOR  ' : ''}j/k scroll  h/l 1-6 tab  q/esc close`;

	return (
		<Box flexDirection="column" flexGrow={1} overflow="hidden">
			<Text bold wrap="truncate">
				#{thread.id} <Text color={thread.color ?? project?.color}>{project?.abbrev || thread.project}</Text> {thread.title}
			</Text>
			{tabRow(label => `╭${'─'.repeat(label.length + TAB_FRAME - 2)}╮`)}
			{tabRow(label => `│ ${label} │`)}
			<Box flexDirection="column" flexGrow={1} borderStyle="round" borderDimColor paddingX={1} overflow="hidden">
				{body()}
			</Box>
			<Text color={messageColor(message)}>{working ? `… ${working}` : message || (changes ? '⚠ Unsaved changes: a saves them' : '')}</Text>
			<Text dimColor wrap="truncate">
				{keys}
			</Text>
		</Box>
	);
}

/** The editable fields, then what the thread's up to: where it is, its claude, ticket, PR and what it waits on. */
function Overview({ board, state, thread: t, draft, field, edit, merge }: { board: Board; state: State; thread: Thread; draft: Draft; field: number; edit: Edit; merge: PrStatus | undefined }) {
	const project = state.projects.find(p => p.name === draft.project);
	const value = (name: Field, focused: boolean) => {
		const choice = (text: string, color?: string) => <Text color={color}>{focused ? `‹ ${text} ›` : text}</Text>;
		if (name === 'project') return choice(draft.project, project?.color);
		if (name === 'priority') return choice(draft.priority, PRIORITY_COLORS[draft.priority]);
		if (name === 'color') return draft.color ? choice(draft.color, draft.color) : choice(`project's (${project?.color ?? '?'})`, project?.color);
		return <FieldText value={draft[name]} edit={focused ? edit : null} />;
	};
	const live = board.liveWindows().has(threadWindowName(t.id));
	const status = board.statuses()[t.id];
	const claude: [string, string | undefined] = live
		? (STATUS_LABELS[status!] ?? ['open, no activity yet', undefined])
		: resumeId(t)
			? stalled(board, t)
				? ['closed mid-work (w wakes it)', 'red']
				: ['closed, resumable', undefined]
			: ['not started', undefined];
	const local = t.local ? (inCheckout(state.projects.find(p => p.name === t.project), t) ? ', checked out in the project' : t.forwarded ? ', its ports forwarded' : '') : '';
	const label = merge && mergeLabel(merge);
	const byId = (id: string) => state.threads.find(x => x.id === id);
	const waits = blockers(state, t);
	const stacked = t.stackedOn ? byId(t.stackedOn) : undefined;
	const ports = portsText(knownPorts.get(containerName(t)));
	const now = Date.now();
	const rows: [string, ReactNode][] = [
		['column', `${COLUMN_LABELS[t.column]}${t.local ? ` (in ${LOCAL_LABEL}${local})` : ''}`],
		['claude', <Text color={claude[1]}>{claude[0]}</Text>],
		...(t.ticket
			? [
					[
						'ticket',
						<Text>
							{t.ticket.url || t.ticket.key}
							{t.ticket.author ? <Text dimColor> by {t.ticket.author}</Text> : null}
							{t.ticket.outsider ? <Text color="yellow"> (from outside the repo's team)</Text> : null}
						</Text>,
					] as [string, ReactNode],
				]
			: []),
		...(t.pr
			? [
					[
						'PR',
						<Text>
							#{t.pr.number} {label ? <Text color={label[1]}>{label[0]}</Text> : null} <Text dimColor>{t.pr.url}</Text>
						</Text>,
					] as [string, ReactNode],
				]
			: []),
		...(waits.length ? [['blocked by', <Text color="red">{waits.map(b => `#${b.id} ${b.title}`).join(', ')}</Text>] as [string, ReactNode]] : []),
		...(t.stackedOn ? [['stacked on', `#${t.stackedOn}${stacked ? ` ${stacked.title}` : ''}`] as [string, ReactNode]] : []),
		...(t.rebaseFrom ? [['rebase', <Text color="yellow">pending: what it was stacked on merged, u rebases its own commits</Text>] as [string, ReactNode]] : []),
		...(ports ? [['ports', <Text color="cyan">{ports}</Text>] as [string, ReactNode]] : []),
		['age', `created ${shortDuration(now - Date.parse(t.createdAt))} ago, changed ${shortDuration(now - Date.parse(t.updatedAt))} ago`],
	];
	return (
		<Box flexDirection="column" overflow="hidden">
			{FIELDS.map((name, i) => {
				const focused = i === field;
				return (
					<Text key={name} wrap="truncate">
						<Text dimColor={!focused}>
							{focused ? '› ' : '  '}
							{`${FIELD_LABELS[name]}:`.padEnd(LABEL_WIDTH)}
						</Text>
						{value(name, focused)}
					</Text>
				);
			})}
			<Box flexDirection="column" marginTop={1}>
				{rows.map(([name, v]) => (
					<Text key={name} wrap="truncate">
						<Text dimColor>{`  ${`${name}:`.padEnd(LABEL_WIDTH)}`}</Text>
						{v}
					</Text>
				))}
			</Box>
		</Box>
	);
}

/** The thread's messages from other threads, oldest first, with whether its claude has heard each yet. */
function Messages({ thread }: { thread: Thread }) {
	const inbox = thread.inbox ?? [];
	if (!inbox.length) return <Text dimColor>No messages — other threads send them with oo thread send</Text>;
	const now = Date.now();
	return (
		<>
			{inbox.map((m, i) => (
				<Box key={i} flexDirection="column" marginBottom={1}>
					<Text>
						<Text bold>from {senderLabel(m.from)}</Text>
						<Text dimColor> · {shortDuration(now - Date.parse(m.ts))} ago · </Text>
						{m.delivered ? <Text dimColor>delivered</Text> : <Text color="cyan">waiting for its claude</Text>}
					</Text>
					<Text>{m.text}</Text>
				</Box>
			))}
		</>
	);
}

/** Where the thread's work and claude live, and the messages drafted for its commit and PR. */
function Info({ thread: t }: { thread: Thread }) {
	const worktree = t.cwd ? undefined : `${worktreePath(t)}${hasWorktree(t) ? '' : ' (not created)'}`;
	const use = t.transcriptPath ? contextUse(t.transcriptPath) : undefined;
	const rows = [
		['branch', t.branch],
		['base', t.base],
		['worktree', worktree],
		['directory', t.cwd],
		['session', t.sessionId],
		['transcript', t.transcriptPath],
		['context', use && describeContext(use, Date.now())],
		['commit draft', t.drafts?.commit],
		['PR draft', t.drafts?.pr && `${t.drafts.pr.title}\n\n${t.drafts.pr.body}`.trim()],
		['created', new Date(t.createdAt).toLocaleString()],
		['updated', new Date(t.updatedAt).toLocaleString()],
	].filter((row): row is [string, string] => !!row[1]);
	return (
		<>
			{rows.map(([name, v]) => (
				<Box key={name}>
					<Box width={LABEL_WIDTH + 2} flexShrink={0}>
						<Text dimColor>{name}:</Text>
					</Box>
					<Text>{v}</Text>
				</Box>
			))}
		</>
	);
}

/**
 * A tab's text, scrolled a line at a time (j/k, the arrows), a page at a time (space/b), to the ends (g/G) or with
 * the wheel. `start` places it once there's a height to place it in (the current step, for Steps).
 */
function Scroller({ active, start, children }: { active: boolean; start?: (lines: number) => number; children: ReactNode }) {
	const space = useRef<DOMElement>(null);
	const content = useRef<DOMElement>(null);
	const [lines, setLines] = useState({ space: 0, content: 0 });
	useEffect(() => {
		if (!space.current || !content.current) return;
		const measured = { space: measureElement(space.current).height, content: measureElement(content.current).height };
		if (measured.space !== lines.space || measured.content !== lines.content) setLines(measured);
	});
	const [offset, setOffset] = useState<number | null>(null);
	const last = Math.max(0, lines.content - lines.space);
	const first = Math.min(last, offset ?? (lines.space && start ? start(lines.space) : 0));
	const scrollTo = (to: number) => setOffset(Math.max(0, Math.min(last, to)));
	const page = Math.max(1, lines.space - 1);

	useInput(
		(input, key) => {
			if (input === 'j' || key.downArrow) return scrollTo(first + 1);
			if (input === 'k' || key.upArrow) return scrollTo(first - 1);
			if (input === ' ' || key.pageDown) return scrollTo(first + page);
			if (input === 'b' || key.pageUp) return scrollTo(first - page);
			if (input === 'g') return scrollTo(0);
			if (input === 'G') return scrollTo(last);
		},
		{ isActive: active },
	);

	const onMouse = ({ button }: MouseEvent) => {
		if (!active) return;
		if (button === 'wheelDown') scrollTo(first + WHEEL_LINES);
		if (button === 'wheelUp') scrollTo(first - WHEEL_LINES);
	};
	const onMouseRef = useRef(onMouse);
	onMouseRef.current = onMouse;
	useEffect(() => {
		const listener = (event: MouseEvent) => onMouseRef.current(event);
		mouse.on('press', listener);
		return () => void mouse.off('press', listener);
	}, []);

	return (
		<Box ref={space} flexGrow={1} flexBasis={0} overflow="hidden">
			<Box flexGrow={1} flexDirection="column" overflow="hidden">
				<Box ref={content} flexDirection="column" flexShrink={0} marginTop={-first}>
					{children}
				</Box>
			</Box>
			{last > 0 ? <ScrollBar total={lines.content} first={first} shown={lines.space} height={lines.space} /> : null}
		</Box>
	);
}
