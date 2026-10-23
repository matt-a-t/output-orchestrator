import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnHook } from './hooks.js';

test('moves into and out of Polish set off its hooks', () => {
	assert.equal(columnHook('active', 'polish'), 'enterPolish');
	assert.equal(columnHook('pr', 'polish'), 'enterPolish');
	assert.equal(columnHook('polish', 'active'), 'leavePolish');
	assert.equal(columnHook('polish', 'pr'), 'leavePolish');
	assert.equal(columnHook('polish', 'archived'), 'leavePolish');
});

test('other moves set off nothing', () => {
	assert.equal(columnHook('polish', 'polish'), undefined);
	assert.equal(columnHook('active', 'pr'), undefined);
	assert.equal(columnHook('pr', 'done'), undefined);
});
