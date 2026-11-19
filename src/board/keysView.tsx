import { useEffect, useRef, useState } from 'react';
import { Box, Text, measureElement, useInput, useWindowSize, type DOMElement } from 'ink';
import { KEY_SECTIONS } from '../keys.js';
import { mouse, type MouseEvent } from '../mouse.js';
import { TAB_FRAME } from '../viewerModel.js';
import { LEGEND } from './card.js';
import { ScrollBar } from './scrollList.js';

// Lines the wheel scrolls at a time.
const WHEEL_LINES = 3;

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
 * cards' marks mean. When a tab doesn't fit it scrolls a line at a time (j/k, the arrows), a page at a time
 * (space/b) or with the wheel.
 */
export function KeysView({ active }: { active: boolean }) {
	const { columns: width } = useWindowSize();
	const [tab, setTab] = useState<(typeof TABS)[number]>('keys');
	// The space it has and the sections' height there, measured after each render.
	const space = useRef<DOMElement>(null);
	const content = useRef<DOMElement>(null);
	const [lines, setLines] = useState({ space: 0, content: 0 });
	useEffect(() => {
		if (!space.current || !content.current) return;
		const measured = { space: measureElement(space.current).height, content: measureElement(content.current).height };
		if (measured.space !== lines.space || measured.content !== lines.content) setLines(measured);
	});
	const [offset, setOffset] = useState(0);
	const last = Math.max(0, lines.content - lines.space);
	const first = Math.min(offset, last);
	const scrollBy = (delta: number) => setOffset(Math.max(0, Math.min(last, first + delta)));

	useInput(
		(input, key) => {
			if (input === 'j' || key.downArrow) return scrollBy(1);
			if (input === 'k' || key.upArrow) return scrollBy(-1);
			if (input === ' ' || key.pageDown) return scrollBy(Math.max(1, lines.space - 1));
			if (input === 'b' || key.pageUp) return scrollBy(-Math.max(1, lines.space - 1));
			if (input === 'h' || input === 'l' || key.leftArrow || key.rightArrow) {
				setOffset(0);
				return setTab(tab === 'keys' ? 'legend' : 'keys');
			}
		},
		{ isActive: active },
	);

	const onMouse = ({ button }: MouseEvent) => {
		if (!active) return;
		if (button === 'wheelDown') scrollBy(WHEEL_LINES);
		if (button === 'wheelUp') scrollBy(-WHEEL_LINES);
	};
	const onMouseRef = useRef(onMouse);
	onMouseRef.current = onMouse;
	useEffect(() => {
		const listener = (event: MouseEvent) => onMouseRef.current(event);
		mouse.on('press', listener);
		return () => void mouse.off('press', listener);
	}, []);

	const tabRow = (draw: (label: string) => string) => (
		<Text wrap="truncate">
			{TABS.map(t => (
				<Text key={t} color={t === tab ? 'cyan' : undefined} dimColor={t !== tab} bold={t === tab}>
					{draw(t)}
				</Text>
			))}
		</Text>
	);

	return (
		<Box flexGrow={1} overflow="hidden" flexDirection="column">
			{tabRow(label => `╭${'─'.repeat(label.length + TAB_FRAME - 2)}╮`)}
			{tabRow(label => `│ ${label} │`)}
			<Text dimColor>{`h/l tab · ${last > 0 ? 'j/k space/b scroll · ' : ''}? / q / esc close${tab === 'keys' ? ' · also in KEYS.md' : ''}`}</Text>
			<Box ref={space} flexGrow={1} flexBasis={0} overflow="hidden">
				<Box flexGrow={1} flexDirection="column" overflow="hidden">
					<Box ref={content} flexWrap="wrap" flexShrink={0} marginTop={-first}>
						{tab === 'legend' ? (
							<Box marginTop={1}>
								<Legend width={width - 2} />
							</Box>
						) : null}
						{(tab === 'keys' ? KEY_SECTIONS : []).map(section => {
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
				</Box>
				{last > 0 ? <ScrollBar total={lines.content} first={first} shown={lines.space} height={lines.space} /> : null}
			</Box>
		</Box>
	);
}
