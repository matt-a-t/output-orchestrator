import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIN_COLUMN_WIDTH } from './card.js';
import { columnWindow } from './columns.js';

test('columns share the width when they all fit at the narrowest', () => {
	assert.deepEqual(columnWindow(6, 160, 3, 0), { first: 0, fits: 6, colWidth: 26 });
	assert.deepEqual(columnWindow(6, 6 * MIN_COLUMN_WIDTH, 5, 0), { first: 0, fits: 6, colWidth: MIN_COLUMN_WIDTH });
});

test("narrower, the columns shown slide just far enough to keep the cursor's in view", () => {
	// 120 columns fit five of six at MIN_COLUMN_WIDTH (22), 24 each.
	assert.deepEqual(columnWindow(6, 120, 0, 0), { first: 0, fits: 5, colWidth: 24 });
	assert.equal(columnWindow(6, 120, 4, 0).first, 0);
	assert.equal(columnWindow(6, 120, 5, 0).first, 1);
	// Back left: they stay put until the cursor passes the first shown.
	assert.equal(columnWindow(6, 120, 1, 1).first, 1);
	assert.equal(columnWindow(6, 120, 0, 1).first, 0);
	// Fewer columns after I or A hide one: never past the end.
	assert.equal(columnWindow(5, 120, 4, 3).first, 0);
	// However narrow, one is shown.
	assert.deepEqual(columnWindow(6, 10, 2, 0), { first: 2, fits: 1, colWidth: 10 });
});
