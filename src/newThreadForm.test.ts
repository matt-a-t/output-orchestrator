import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Key } from 'ink';
import { newThreadForm, newThreadKey, type NewThreadContext, type NewThreadForm } from './newThreadForm.js';
import type { Project } from './state.js';

const key = (k: Partial<Key> = {}) => k as Key;
const project = (name: string, tracker: Project['tracker'] = 'none'): Project => ({
	name,
	abbrev: '',
	path: `/tmp/${name}`,
	worktrees: true,
	color: 'cyan',
	wakePrompt: '',
	hooks: {},
	tracker,
	jiraSite: '',
	jiraProject: 'AV',
});
const tickets = [
	{ key: 'AV-1', url: 'u1', summary: 'Fix login', description: 'd1' },
	{ key: 'AV-2', url: 'u2', summary: 'Add export', description: 'd2' },
];
const ctx: NewThreadContext = { projects: [project('web', 'jira'), project('notes')], tickets };
const press = (form: NewThreadForm, ...keys: [string, Partial<Key>?][]) =>
	keys.reduce((f, [input, k]) => newThreadKey(f, input, key(k), ctx) as NewThreadForm, form);

test('j/k, tab and ↑/↓ move through the fields, skipping the ticket without a tracker', () => {
	const web = newThreadForm('web');
	assert.equal(press(web, ['', { tab: true }]).field, 'ticket');
	assert.equal(press(web, ['j']).field, 'ticket');
	assert.equal(press(web, ['', { upArrow: true }]).field, 'priority');
	assert.equal(press(web, ['k']).field, 'priority');
	assert.equal(press(web, ['', { tab: true, shift: true }]).field, 'priority');
	assert.equal(press(newThreadForm('notes'), ['', { downArrow: true }]).field, 'title');
});

test('text is only typed once a field is being edited: i at the end, I at the start, dd cleared', () => {
	const title = { ...newThreadForm('notes'), field: 'title' as const, title: 'Fix' };
	assert.deepEqual(press(title, ['x']), title);
	assert.equal(press(title, ['i'], ['x']).title, 'Fixx');
	assert.equal(press(title, ['I'], ['x']).title, 'xFix');
	assert.equal(press(title, ['d'], ['d'], ['x']).title, 'x');
	// q and a are typed while editing, rather than closing or submitting.
	assert.equal(press(title, ['i'], ['q'], ['a']).title, 'Fixqa');
	assert.equal(press(title, ['i'], ['', { escape: true }]).edit, null);
});

test('⏎ saves the field and edits the next one, stopping on the last', () => {
	let form = press(newThreadForm('web'), ['', { return: true }]);
	assert.deepEqual([form.field, form.edit], ['ticket', 0]);
	form = press(form, ['7'], ['', { return: true }], ['Fix'], ['', { return: true }], ['go']);
	assert.deepEqual([form.ticketKey, form.title, form.prompt, form.field, form.edit], ['7', 'Fix', 'go', 'prompt', 2]);
	// The priority is a choice, so ⏎ lands on it without editing, and stays there.
	form = press(form, ['', { return: true }]);
	assert.deepEqual([form.field, form.edit], ['priority', null]);
	const again = press(form, ['', { return: true }]);
	assert.deepEqual([again.field, again.edit], ['priority', null]);
	// Not editing, ⏎ on a text field edits it.
	assert.equal(press({ ...form, field: 'prompt' }, ['', { return: true }]).edit, 2);
});

test('h/l and ←/→ on the project switch project and drop the ticket', () => {
	const picked: NewThreadForm = { ...newThreadForm('web'), ticketKey: 'AV-1', ticket: 0, title: 'Fix login' };
	const moved = press(picked, ['l']);
	assert.equal(moved.project, 'notes');
	assert.equal(moved.ticketKey, '');
	assert.equal(moved.title, '');
	assert.equal(press(moved, ['h']).project, 'web');
	assert.equal(press(moved, ['', { leftArrow: true }]).project, 'web');
});

