// Scrolling a list that's taller than its space: which items fit, and the scroll bar beside them.

/** The thumb and track of a scroll bar, and the blank a bar is when everything fits. */
export const THUMB = '┃';
export const TRACK = '│';

/** What `scrollWindow` shows: items `top` up to (not including) `end`, and where that is in lines. */
export type ScrollWindow = { top: number; end: number; first: number; shown: number; total: number };

const sum = (heights: number[], from: number, to: number) => heights.slice(from, to).reduce((n, h) => n + h, 0);

/**
 * The items that fit in `lines`, given each one's height: starting from `top` (where the list was
 * scrolled to), moved just enough to bring `selected` into view, and back up if there's room left at
 * the bottom (the list got shorter). At least one item shows once there's any room.
 */
export function scrollWindow(heights: number[], top: number, selected: number, lines: number): ScrollWindow {
	const count = heights.length;
	const total = sum(heights, 0, count);
	if (count === 0) return { top: 0, end: 0, first: 0, shown: 0, total };
	selected = Math.max(0, Math.min(count - 1, selected));
	top = Math.max(0, Math.min(top, selected));
	while (top < selected && sum(heights, top, selected + 1) > lines) top++;
	while (top > 0 && sum(heights, top - 1, count) <= lines) top--;
	let end = top;
	let used = 0;
	while (end < count && used + heights[end]! <= lines) used += heights[end++]!;
	if (end === top && lines > 0) used = heights[end++]!;
	return { top, end, first: sum(heights, 0, top), shown: Math.min(used, lines), total };
}

/**
 * A scroll bar `height` lines tall for lines `first` to `first + shown` of `total`, a glyph a line:
 * blank when it all fits. The thumb touches an end only when that end of the list is in view.
 */
export function scrollBar(total: number, first: number, shown: number, height: number): string[] {
	if (height <= 0) return [];
	if (shown >= total || total === 0) return Array<string>(height).fill(' ');
	const thumb = Math.max(1, Math.min(height, Math.round((height * shown) / total)));
	const room = height - thumb;
	let at: number;
	if (first <= 0) at = 0;
	else if (first + shown >= total) at = room;
	else at = Math.min(Math.max(Math.round((first * room) / (total - shown)), Math.min(1, room)), Math.max(0, room - 1));
	return Array.from({ length: height }, (_, i) => (i >= at && i < at + thumb ? THUMB : TRACK));
}
