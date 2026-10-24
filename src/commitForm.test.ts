import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Key } from 'ink';
import { commitFormText, formKey, parseCommitForm, type FormState } from './commitForm.js';

const key = (k: Partial<Key> = {}) => k as Key;
const start: FormState = { values: ['Fix', ''], field: 0 };

test('typing goes into the focused field, and tab, ↑ and ↓ switch fields', () => {
	const typed = formKey(start, 'e', key());
	assert.deepEqual(typed, { values: ['Fixe', ''], field: 0 });
	const switched = formKey(start, '', key({ tab: true })) as FormState;
	assert.equal(switched.field, 1);
	assert.deepEqual(formKey(switched, 'x', key()), { values: ['Fix', 'x'], field: 1 });
	assert.equal((formKey(switched, '', key({ upArrow: true })) as FormState).field, 0);
	assert.equal((formKey(start, '', key({ downArrow: true })) as FormState).field, 1);
});

test('enter submits both fields from either one, and esc cancels', () => {
	const done = { done: { message: 'Fix', notes: 'also b' } };
	assert.deepEqual(formKey({ values: ['Fix', 'also b'], field: 0 }, '', key({ return: true })), done);
	assert.deepEqual(formKey({ values: ['Fix', 'also b'], field: 1 }, '', key({ return: true })), done);
	assert.deepEqual(formKey(start, '', key({ escape: true })), { done: null });
});

test('the form is read back trimmed, and an empty message is a cancel', () => {
	assert.deepEqual(JSON.parse(commitFormText('Fix', 'a note')), { message: 'Fix', note: 'a note' });
	assert.deepEqual(parseCommitForm(JSON.stringify({ message: ' Fix ', notes: ' b ' })), { message: 'Fix', notes: 'b' });
	assert.equal(parseCommitForm(JSON.stringify({ message: ' ', notes: 'b' })), null);
	assert.equal(parseCommitForm('not json'), null);
});
