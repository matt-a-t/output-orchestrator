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

test('tab and ↑/↓ move through the fields, skipping the ticket without a tracker', () => {
	const web = newThreadForm('web');
	assert.equal(press(web, ['', { tab: true }]).field, 'ticket');
	assert.equal(press(web, ['', { upArrow: true }]).field, 'prompt');
	assert.equal(press(web, ['', { tab: true, shift: true }]).field, 'prompt');
	assert.equal(press(newThreadForm('notes'), ['', { downArrow: true }]).field, 'title');
});

test('←/→ on the project switches project and drops the ticket', () => {
	const picked: NewThreadForm = { ...newThreadForm('web'), ticketKey: 'AV-1', ticket: 0, title: 'Fix login' };
	const moved = press(picked, ['', { rightArrow: true }]);
	assert.equal(moved.project, 'notes');
	assert.equal(moved.ticketKey, '');
	assert.equal(moved.title, '');
	assert.equal(press(moved, ['', { leftArrow: true }]).project, 'web');
});

test('←/→ on the ticket picks a recent one and titles the thread after it until the title is typed', () => {
	const onTicket = { ...newThreadForm('web'), field: 'ticket' as const };
	const first = press(onTicket, ['', { rightArrow: true }]);
	assert.deepEqual([first.ticketKey, first.title], ['AV-1', 'Fix login']);
	assert.equal(press(first, ['', { leftArrow: true }]).ticketKey, '');
	assert.equal(press(onTicket, ['', { leftArrow: true }]).ticketKey, 'AV-2');
	const typed = press({ ...first, field: 'title' }, ['', { ctrl: true }], ['x']);
	assert.equal(typed.title, 'Fix loginx');
	assert.equal(press({ ...typed, field: 'ticket' }, ['', { rightArrow: true }]).title, 'Fix loginx');
	// Cleared, the title follows the ticket again.
	const cleared = press(typed, ['u', { ctrl: true }]);
	assert.equal(press({ ...cleared, field: 'ticket' }, ['', { rightArrow: true }]).title, 'Add export');
});

test('typing a ticket key forgets the picked one', () => {
	const typed = press({ ...newThreadForm('web'), field: 'ticket', ticketKey: 'AV-1', ticket: 0 }, ['3']);
	assert.deepEqual([typed.ticketKey, typed.ticket], ['AV-13', -1]);
});

test('enter submits with the key normalized and the picked ticket, or says what is missing', () => {
	const submit = (form: Partial<NewThreadForm>, project = 'web') => newThreadKey({ ...newThreadForm(project), ...form }, '', key({ return: true }), ctx);
	assert.deepEqual(submit({ ticketKey: '2', title: 'Add export', prompt: ' go ' }), {
		done: { project: 'web', ticketKey: 'AV-2', ticket: tickets[1], title: 'Add export', prompt: 'go' },
	});
	assert.deepEqual(submit({ ticketKey: '7' }), { done: { project: 'web', ticketKey: 'AV-7', ticket: undefined, title: '', prompt: '' } });
	assert.deepEqual(submit({ ticketKey: 'nope' }), { problem: 'Not a Jira key: nope' });
	assert.deepEqual(submit({ title: ' ' }), { problem: 'Give the thread a title or a ticket' });
	assert.deepEqual(submit({ title: 'Notes', ticketKey: 'stale' }, 'notes'), {
		done: { project: 'notes', ticketKey: undefined, ticket: undefined, title: 'Notes', prompt: '' },
	});
	assert.deepEqual(newThreadKey(newThreadForm('web'), '', key({ escape: true }), ctx), { done: null });
});
