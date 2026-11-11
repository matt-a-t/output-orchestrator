import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { messageColor } from '../errors.js';
import { mergeLabel, type PrStatus } from '../prHost.js';
import type { Thread } from '../state.js';
import { LEGEND } from './card.js';
import { TodoList } from './todoList.js';
import { merged as isMerged } from '../threads.js';

// Rows inside the thread's details window, which stays this tall so the board above doesn't jump.
const INFO_HEIGHT = 8;

const HELP = 'h/l j/k move  ⏎ open  n new  d diff  s shell beside claude  q quit';

type Props = {
	// The highlighted thread, unless something covers the board.
	thread: Thread | undefined;
	merge: PrStatus | undefined;
	// The unfinished threads it waits on.
	blockers: Thread[];
	busy: string | null;
	message: string;
	// Whether the message is a question waiting on y.
	confirming: boolean;
	width: number;
	hidden: boolean;
	// Whatever is being asked for (the `n` flow's prompts), between the thread's details and the message.
	children?: ReactNode;
};

/**
 * The start of a plan on one line: its first three non-blank lines, without markdown's heading marks
 * (a "#61" that starts a heading's text stays).
 */
export function planSummary(plan: string): string {
	return plan
		.split('\n')
		.map(line => line.trim().replace(/^#+\s+/, ''))
		.filter(Boolean)
		.slice(0, 3)
		.join(' · ');
}

/** What the cards' badges mean, wrapping only between entries so none is split across lines. */
export function Legend({ width }: { width: number }) {
	return (
		<Box flexWrap="wrap" columnGap={3} width={width}>
			{LEGEND.map(([badge, color, label]) => (
				<Box key={label} flexShrink={0}>
					<Text>
						<Text color={color}>{badge}</Text>
						<Text dimColor> {label}</Text>
					</Text>
				</Box>
			))}
		</Box>
	);
}

/** Below the board: the highlighted thread's details, the message line, the legend and the help line. */
export function Footer({ thread, merge, blockers, busy, message, confirming, width, hidden, children }: Props) {
	const merged = merge && mergeLabel(merge);
	// The one-line details go first, so the todo list is what gives up rows when they're all there.
	const todoLines = INFO_HEIGHT - 1 - (thread?.plan ? 1 : 0) - (thread?.ticket?.url ? 1 : 0) - (thread?.pr ? 1 : 0) - blockers.length;
	return (
		<Box marginTop={1} flexDirection="column" display={hidden ? 'none' : 'flex'}>
			<Box
				flexDirection="column"
				borderStyle="round"
				borderDimColor
				paddingX={1}
				width={width}
				height={INFO_HEIGHT + 2}
				flexShrink={0}
				overflow="hidden"
			>
				{thread ? null : <Text dimColor>no thread selected</Text>}
				{thread?.plan ? (
					<Text dimColor wrap="truncate-end">
						{planSummary(thread.plan)}
					</Text>
				) : null}
				{thread?.ticket?.url ? (
					<Text dimColor wrap="truncate-end">
						{thread.ticket.key} {thread.ticket.url}
					</Text>
				) : null}
				{thread?.pr ? (
					<Text dimColor wrap="truncate-end">
						PR #{thread.pr.number} {thread.pr.url} (b opens it)
						{merged ? <Text color={merged[1]}> — {merged[0]}</Text> : null}
					</Text>
				) : null}
				{blockers.map(b => (
					<Text key={b.id} color="red" dimColor wrap="truncate-end">
						blocked by #{b.id} {b.title}
					</Text>
				))}
				{thread?.todos?.length ? <TodoList todos={thread.todos} lines={todoLines} merged={isMerged(thread)} /> : null}
			</Box>
			{children}
			{busy ? (
				<Text color="cyan">{busy}…</Text>
			) : (
				<Text color={messageColor(message, confirming)}>{message}</Text>
			)}
			<Legend width={width} />
			{/* The way into every other key, kept in the corner so it's always in the same place. */}
			<Box justifyContent="space-between" width={width}>
				<Text dimColor wrap="truncate-end">
					{HELP}
				</Text>
				<Box flexShrink={0} marginLeft={2}>
					<Text dimColor>? all keys</Text>
				</Box>
			</Box>
		</Box>
	);
}
