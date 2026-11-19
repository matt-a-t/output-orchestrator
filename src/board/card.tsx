import { memo } from 'react';
import { Box, Text } from 'ink';
import { mergeLabel, type PrStatus } from '../prHost.js';
import { PRIORITY_COLORS, PRIORITY_MARKS, type Column, type Project, type Thread } from '../state.js';
import type { Status } from '../status.js';
import { followUps, nextTodo, planLine, preMergeDone, todoProgress, todosDone, undelivered } from '../threads.js';
import { formatTokens, LARGE_CONTEXT } from '../transcripts.js';

/** A mark, its colour and what it means. */
type LegendEntry = [mark: string, color: string | undefined, meaning: string];

// The status badge for a thread's claude: its window's status while one is open, else whether it can be resumed.
const CLAUDE_STATES = {
	working: ['●', 'yellow', 'working'],
	waiting: ['‖', 'red', 'needs you'],
	stopped: ['✓', 'green', 'stopped'],
	open: ['○', 'gray', 'open, no activity yet'],
	resumable: ['↻', 'gray', 'closed, resumable'],
	stalled: ['↻', 'red', 'closed mid-work, w wakes it'],
	none: [' ', undefined, 'not started'],
} satisfies Record<string, LegendEntry>;

/** Its claude's badge, colour and what that means, as the card and the details show it. */
export function claudeState(live: boolean, status: Status | undefined, resumable: boolean, stalled: boolean): LegendEntry {
	if (live) return status === 'working' || status === 'waiting' || status === 'stopped' ? CLAUDE_STATES[status] : CLAUDE_STATES.open;
	return resumable ? (stalled ? CLAUDE_STATES.stalled : CLAUDE_STATES.resumable) : CLAUDE_STATES.none;
}

export const LEGEND: LegendEntry[] = [
	...Object.values(CLAUDE_STATES).filter(entry => entry !== CLAUDE_STATES.none),
	['±', 'magenta', 'changes to review'],
	['⚡', 'red', 'PR has conflicts'],
	['✎2', 'cyan', 'messages from other threads, told when claude stops'],
	['⧗2', 'red', 'blocked by this many threads (B)'],
	['⤳2', 'blue', 'after-merge checkpoints left, and the next'],
	['3/5 ▸', undefined, 'steps done, and the next'],
	['●', 'magenta', 'a step waiting for you to review it'],
	['commit✓ pr✓', 'green', 'commit and PR messages drafted'],
	['3d', undefined, 'unchanged this long'],
	['↺', 'yellow', 'what it was stacked on merged: u rebases it'],
	['→', 'green', 'ready for the next column'],
	['▲', 'red', 'high priority (!)'],
	['▽', 'gray', 'low priority (!)'],
	['►', 'green', 'one of its commands is running (r)'],
	['⟳', 'cyan', 'busy in the background (Local, waking)'],
	['⇄', 'cyan', "its container's ports are on localhost"],
	['379k', undefined, 'context to resend (yellow: large, ~: compacted)'],
	['42m warm', 'green', 'cache warm this long: resume before then for less'],
];

// The columns and the import list start below the title bar, a header and a rule.
export const LIST_TOP = 3;
/**
 * The narrowest a column gets: room for the longest first line a card can have (headMarks, with a three-digit id
 * and one-digit counts), its Local outline and the space between columns. card.test.ts checks it.
 */
export const MIN_COLUMN_WIDTH = 22;
// Each card is four lines (badges, title, what's next, context), or one in Done and Archived so more of them fit.
const CARD_HEIGHT = 4;
// The blank line under each four-line card, so they don't run together.
export const CARD_GAP = 1;
const oneLiner = (column: Column) => column === 'done' || column === 'archived';
export const cardHeight = (column: Column) => (oneLiner(column) ? 1 : CARD_HEIGHT);
/** The lines a card takes up in its column, with the gap under it. */
export const rowLines = (column: Column) => cardHeight(column) + (oneLiner(column) ? 0 : CARD_GAP);
// A thread in Local stays in its column, its card outlined in yellow, which takes a line above and below.
export const LOCAL_BORDER_LINES = 2;
export const cardLines = (t: Thread) => rowLines(t.column) + (t.local ? LOCAL_BORDER_LINES : 0);

