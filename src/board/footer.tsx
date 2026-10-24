import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { mergeLabel, type PrStatus } from '../github.js';
import type { Thread } from '../state.js';
import { LEGEND } from './card.js';
import { TodoList } from './todoList.js';

const HELP = 'h/l j/k move  ⏎ open  n new  d diff  s/M-d shell/diff beside claude  q quit';

type Props = {
	// The highlighted thread, unless something covers the board.
	thread: Thread | undefined;
	merge: PrStatus | undefined;
	busy: string | null;
	message: string;
	// Whether the message is a question waiting on y.
	confirming: boolean;
	width: number;
	hidden: boolean;
	// Whatever is being asked for (the `n` flow's prompts), between the thread's details and the message.
	children?: ReactNode;
};

/** Below the board: the highlighted thread's details, the message line, the legend and the help line. */
export function Footer({ thread, merge, busy, message, confirming, width, hidden, children }: Props) {
	const merged = merge && mergeLabel(merge);
	return (
		<Box marginTop={1} flexDirection="column" display={hidden ? 'none' : 'flex'}>
			{thread?.plan ? (
				<Text dimColor wrap="truncate-end">
					{thread.plan.split('\n').slice(0, 3).join(' · ')}
				</Text>
			) : null}
			{thread?.todos?.length ? <TodoList todos={thread.todos} /> : null}
			{thread?.ticket?.url ? (
				<Text dimColor>
					{thread.ticket.key} {thread.ticket.url}
				</Text>
			) : null}
			{thread?.pr ? (
				<Text dimColor>
					PR #{thread.pr.number} {thread.pr.url} (b opens it)
					{merged ? <Text color={merged[1]}> — {merged[0]}</Text> : null}
				</Text>
			) : null}
			{children}
			{busy ? (
				<Text color="cyan">{busy}…</Text>
			) : (
				<Text color={message.startsWith('✗') ? 'red' : confirming || message.startsWith('⚠') ? 'yellow' : 'green'}>{message}</Text>
			)}
			<Text>
				{LEGEND.map(([badge, color, label]) => (
					<Text key={label}>
						<Text color={color}>{badge}</Text>
						<Text dimColor> {label}   </Text>
					</Text>
				))}
			</Text>
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
