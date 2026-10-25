import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Key } from 'ink';
import { commitFormText, formKey, parseCommitForm, type FormState } from './commitForm.js';
import { writeCommit } from './review.js';
import type { Thread } from './state.js';
import type { ProgressPopup } from './tmux.js';

const key = (k: Partial<Key> = {}) => k as Key;
const start: FormState = { values: ['Fix', ''], field: 0, edit: null };

test('a field is typed into after i, and tab, ↑, ↓, j and k switch fields', () => {
	assert.deepEqual(formKey(start, 'e', key()), start);
	const editing = formKey(start, 'i', key()) as FormState;
	assert.deepEqual(formKey(editing, 'e', key()), { values: ['Fixe', ''], field: 0, edit: 4 });
	const switched = formKey(editing, '', key({ tab: true })) as FormState;
	assert.deepEqual(switched, { values: ['Fix', ''], field: 1, edit: null });
	assert.deepEqual(formKey(formKey(switched, 'i', key()) as FormState, 'x', key()), { values: ['Fix', 'x'], field: 1, edit: 1 });
	assert.equal((formKey(switched, 'k', key()) as FormState).field, 0);
	assert.equal((formKey(start, '', key({ downArrow: true })) as FormState).field, 1);
});

test('⏎ edits the field, then goes on to editing the notes, and a or shift-⏎ submits both', () => {
	const done = { done: { message: 'Fix', notes: 'also b' } };
	const values: FormState['values'] = ['Fix', 'also b'];
	assert.deepEqual(formKey({ values, field: 0, edit: null }, '', key({ return: true })), { values, field: 0, edit: 3 });
	assert.deepEqual(formKey({ values, field: 0, edit: 3 }, '', key({ return: true })), { values, field: 1, edit: 6 });
	assert.deepEqual(formKey({ values, field: 1, edit: 6 }, '', key({ return: true })), { values, field: 1, edit: null });
	assert.deepEqual(formKey({ values, field: 1, edit: null }, 'a', key()), done);
	assert.deepEqual(formKey({ values, field: 0, edit: 3 }, '', key({ return: true, shift: true })), done);
	// Typed while editing, a is just a letter.
	assert.deepEqual(formKey({ values, field: 0, edit: 3 }, 'a', key()), { values: ['Fixa', 'also b'], field: 0, edit: 4 });
});

test('esc stops editing, and esc or q then cancels', () => {
	assert.deepEqual(formKey({ ...start, edit: 3 }, '', key({ escape: true })), start);
	assert.deepEqual(formKey(start, '', key({ escape: true })), { done: null });
	assert.deepEqual(formKey(start, 'q', key()), { done: null });
});

test('the form is read back trimmed, and an empty message is a cancel', () => {
	assert.deepEqual(JSON.parse(commitFormText('Fix', 'a note')), { message: 'Fix', note: 'a note' });
	assert.deepEqual(parseCommitForm(JSON.stringify({ message: ' Fix ', notes: ' b ' })), { message: 'Fix', notes: 'b' });
	assert.equal(parseCommitForm(JSON.stringify({ message: ' ', notes: 'b' })), null);
	assert.equal(parseCommitForm('not json'), null);
});

test("a commit draft claude saved opens the form at once, without claude writing one", async () => {
	let opened = '';
	const progress = {
		cancellable: () => assert.fail('claude was asked for a draft'),
		edit: async (text: string) => ((opened = text), JSON.stringify({ message: 'Add drafts', notes: 'looks good' })),
	} as unknown as ProgressPopup;
	const thread = { drafts: { commit: 'Add the drafts' } } as Thread;
	assert.deepEqual(await writeCommit(progress, '/nowhere', thread), { message: 'Add drafts', notes: 'looks good' });
	assert.equal(parseCommitForm(opened)?.message, 'Add the drafts');
});