export type CardProps = Props;
type Props = {
	thread: Thread;
	selected: boolean;
	project: Project | undefined;
	// Whether its claude window is open.
	live: boolean;
	status: Status | undefined;
	// Whether it can be resumed, and whether it was closed mid-work, for when its window isn't open.
	resumable: boolean;
	stalled: boolean;
	unreviewed: boolean;
	merge: PrStatus | undefined;
	// The unfinished threads it waits on (see blockers).
	blockers: Thread[];
	// Whether one of its project's commands is running for it (r).
	running: boolean;
	// What it's doing in the background (see jobs.ts), e.g. `leaving Local`.
	job?: string;
	// Its container's published ports (portsText), if it has any.
	ports: string;
	// The context its claude carries (tokens), and how long its cache stays warm (e.g. 42m), if it does.
	tokens: number | undefined;
	warmFor: string | undefined;
	// Whether tokens is a guess, from a compacted conversation's summary.
	compacted: boolean;
	// How long since it last changed, once it's been a day (staleAge).
	age: string | undefined;
};

/** A thread's four lines on the board and the gap under them (one line in Done), outlined in yellow while it's in Local. */
export const Card = memo(CardLines, sameCard);

/**
 * Whether a redraw would draw the card the same. Every prop but `blockers` keeps its identity while unchanged;
 * blockers is worked out afresh on each render, so compare the threads in it.
 */
export function sameCard(a: Props, b: Props): boolean {
	for (const key of Object.keys(b) as (keyof Props)[]) if (key !== 'blockers' && a[key] !== b[key]) return false;
	return a.blockers.length === b.blockers.length && a.blockers.every((t, i) => t === b.blockers[i]);
}

type Mark = { text: string; color?: string; bold?: boolean; dim?: boolean };

/**
 * A card's first line: its status badge, #id and its alerts, one glyph each and packed together (their colours
 * tell them apart), so even a narrow column shows them all (see MIN_COLUMN_WIDTH).
 */
export function headMarks({ thread: t, live, status, resumable, stalled, unreviewed, merge, blockers, running, job, ports }: Props): Mark[] {
	const [badge, badgeColor] = claudeState(live, status, resumable, stalled);
	// Changes aren't ready to review until claude stops working on them.
	const working = live && status === 'working';
	const messages = undelivered(t.inbox).length;
	const marks: (Mark | false | undefined)[] = [
		{ text: `${badge} `, color: badgeColor },
		{ text: `#${t.id} `, bold: true },
		!!t.priority && { text: PRIORITY_MARKS[t.priority], color: PRIORITY_COLORS[t.priority], bold: t.priority === 'high' },
		running && { text: '►', color: 'green' },
		// Busy in the background (see jobs.ts): leaving Local, waking. Line 3 says with what.
		!!job && { text: '⟳', color: 'cyan' },
		!!ports && { text: '⇄', color: 'cyan' },
		unreviewed && !working && { text: '±', color: 'magenta', bold: true },
		blockers.length > 0 && { text: `⧗${blockers.length}`, color: 'red', bold: true },
		merge?.mergeable === 'CONFLICTING' && { text: '⚡', color: 'red', bold: true },
		// Messages from other threads its claude hasn't heard yet.
		messages > 0 && { text: `✎${messages}`, color: 'cyan', bold: true },
		// The thread it was stacked on merged, so u rebases its own commits onto the base.
		!!t.rebaseFrom && { text: '↺', color: 'yellow', bold: true },
		readyToMove(t) && { text: '→', color: 'green', bold: true },
	];
	return marks.filter((m): m is Mark => !!m);
}

const DAY = 24 * 60 * 60 * 1000;

/** How long since the thread last changed (3d), once that's a day or more; nothing before then. */
export function staleAge(updatedAt: string, now: number): string | undefined {
	const days = Math.floor((now - Date.parse(updatedAt)) / DAY);
	return days >= 1 ? `${days}d` : undefined;
}

export const QUIZ_COLORS = { passed: 'green', overridden: 'yellow', failed: 'red' } as const;

/** Done, in green, or still to come, dimmed: one of Polish's drafts or the quiz. */
const ready = (label: string, done: boolean): Mark => (done ? { text: `${label}✓`, color: 'green' } : { text: label, dim: true });