test('h/l on the ticket picks a recent one and titles the thread after it until the title is typed', () => {
	const onTicket = { ...newThreadForm('web'), field: 'ticket' as const };
	const first = press(onTicket, ['l']);
	assert.deepEqual([first.ticketKey, first.title], ['AV-1', 'Fix login']);
	assert.equal(press(first, ['h']).ticketKey, '');
	assert.equal(press(onTicket, ['', { leftArrow: true }]).ticketKey, 'AV-2');
	// Starting to edit isn't typing, so the picked ticket stays.
	assert.equal(press(first, ['i']).ticket, 0);
	const typed = press({ ...first, field: 'title' }, ['i'], ['x'], ['', { escape: true }]);
	assert.equal(typed.title, 'Fix loginx');
	assert.equal(press({ ...typed, field: 'ticket' }, ['l']).title, 'Fix loginx');
	// Cleared, the title follows the ticket again.
	const cleared = press(typed, ['d'], ['d'], ['', { escape: true }]);
	assert.equal(press({ ...cleared, field: 'ticket' }, ['l']).title, 'Add export');
});

test('h/l on the priority cycles high, normal and low, and is never typed into', () => {
	const onPriority = { ...newThreadForm('notes'), field: 'priority' as const };
	assert.equal(onPriority.priority, 'normal');
	assert.equal(press(onPriority, ['l']).priority, 'low');
	assert.equal(press(onPriority, ['l'], ['l']).priority, 'high');
	assert.equal(press(onPriority, ['h']).priority, 'high');
	assert.deepEqual(press(onPriority, ['i'], ['x']), onPriority);
});

test('typing a ticket key forgets the picked one', () => {
	const typed = press({ ...newThreadForm('web'), field: 'ticket', ticketKey: 'AV-1', ticket: 0 }, ['i'], ['3']);
	assert.deepEqual([typed.ticketKey, typed.ticket], ['AV-13', -1]);
});

test('a and shift-⏎ submit with the key normalized and the picked ticket, or say what is missing', () => {
	const submit = (form: Partial<NewThreadForm>, project = 'web') => newThreadKey({ ...newThreadForm(project), ...form }, 'a', key(), ctx);
	assert.deepEqual(submit({ ticketKey: '2', title: 'Add export', prompt: ' go ' }), {
		done: { project: 'web', ticketKey: 'AV-2', ticket: tickets[1], title: 'Add export', prompt: 'go', priority: 'normal' },
	});
	assert.deepEqual(submit({ ticketKey: '7', priority: 'high' }), {
		done: { project: 'web', ticketKey: 'AV-7', ticket: undefined, title: '', prompt: '', priority: 'high' },
	});
	assert.deepEqual(submit({ ticketKey: 'nope' }), { problem: 'Not a Jira key: nope' });
	assert.deepEqual(submit({ title: ' ' }), { problem: 'Give the thread a title or a ticket' });
	assert.deepEqual(submit({ title: 'Notes', ticketKey: 'stale' }, 'notes'), {
		done: { project: 'notes', ticketKey: undefined, ticket: undefined, title: 'Notes', prompt: '', priority: 'normal' },
	});
	const editing = { ...newThreadForm('notes'), field: 'title' as const, title: 'Notes', edit: 5 };
	assert.deepEqual(newThreadKey(editing, '', key({ return: true, shift: true }), ctx), {
		done: { project: 'notes', ticketKey: undefined, ticket: undefined, title: 'Notes', prompt: '', priority: 'normal' },
	});
});

test('q and esc cancel, once nothing is being edited', () => {
	assert.deepEqual(newThreadKey(newThreadForm('web'), 'q', key(), ctx), { done: null });
	assert.deepEqual(newThreadKey(newThreadForm('web'), '', key({ escape: true }), ctx), { done: null });
	const editing = { ...newThreadForm('notes'), field: 'title' as const, edit: 0 };
	assert.equal((newThreadKey(editing, '', key({ escape: true }), ctx) as NewThreadForm).edit, null);
});
