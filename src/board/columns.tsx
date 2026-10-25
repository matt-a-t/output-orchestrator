// The board's columns of cards: scrolling each to fit, and finding what a click is on.

import { useEffect, useRef, useState, type RefObject } from 'react';
import { Box, Text, measureElement, useWindowSize, type DOMElement } from 'ink';
import type { PrStatus } from '../github.js';
import { mouse, type MouseEvent } from '../mouse.js';
import { COLUMN_LABELS, type Column, type Thread } from '../state.js';
import { threadWindowName } from '../tmux.js';
import type { Board } from './board.js';
import { Card, cardHeight, cardLines, LIST_TOP, LOCAL_BORDER_LINES } from './card.js';
import { openThread, resumeId, stalled } from './claude.js';
import { useDoubleClick } from './doubleClick.js';

type Cursor = { col: number; row: number };

/** What the columns keep while another screen covers them, so they come back as they were. */
export type ColumnsLayout = { height: number; scrollOffsets: Partial<Record<Column, number>> };
export const newColumnsLayout = (): ColumnsLayout => ({ height: 0, scrollOffsets: {} });

type Props = {
	board: Board;
	// The columns shown (COLUMNS, and ARCHIVED while A shows it), and each one's threads with the filter applied.
	shown: readonly Column[];
	columns: Thread[][];
	// Its row is within the column.
	cursor: Cursor;
	setCursor: (cursor: Cursor) => void;
	// Whether clicks and the wheel do anything (not while busy, or something's being asked).
	active: boolean;
	unreviewed: Set<string>;
	merge: Record<string, PrStatus>;
	layout: RefObject<ColumnsLayout>;
};

export function Columns({ board, shown, columns, cursor, setCursor, active, unreviewed, merge, layout }: Props) {
	const { columns: width } = useWindowSize();
	const colWidth = Math.max(16, Math.floor(width / shown.length));

	// Lines the columns get, measured after layout (0 until then); taller columns scroll.
	const boardRef = useRef<DOMElement>(null);
	const [boardHeight, setBoardHeight] = useState(layout.current.height);
	const { scrollOffsets } = layout.current;
	useEffect(() => {
		if (!boardRef.current) return;
		const measured = measureElement(boardRef.current).height;
		layout.current.height = measured;
		if (measured !== boardHeight) setBoardHeight(measured);
	});

	/** The slice of a column's threads that fits, keeping the cursor in view; `top` is the lines its "more" line above takes. */
	const visibleSlice = (column: Column, threads: Thread[], cursorRow: number | undefined) => {
		const count = threads.length;
		// Room for the borders of the cards in Local, whether or not they're scrolled into view.
		const lines = boardHeight - (LIST_TOP - 1) - LOCAL_BORDER_LINES * threads.filter(t => t.local).length;
		const rowLines = cardHeight(column);
		if (boardHeight === 0 || count * rowLines <= lines) return { start: 0, end: count, top: 0 };
		// Room for the "more" lines above and below.
		const fits = Math.max(1, Math.floor((lines - 2) / rowLines));
		const last = count - fits;
		let start = scrollOffsets[column] ?? (column === 'done' ? last : 0);
		if (cursorRow !== undefined) start = Math.min(Math.max(start, cursorRow - fits + 1), cursorRow);
		// Unless you're in it, Done shows the latest arrivals, which land at the bottom.
		else if (column === 'done') start = last;
		start = Math.min(Math.max(0, start), last);
		scrollOffsets[column] = start;
		return { start, end: start + fits, top: start > 0 ? 1 : 0 };
	};
	const columnSlice = (c: number) => visibleSlice(shown[c]!, columns[c]!, c === cursor.col ? cursor.row : undefined);

	const isDoubleClick = useDoubleClick();
	// The layout is a fixed grid, so a press's cell says what it's on. The wheel stops at the ends rather than looping.
	const onMouse = ({ button, x, y }: MouseEvent) => {
		if (!active) return;
		board.setMessage('');
		const wheel = button === 'wheelDown' ? 1 : button === 'wheelUp' ? -1 : 0;
		if (wheel) return setCursor({ col: cursor.col, row: Math.max(0, Math.min(columns[cursor.col]!.length - 1, cursor.row + wheel)) });
		const col = Math.floor(x / colWidth);
		if (button !== 'left' || y < 1 || col >= shown.length) return;
		const slice = columnSlice(col);
		let top = LIST_TOP + slice.top;
		// The column's header, or its "more" line.
		if (y < top) return setCursor({ col, row: cursor.row });
		// Cards in Local are taller, so count down through the ones shown.
		const threads = columns[col]!;
		let r = slice.start;
		for (; r < Math.min(slice.end, threads.length); r++) {
			top += cardLines(threads[r]!);
			if (y < top) break;
		}
		const thread = r < slice.end ? threads[r] : undefined;
		if (!thread) return;
		setCursor({ col, row: r });
		if (isDoubleClick(thread.id)) openThread(board, thread);
	};
	const onMouseRef = useRef(onMouse);
	onMouseRef.current = onMouse;
	useEffect(() => {
		const listener = (event: MouseEvent) => onMouseRef.current(event);
		mouse.on('press', listener);
		return () => void mouse.off('press', listener);
	}, []);

	return (
		<Box ref={boardRef} flexGrow={1} overflow="hidden">
			{shown.map((column, c) => {
				const threads = columns[c]!;
				const { start, end } = columnSlice(c);
				return (
					<Box key={column} flexDirection="column" width={colWidth} paddingRight={1}>
						<Text bold color={c === cursor.col ? 'white' : 'gray'}>
							{COLUMN_LABELS[column]} ({threads.length})
						</Text>
						<Text dimColor>{'─'.repeat(colWidth - 1)}</Text>
						{start > 0 ? <Text dimColor>  ↑ {start} more</Text> : null}
						{threads.slice(start, end).map((t, i) => (
							<Card
								key={t.id}
								thread={t}
								selected={c === cursor.col && start + i === cursor.row}
								project={board.project(t.project)}
								live={board.liveWindows().has(threadWindowName(t.id))}
								status={board.statuses()[t.id]}
								resumable={!!resumeId(t)}
								stalled={stalled(board, t)}
								unreviewed={unreviewed.has(t.id)}
								merge={merge[t.id]}
							/>
						))}
						{end < threads.length ? <Text dimColor>  ↓ {threads.length - end} more</Text> : null}
					</Box>
				);
			})}
		</Box>
	);
}
