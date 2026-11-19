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
	closeIdleAfter: 30,
	hooks: {},
	commands: [],
	tracker,
	jiraSite: '',
	jiraProject: 'AV',
});
const ctx: NewThreadContext = { projects: [project('web', 'jira'), project('notes')] };
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

test('h/l and ←/→ on the project switch project and drop the ticket, keeping the title', () => {
	const typed: NewThreadForm = { ...newThreadForm('web'), ticketKey: 'AV-1', title: 'Fix login' };
	const moved = press(typed, ['l']);
	assert.equal(moved.project, 'notes');
	assert.equal(moved.ticketKey, '');
	assert.equal(moved.title, 'Fix login');
	assert.equal(press(moved, ['h']).project, 'web');
	assert.equal(press(moved, ['', { leftArrow: true }]).project, 'web');
});

test('h/l on the priority cycles high, normal and low, and is never typed into', () => {
	const onPriority = { ...newThreadForm('notes'), field: 'priority' as const };
	assert.equal(onPriority.priority, 'normal');
	assert.equal(press(onPriority, ['l']).priority, 'low');
	assert.equal(press(onPriority, ['l'], ['l']).priority, 'high');
	assert.equal(press(onPriority, ['h']).priority, 'high');
	assert.deepEqual(press(onPriority, ['i'], ['x']), onPriority);
});

test('the ticket is only typed: h/l there does nothing', () => {
	const onTicket = { ...newThreadForm('web'), field: 'ticket' as const };
	assert.deepEqual(press(onTicket, ['l']), onTicket);
	assert.deepEqual(press(onTicket, ['', { leftArrow: true }]), onTicket);
	assert.equal(press(onTicket, ['i'], ['1'], ['2'], ['3']).ticketKey, '123');
});

test('a and shift-⏎ submit with the key normalized, or say what is missing', () => {
	const submit = (form: Partial<NewThreadForm>, project = 'web') => newThreadKey({ ...newThreadForm(project), ...form }, 'a', key(), ctx);
	assert.deepEqual(submit({ ticketKey: '2', title: 'Add export', prompt: ' go ' }), {
		done: { project: 'web', ticketKey: 'AV-2', title: 'Add export', prompt: 'go', priority: 'normal' },
	});
	assert.deepEqual(submit({ ticketKey: '7', priority: 'high' }), {
		done: { project: 'web', ticketKey: 'AV-7', title: '', prompt: '', priority: 'high' },
	});
	assert.deepEqual(submit({ ticketKey: 'nope' }), { problem: 'Not a Jira key: nope' });
	assert.deepEqual(submit({ title: ' ' }), { problem: 'Give the thread a title or a ticket' });
	assert.deepEqual(submit({ title: 'Notes', ticketKey: 'stale' }, 'notes'), {
		done: { project: 'notes', ticketKey: undefined, title: 'Notes', prompt: '', priority: 'normal' },
	});
	const editing = { ...newThreadForm('notes'), field: 'title' as const, title: 'Notes', edit: 5 };
	assert.deepEqual(newThreadKey(editing, '', key({ return: true, shift: true }), ctx), {
		done: { project: 'notes', ticketKey: undefined, title: 'Notes', prompt: '', priority: 'normal' },
	});
	// While editing, a is just typed.
	assert.equal((newThreadKey(editing, 'a', key(), ctx) as NewThreadForm).title, 'Notesa');
});

test('q and esc cancel, once nothing is being edited', () => {
	assert.deepEqual(newThreadKey(newThreadForm('web'), 'q', key(), ctx), { done: null });
	assert.deepEqual(newThreadKey(newThreadForm('web'), '', key({ escape: true }), ctx), { done: null });
	const editing = { ...newThreadForm('notes'), field: 'title' as const, edit: 0 };
	assert.equal((newThreadKey(editing, '', key({ escape: true }), ctx) as NewThreadForm).edit, null);
});
