import type { ReactNode } from 'react';
import { Text } from 'ink';
import { TAB_FRAME } from './viewerModel.js';

type Props = {
	// Already fitted to the width (fitTabs) where they could overflow it.
	labels: string[];
	current: number;
	accent?: string;
	// Drawn after a tab's label, in its frame, `suffixWidth` columns wide (the viewer's file stat).
	suffix?: (i: number) => ReactNode;
	suffixWidth?: (i: number) => number;
};

/** A row of tabs framed on top and at the sides, the current one in colour and the others dim. */
export function TabBar({ labels, current, accent = 'cyan', suffix, suffixWidth = () => 0 }: Props) {
	const row = (draw: (label: string, i: number) => ReactNode) => (
		<Text wrap="truncate">
			{labels.map((label, i) => (
				<Text key={i} color={i === current ? accent : undefined} dimColor={i !== current} bold={i === current}>
					{draw(label, i)}
				</Text>
			))}
		</Text>
	);
	return (
		<>
			{row((label, i) => `╭${'─'.repeat(label.length + suffixWidth(i) + TAB_FRAME - 2)}╮`)}
			{row((label, i) => (
				<>
					{`│ ${label}`}
					{suffix?.(i)}
					{' │'}
				</>
			))}
		</>
	);
}
