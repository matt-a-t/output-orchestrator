import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Key } from 'ink';
import { editText } from './input.js';

const key = (k: Partial<Key> = {}) => k as Key;

test('ctrl-u clears a text field', () => {
	assert.equal(editText('Fix the thing', 'u', key({ ctrl: true })), '');
});

test('ctrl-w deletes the last word, with any spaces after it', () => {
	assert.equal(editText('Fix the thing', 'w', key({ ctrl: true })), 'Fix the ');
	assert.equal(editText('Fix the  ', 'w', key({ ctrl: true })), 'Fix ');
	assert.equal(editText('Fix', 'w', key({ ctrl: true })), '');
});

test('other ctrl keys are not typed into the field', () => {
	assert.equal(editText('Fix', 'a', key({ ctrl: true })), undefined);
	assert.equal(editText('Fix', 'e', key()), 'Fixe');
});
