// A list in place of the columns that scrolls to keep its selection in view, with a scroll bar:
// j/k and the arrows move (looping), the wheel moves (stopping at the ends), click selects and
// double-click or ⏎ acts on the selected item.

import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { Box, Text, measureElement, useInput, useWindowSize, type DOMElement, type Key } from 'ink';
import { loop } from '../input.js';
import { mouse, type MouseEvent } from '../mouse.js';
import { scrollBar, scrollWindow, TRACK } from '../scroll.js';
import type { Board } from './board.js';
import { LIST_TOP } from './card.js';
import { useDoubleClick } from './doubleClick.js';

/** A one-wide scroll bar `height` lines tall, for lines `first` to `first + shown` of `total`. */
export function ScrollBar({ total, first, shown, height }: { total: number; first: number; shown: number; height: number }) {
	return (
		<Box flexDirection="column" width={1} flexShrink={0}>
			{scrollBar(total, first, shown, height).map((glyph, i) => (
				<Text key={i} dimColor={glyph === TRACK}>
					{glyph}
				</Text>
			))}
		</Box>
	);
}

type Props<T> = {
	board: Board;
	items: T[];
	/** Its React key, and what a double-click has to land on twice. */
	itemKey: (item: T) => string;
	/** Lines an item takes; 1 if not given. */
	itemHeight?: (item: T) => number;
	renderItem: (item: T, selected: boolean) => ReactNode;
	/** The bold line above the rule. */
	title: ReactNode;
	// The caller keeps the selected row, so it can move it (when the items change, say).
	row: number;
	setRow: Dispatch<SetStateAction<number>>;
	// Whether it takes keys and clicks (not while the board is busy).
	active: boolean;
	/** ⏎ or a double-click on an item. */
	onActivate: (item: T) => void;
	/** Any other key, with the selected item (none when the list is empty). */
	onInput?: (input: string, key: Key, item: T | undefined) => void;
};

export function ScrollList<T>({ board, items, itemKey, itemHeight, renderItem, title, row, setRow, active, onActivate, onInput }: Props<T>) {
	const { columns: width } = useWindowSize();
	const count = items.length;

	useInput(
		(input, key) => {
			board.setMessage('');
			if (input === 'j' || key.downArrow) return setRow(loop(row, 1, count));
			if (input === 'k' || key.upArrow) return setRow(loop(row, -1, count));
			if (key.return && items[row]) return onActivate(items[row]);
			onInput?.(input, key, items[row]);
		},
		{ isActive: active },
	);

	// It shows what fits in the space measured after each render, from where it was last scrolled to.
	const list = useRef<DOMElement>(null);
	const [lines, setLines] = useState(0);
	useEffect(() => {
		if (!list.current) return;
		const measured = measureElement(list.current).height;
		if (measured !== lines) setLines(measured);
	});
	const heights = items.map(item => itemHeight?.(item) ?? 1);
	const top = useRef(0);
	const view = scrollWindow(heights, top.current, row, lines);
	top.current = view.top;

	/** The item at screen row `y`. */
	const rowAt = (y: number) => {
		let bottom = LIST_TOP;
		for (let r = view.top; r < view.end; r++) {
			bottom += heights[r]!;
			if (y < bottom) return r;
		}
	};

	const isDoubleClick = useDoubleClick();
	const onMouse = ({ button, y }: MouseEvent) => {
		if (!active) return;
		board.setMessage('');
		const wheel = button === 'wheelDown' ? 1 : button === 'wheelUp' ? -1 : 0;
		if (wheel) return setRow(r => Math.max(0, Math.min(count - 1, r + wheel)));
		const r = y >= LIST_TOP ? rowAt(y) : undefined;
		if (button !== 'left' || r === undefined) return;
		setRow(r);
		if (isDoubleClick(itemKey(items[r]!))) onActivate(items[r]!);
	};
	const onMouseRef = useRef(onMouse);
	onMouseRef.current = onMouse;
	useEffect(() => {
		const listener = (event: MouseEvent) => onMouseRef.current(event);
		mouse.on('press', listener);
		return () => void mouse.off('press', listener);
	}, []);

	return (
		<Box flexGrow={1} overflow="hidden" flexDirection="column">
			<Text bold>{title}</Text>
			<Text dimColor>
				{'─'.repeat(Math.max(0, width - 13))} {String(count ? row + 1 : 0).padStart(4)} of {String(count).padEnd(3)}
			</Text>
			<Box ref={list} flexGrow={1} flexBasis={0} overflow="hidden">
				<Box flexGrow={1} flexDirection="column" overflow="hidden">
					{items.slice(view.top, view.end).map((item, i) => (
						<Box key={itemKey(item)} flexDirection="column" flexShrink={0}>
							{renderItem(item, view.top + i === row)}
						</Box>
					))}
				</Box>
				<ScrollBar total={view.total} first={view.first} shown={view.shown} height={lines} />
			</Box>
		</Box>
	);
}
