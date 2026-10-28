import { Box, Text } from 'ink';
import type { PrStatus } from '../github.js';
import type { Column, Project, Thread } from '../state.js';
import type { Status } from '../status.js';
import { todosDone, undelivered } from '../threads.js';

const BADGES: Partial<Record<Status, [string, string]>> = {
	working: ['⚙', 'yellow'],
	waiting: ['⏸', 'red'],
	stopped: ['✓', 'green'],
};

export const LEGEND: [string, string | undefined, string][] = [
	['⚙', 'yellow', 'working'],
	['⏸', 'red', 'needs you'],
	['✓', 'green', 'stopped'],
	['○', 'gray', 'open, no activity yet'],
	['↻', 'gray', 'closed, resumable'],
	['↻', 'red', 'closed mid-work, w wakes it'],
	['±', 'magenta', 'changes to review'],
	['⚡', 'red', 'PR has conflicts'],
	['✉', 'cyan', 'messages from other threads, told when claude stops'],
	['⧗', 'red', 'blocked by another thread (B)'],
	['▲', 'red', 'high priority (!)'],
	['▽', 'gray', 'low priority (!)'],
];

// The columns and the import list start below the title bar, a header and a rule.
export const LIST_TOP = 3;
// Each card is two lines, or one in Done.
const CARD_HEIGHT = 2;
export const cardHeight = (column: Column) => (column === 'done' || column === 'archived' ? 1 : CARD_HEIGHT);
// A thread in Local stays in its column, its card outlined in yellow, which takes a line above and below.
export const LOCAL_BORDER_LINES = 2;
export const cardLines = (t: Thread) => cardHeight(t.column) + (t.local ? LOCAL_BORDER_LINES : 0);

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
};

/** A thread's two lines on the board (one in Done), outlined in yellow while it's in Local. */
export function Card({ thread: t, selected, project, live, status, resumable, stalled, unreviewed, merge, blockers }: Props) {
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
		<Box flexDirection="column" {...(t.local ? { borderStyle: 'round', borderColor: 'yellow' } : {})}>
			<Text wrap="truncate" inverse={selected}>
				<Text color={badgeColor}>{badge} </Text>
				<Text bold>#{t.id} </Text>
				<Text color={color}>{project?.abbrev || t.project}</Text>
				{t.priority === 'high' ? (
					<Text color="red" bold>
						{' '}▲
					</Text>
				) : null}
				{t.priority === 'low' ? <Text color="gray"> ▽</Text> : null}
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
						{' '}✉{undelivered(t.inbox).length}
					</Text>
				) : null}
				{/* Every step approved: ready to move on to Polish and a PR. */}
				{t.column === 'active' && todosDone(t.todos) ? (
					<Text color="green" bold>
						{' '}✓ polish
					</Text>
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
		</Box>
	);
}
