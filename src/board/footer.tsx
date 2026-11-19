import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { messageColor } from '../errors.js';

const HELP = 'h/l j/k move  ⏎ open  e details  n new  d diff  M-s shell  q quit';

type Props = {
	busy: string | null;
	message: string;
	// Whether the message is a question waiting on y.
	confirming: boolean;
	width: number;
	hidden: boolean;
	// Whatever is being asked for (the `n` flow's prompts), above the message.
	children?: ReactNode;
};

/** Below the board: whatever's being asked for, the message line and the help line. */
export function Footer({ busy, message, confirming, width, hidden, children }: Props) {
	return (
		<Box marginTop={1} flexDirection="column" display={hidden ? 'none' : 'flex'}>
			{children}
			{busy ? (
				<Text color="cyan">{busy}…</Text>
			) : (
				<Text color={messageColor(message, confirming)}>{message}</Text>
			)}
			{/* The way into every other key, kept in the corner so it's always in the same place. */}
			<Box justifyContent="space-between" width={width}>
				<Text dimColor wrap="truncate-end">
					{HELP}
				</Text>
				<Box flexShrink={0} marginLeft={2}>
					<Text dimColor>? keys and legend</Text>
				</Box>
			</Box>
		</Box>
	);
}
