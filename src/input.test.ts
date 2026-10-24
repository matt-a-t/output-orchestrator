import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Key } from 'ink';
import { choiceStep, editAt, fieldKey, fieldStep, isBack, isSubmit, nextField } from './input.js';

const key = (k: Partial<Key> = {}) => k as Key;

test('ctrl-u clears a text field', () => {
	assert.deepEqual(editAt('Fix the thing', 13, 'u', key({ ctrl: true })), { value: '', cursor: 0 });
});

test('ctrl-w deletes the last word, with any spaces after it', () => {
	assert.equal(editAt('Fix the thing', 13, 'w', key({ ctrl: true }))?.value, 'Fix the ');
	assert.equal(editAt('Fix the  ', 9, 'w', key({ ctrl: true }))?.value, 'Fix ');
	assert.equal(editAt('Fix', 3, 'w', key({ ctrl: true }))?.value, '');
});

test('other ctrl keys are not typed into the field', () => {
	assert.equal(editAt('Fix', 3, 'b', key({ ctrl: true })), undefined);
	assert.equal(editAt('Fix', 3, 'e', key())?.value, 'Fixe');
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
	assert.deepEqual(fieldKey('Fix', null, 'dd', key()), { value: '', edit: 0 });
	// Anything else in between is the form's, which drops the pending d.
	assert.equal(fieldKey('Fix', 'd', 'j', key()), undefined);
});

test('esc stops editing and keeps the text, and ⏎ while editing is the form\'s', () => {
	assert.deepEqual(fieldKey('Fixed', 5, '', key({ escape: true })), { value: 'Fixed', edit: null });
	assert.equal(fieldKey('Fixed', 5, '', key({ return: true })), undefined);
	assert.equal(fieldKey('Fixed', null, '', key({ escape: true })), undefined);
	assert.equal(fieldKey('Fixed', 5, '', key({ tab: true })), undefined);
});

test('a submits a form only while not editing, and shift-⏎ always does', () => {
	assert.equal(isSubmit('a', key(), null), true);
	assert.equal(isSubmit('a', key(), 'd'), true);
	assert.equal(isSubmit('a', key(), 3), false);
	assert.equal(isSubmit('', key({ return: true, shift: true }), 3), true);
	assert.equal(isSubmit('', key({ return: true }), null), false);
	// So shift-⏎ on a text field submits rather than starting to edit it.
	assert.equal(fieldKey('Fix', null, '', key({ return: true, shift: true })), undefined);
});

test('q closes a form only while not editing, and esc always does once fieldKey passes it on', () => {
	assert.equal(isBack('q', key(), null), true);
	assert.equal(isBack('q', key(), 0), false);
	assert.equal(isBack('', key({ escape: true }), null), true);
	assert.deepEqual(fieldKey('Fix', 3, '', key({ escape: true })), { value: 'Fix', edit: null });
});

test('h/l and ←/→ change a choice, j/k ↑/↓ and tab move between fields', () => {
	assert.equal(choiceStep('h', key()), -1);
	assert.equal(choiceStep('', key({ rightArrow: true })), 1);
	assert.equal(choiceStep('l', key()), 1);
	assert.equal(choiceStep('x', key()), 0);
	assert.equal(fieldStep('k', key()), -1);
	assert.equal(fieldStep('', key({ tab: true, shift: true })), -1);
	assert.equal(fieldStep('', key({ tab: true })), 1);
	assert.equal(fieldStep('h', key()), 0);
});

test('⏎ goes on to the next field, editing it if it is text, and stays on the last', () => {
	const lengths = [undefined, 3, 5];
	assert.deepEqual(nextField(0, 3, i => lengths[i]), { field: 1, edit: 3 });
	assert.deepEqual(nextField(1, 3, i => lengths[i]), { field: 2, edit: 5 });
	assert.deepEqual(nextField(2, 3, i => lengths[i]), { field: 2, edit: null });
	assert.deepEqual(nextField(0, 3, () => undefined), { field: 1, edit: null });
});
