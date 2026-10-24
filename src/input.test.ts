import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Key } from 'ink';
import { editAt, editText, fieldKey } from './input.js';

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

test('editing at the cursor inserts and deletes there, and ←/→ stop at the ends', () => {
	assert.deepEqual(editAt('Fix thing', 4, 'the ', key()), { value: 'Fix the thing', cursor: 8 });
	assert.deepEqual(editAt('Fixx it', 4, '', key({ backspace: true })), { value: 'Fix it', cursor: 3 });
	assert.deepEqual(editAt('Fix', 0, '', key({ backspace: true })), { value: 'Fix', cursor: 0 });
	assert.deepEqual(editAt('Fix', 0, '', key({ leftArrow: true })), { value: 'Fix', cursor: 0 });
	assert.deepEqual(editAt('Fix', 3, '', key({ rightArrow: true })), { value: 'Fix', cursor: 3 });
	assert.deepEqual(editAt('Fix', 1, '', key({ rightArrow: true })), { value: 'Fix', cursor: 2 });
});

test('ctrl-u and ctrl-w delete back from the cursor, keeping what is after it', () => {
	assert.deepEqual(editAt('Fix the thing', 8, 'u', key({ ctrl: true })), { value: 'thing', cursor: 0 });
	assert.deepEqual(editAt('Fix the thing', 8, 'w', key({ ctrl: true })), { value: 'Fix thing', cursor: 4 });
});

test('a field is not typed into until i or ⏎, which edit at the end, or I at the start', () => {
	assert.equal(fieldKey('Fix', null, 'x', key()), undefined);
	assert.equal(fieldKey('Fix', null, 'j', key()), undefined);
	assert.deepEqual(fieldKey('Fix', null, 'i', key()), { value: 'Fix', edit: 3 });
	assert.deepEqual(fieldKey('Fix', null, '', key({ return: true })), { value: 'Fix', edit: 3 });
	assert.deepEqual(fieldKey('Fix', null, 'I', key()), { value: 'Fix', edit: 0 });
	assert.deepEqual(fieldKey('Fix', 0, 'A ', key()), { value: 'A Fix', edit: 2 });
});

test('dd clears the field and edits it', () => {
	const first = fieldKey('Fix', null, 'd', key());
	assert.deepEqual(first, { value: 'Fix', edit: 'd' });
	assert.deepEqual(fieldKey('Fix', 'd', 'd', key()), { value: '', edit: 0 });
	// Anything else in between is the form's, which drops the pending d.
	assert.equal(fieldKey('Fix', 'd', 'j', key()), undefined);
});

test('esc stops editing and keeps the text, and ⏎ while editing is the form\'s', () => {
	assert.deepEqual(fieldKey('Fixed', 5, '', key({ escape: true })), { value: 'Fixed', edit: null });
	assert.equal(fieldKey('Fixed', 5, '', key({ return: true })), undefined);
	assert.equal(fieldKey('Fixed', null, '', key({ escape: true })), undefined);
	assert.equal(fieldKey('Fixed', 5, '', key({ tab: true })), undefined);
});