/** A card's third line: what moves the thread on from its column, or what it's busy with in the background (job). */
export function nextLine(t: Thread, merge: PrStatus | undefined, job?: string): Mark[] {
	if (job) return [{ text: `⟳ ${job}`, color: 'cyan' }];
	const todos = t.todos ?? [];
	switch (t.column) {
		case 'ideas':
		case 'planned':
			return t.plan ? [{ text: planLine(t.plan), dim: true }] : [];
		case 'active': {
			if (!todos.length) return [];
			// The step handed over for review comes first: it's what's waiting on you.
			const review = todos.find(todo => todo.status === 'review');
			const next = review ?? todos[nextTodo(todos, false)];
			return [
				{ text: `${todoProgress(todos)} `, dim: !review },
				...(next ? [review ? { text: '● ', color: 'magenta', bold: true } : { text: '▸ ', dim: true }, { text: next.subject }] : []),
			];
		}
		case 'polish': {
			const quiz = t.quiz ? { text: `quiz ${t.quiz.score}`, color: QUIZ_COLORS[t.quiz.result] } : { text: 'quiz', dim: true };
			return [ready('commit', !!t.drafts?.commit), { text: ' ' }, ready('pr', !!t.drafts?.pr), { text: ' ' }, quiz];
		}
		case 'pr': {
			if (!t.pr) return [];
			const label = merge && mergeLabel(merge);
			return [{ text: `#${t.pr.number}`, bold: true }, ...(label ? [{ text: ` ${label[0]}`, color: label[1] }] : [])];
		}
		case 'followup': {
			// Merged with steps still to do (deploying, checking prod): how many, and the next.
			const left = followUps(t.todos);
			return left.length ? [{ text: `⤳${left.length} `, color: 'blue', bold: true }, { text: left[0]!.subject }] : [];
		}
		default:
			return [];
	}
}

/** Every step before the merge approved in Active (on to Polish), or every step done in Follow-up (on to Done). */
const readyToMove = (t: Thread) =>
	(t.column === 'active' && preMergeDone(t.todos)) || (t.column === 'followup' && !followUps(t.todos).length && todosDone(t.todos));

function CardLines(props: Props) {
	const { thread: t, selected, project, merge, blockers, job, tokens, warmFor, compacted, age } = props;
	const oneLine = cardHeight(t.column) === 1;
	const color = t.color ?? project?.color;
	// A blocked thread's title is dimmed, so the threads that can go on stand out.
	const title = (
		<>
			<Text color={color}>{project?.abbrev || t.project} </Text>
			{t.ticket ? <Text color="blue">{t.ticket.key} </Text> : null}
			<Text dimColor={blockers.length > 0}>{t.title}</Text>
		</>
	);
	return (
		// The gap is a margin, so it's outside the Local outline.
		<Box flexDirection="column" marginBottom={oneLine ? 0 : CARD_GAP} {...(t.local ? { borderStyle: 'round', borderColor: 'yellow' } : {})}>
			{/* Never truncated: MIN_COLUMN_WIDTH leaves room for every mark a card in its column can have. */}
			<Text wrap="truncate" inverse={selected}>
				{headMarks(props).map((m, i) => (
					<Text key={i} color={m.color} bold={m.bold}>
						{m.text}
					</Text>
				))}
				{/* Finished threads get one line each so more of them fit. */}
				{oneLine ? ' ' : null}
				{oneLine ? title : null}
			</Text>
			{oneLine ? null : (
				<Text wrap="truncate" inverse={selected}>
					{'  '}
					{title}
				</Text>
			)}
			{/* What moves it on from its column, and how long it's sat there once that's a day; the age stays when the rest truncates. */}
			{oneLine ? null : (
				<Box>
					<Box flexShrink={1}>
						<Text wrap="truncate" inverse={selected}>
							{'  '}
							{nextLine(t, merge, job).map((m, i) => (
								<Text key={i} color={m.color} bold={m.bold} dimColor={m.dim}>
									{m.text}
								</Text>
							))}
						</Text>
					</Box>
					{age ? (
						<Box flexShrink={0}>
							<Text dimColor inverse={selected}>
								{` ${age}`}
							</Text>
						</Box>
					) : null}
				</Box>
			)}
			{/* How much its claude would resend, and how long that stays cheap; blank without one, so every card is the same height. */}
			{oneLine ? null : (
				<Text wrap="truncate" inverse={selected}>
					{'  '}
					{tokens !== undefined ? (
						<Text color={tokens >= LARGE_CONTEXT ? 'yellow' : undefined} dimColor={tokens < LARGE_CONTEXT}>
							{`${compacted ? '~' : ''}${formatTokens(tokens)}`}
						</Text>
					) : null}
					{tokens !== undefined && warmFor ? <Text dimColor> · </Text> : null}
					{warmFor ? <Text color="green">{`${warmFor} warm`}</Text> : null}
				</Text>
			)}
		</Box>
	);
}
