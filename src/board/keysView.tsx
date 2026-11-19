import { useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { KEY_SECTIONS } from '../keys.js';
import { TabBar } from '../tabBar.js';
import { LEGEND } from './card.js';
import { Scroller } from './scrollList.js';

const TABS = ['keys', 'legend'] as const;

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

/**
 * The `?` screen, in two tabs (h/l): every key, a section per box, as many side by side as fit, and what the
 * cards' marks mean. Either scrolls when it doesn't fit (see Scroller).
 */
export function KeysView({ active }: { active: boolean }) {
	const { columns: width } = useWindowSize();
	const [tab, setTab] = useState<(typeof TABS)[number]>('keys');
	useInput(
		(input, key) => {
			if (input === 'h' || input === 'l' || key.leftArrow || key.rightArrow) setTab(tab === 'keys' ? 'legend' : 'keys');
		},
		{ isActive: active },
	);

	return (
		<Box flexGrow={1} overflow="hidden" flexDirection="column">
			<TabBar labels={[...TABS]} current={TABS.indexOf(tab)} />
			<Text dimColor>{`h/l tab · j/k space/b g/G scroll · ? / q / esc close${tab === 'keys' ? ' · also in KEYS.md' : ''}`}</Text>
			<Scroller key={tab} active={active}>
				{tab === 'legend' ? (
					<Box marginTop={1}>
						<Legend width={width - 2} />
					</Box>
				) : (
					<Box flexWrap="wrap">
						{KEY_SECTIONS.map(section => {
							const keyWidth = Math.max(...section.keys.map(([k]) => k.length)) + 2;
							return (
								<Box key={section.title} flexDirection="column" width={48} marginTop={1} marginRight={2}>
									<Text bold color="cyan">
										{section.title}
									</Text>
									{section.keys.map(([k, what]) => (
										<Box key={k}>
											<Box width={keyWidth} flexShrink={0}>
												<Text>{k}</Text>
											</Box>
											<Text dimColor>{what}</Text>
										</Box>
									))}
								</Box>
							);
						})}
					</Box>
				)}
			</Scroller>
		</Box>
	);
}
