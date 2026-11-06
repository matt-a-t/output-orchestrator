import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrollBar, scrollWindow, THUMB as T, TRACK as _ } from './scroll.js';

const ones = (n: number) => Array<number>(n).fill(1);

test('a list that fits shows it all, with a blank bar', () => {
	assert.deepEqual(scrollWindow(ones(3), 0, 2, 5), { top: 0, end: 3, first: 0, shown: 3, total: 3 });
	assert.deepEqual(scrollBar(3, 0, 3, 5), [' ', ' ', ' ', ' ', ' ']);
});

test('moving the selection past the bottom scrolls just enough to show it', () => {
	assert.deepEqual(scrollWindow(ones(10), 0, 4, 3), { top: 2, end: 5, first: 2, shown: 3, total: 10 });
	// Moving back up within the window leaves it where it is.
	assert.equal(scrollWindow(ones(10), 2, 3, 3).top, 2);
	assert.equal(scrollWindow(ones(10), 2, 0, 3).top, 0);
});

test('items of different heights count by their lines', () => {
	// Lines: 2, 1, 2, 2; four lines of room, selecting the third item.
	assert.deepEqual(scrollWindow([2, 1, 2, 2], 0, 2, 4), { top: 1, end: 3, first: 2, shown: 3, total: 7 });
	// One that's taller than the room still shows (cut off), rather than nothing.
	assert.deepEqual(scrollWindow([3], 0, 0, 2), { top: 0, end: 1, first: 0, shown: 2, total: 3 });
});

test('a list that got shorter scrolls back up to fill the room', () => {
	assert.equal(scrollWindow(ones(5), 4, 4, 3).top, 2);
	assert.equal(scrollWindow(ones(4), 3, 9, 3).top, 1);
	assert.deepEqual(scrollWindow([], 3, 0, 3), { top: 0, end: 0, first: 0, shown: 0, total: 0 });
});

test('the thumb sits at an end only when that end is in view', () => {
	assert.deepEqual(scrollBar(20, 0, 5, 4), [T, _, _, _]);
	assert.deepEqual(scrollBar(20, 15, 5, 4), [_, _, _, T]);
	assert.deepEqual(scrollBar(20, 1, 5, 4), [_, T, _, _]);
	assert.deepEqual(scrollBar(20, 14, 5, 4), [_, _, T, _]);
	assert.deepEqual(scrollBar(10, 0, 5, 4), [T, T, _, _]);
});
