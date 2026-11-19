import { memo } from 'react';
import { Box, Text } from 'ink';
import type { PrStatus } from '../prHost.js';
import { PRIORITY_COLORS, PRIORITY_MARKS, type Column, type Project, type Thread } from '../state.js';
import type { Status } from '../status.js';
import { followUps, preMergeDone, todosDone, undelivered } from '../threads.js';
import { formatTokens, LARGE_CONTEXT } from '../transcripts.js';

const BADGES: Partial<Record<Status, [string, string]>> = {
	working: ['●', 'yellow'],
	waiting: ['‖', 'red'],
	stopped: ['✓', 'green'],
};

export const LEGEND: [string, string | undefined, string][] = [
	['●', 'yellow', 'working'],
	['‖', 'red', 'needs you'],
	['✓', 'green', 'stopped'],
	['○', 'gray', 'open, no activity yet'],
	['↻', 'gray', 'closed, resumable'],
	['↻', 'red', 'closed mid-work, w wakes it'],
	['±', 'magenta', 'changes to review'],
	['⚡', 'red', 'PR has conflicts'],
	['✎', 'cyan', 'messages from other threads, told when claude stops'],
	['⧗', 'red', 'blocked by another thread (B)'],
	['⤳', 'blue', 'after-merge checkpoints left'],
	['▲', 'red', 'high priority (!)'],
	['▽', 'gray', 'low priority (!)'],
	['►', 'green', 'one of its commands is running (r)'],
	['⇄3000→49153', 'cyan', "its container's port 3000 is on localhost:49153"],
	['379k', undefined, 'context to resend (yellow: large, ~: compacted)'],
	['42m warm', 'green', 'cache warm this long: resume before then for less'],
];

// The columns and the import list start below the title bar, a header and a rule.
export const LIST_TOP = 3;
// Each card is three lines (badges, title, context), or one in Done and Archived so more of them fit.
const CARD_HEIGHT = 3;
// The blank line under each three-line card, so they don't run together.
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
	// Its container's published ports (portsText), if it has any.
	ports: string;
	// The context its claude carries (tokens), and how long its cache stays warm (e.g. 42m), if it does.
	tokens: number | undefined;
	warmFor: string | undefined;
	// Whether tokens is a guess, from a compacted conversation's summary.
	compacted: boolean;
};

/** A thread's three lines on the board and the gap under them (one line in Done), outlined in yellow while it's in Local. */
export const Card = memo(CardLines, sameCard);

/**
 * Whether a redraw would draw the card the same. Every prop but `blockers` keeps its identity while unchanged;
 * blockers is worked out afresh on each render, so compare the threads in it.
 */
export function sameCard(a: Props, b: Props): boolean {
	for (const key of Object.keys(b) as (keyof Props)[]) if (key !== 'blockers' && a[key] !== b[key]) return false;
	return a.blockers.length === b.blockers.length && a.blockers.every((t, i) => t === b.blockers[i]);
}

function CardLines({ thread: t, selected, project, live, status, resumable, stalled, unreviewed, merge, blockers, running, ports, tokens, warmFor, compacted }: Props) {
	const oneLine = cardHeight(t.column) === 1;
	const color = t.color ?? project?.color;
	// Changes aren't ready to review until claude stops working on them.
	const working = live && status === 'working';
	const [badge, badgeColor] = live ? (BADGES[status!] ?? ['○', 'gray']) : resumable ? ['↻', stalled ? 'red' : 'gray'] : [' ', undefined];
	// A blocked thread's title is dimmed, so the threads that can go on stand out.
	const title = (
		<>
			{t.ticket ? <Text color="blue">{t.ticket.key} </Text> : null}
			<Text dimColor={blockers.length > 0}>{t.title}</Text>
		</>
	);
	return (
		// The gap is a margin, so it's outside the Local outline.
		<Box flexDirection="column" marginBottom={oneLine ? 0 : CARD_GAP} {...(t.local ? { borderStyle: 'round', borderColor: 'yellow' } : {})}>
			<Text wrap="truncate" inverse={selected}>
				<Text color={badgeColor}>{badge} </Text>
				<Text bold>#{t.id} </Text>
				<Text color={color}>{project?.abbrev || t.project}</Text>
				{t.priority ? (
					<Text color={PRIORITY_COLORS[t.priority]} bold={t.priority === 'high'}>
						{' '}
						{PRIORITY_MARKS[t.priority]}
					</Text>
				) : null}
				{running ? <Text color="green"> ►</Text> : null}
				{ports ? <Text color="cyan"> ⇄{ports}</Text> : null}
				{unreviewed && !working ? (
					<Text color="magenta" bold>
						{' '}±
					</Text>
				) : null}
				{blockers.length ? (
					<Text color="red" bold>
						{' '}⧗{blockers.map(b => `#${b.id}`).join(',')}
					</Text>
				) : null}
				{merge?.mergeable === 'CONFLICTING' ? (
					<Text color="red" bold>
						{' '}⚡
					</Text>
				) : null}
				{/* Messages from other threads its claude hasn't heard yet. */}
				{undelivered(t.inbox).length ? (
					<Text color="cyan" bold>
						{' '}✎{undelivered(t.inbox).length}
					</Text>
				) : null}
				{/* Every step before the merge approved: ready to move on to Polish and a PR. */}
				{t.column === 'active' && preMergeDone(t.todos) ? (
					<Text color="green" bold>
						{' '}✓ polish
					</Text>
				) : null}
				{/* Merged with steps still to do (deploying, checking prod), or with them all done and ready for Done. */}
				{t.column === 'followup' ? (
					followUps(t.todos).length ? (
						<Text color="blue" bold>
							{' '}⤳{followUps(t.todos).length}
						</Text>
					) : todosDone(t.todos) ? (
						<Text color="green" bold>
							{' '}✓ done
						</Text>
					) : null
				) : null}
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
