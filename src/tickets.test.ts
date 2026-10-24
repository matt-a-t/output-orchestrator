import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project } from './state.js';
import { adfText, normalizeKey, recentJql, ticketBranchPart } from './tickets.js';

const project = (p: Partial<Project>): Project => ({
	name: 'p',
	abbrev: '',
	path: '/p',
	worktrees: true,
	color: 'cyan',
	hooks: {},
	tracker: 'none',
	jiraSite: '',
	jiraProject: '',
	...p,
});
const jira = project({ tracker: 'jira', jiraSite: 'example.atlassian.net', jiraProject: 'AV' });
const github = project({ tracker: 'github' });

test('normalizes Jira keys, adding the project prefix to a bare number', () => {
	assert.equal(normalizeKey(jira, '123'), 'AV-123');
	assert.equal(normalizeKey(jira, ' av-123 '), 'AV-123');
	assert.equal(normalizeKey(jira, 'GPDT-9'), 'GPDT-9');
	assert.equal(normalizeKey(project({ tracker: 'jira' }), '123'), undefined);
	assert.equal(normalizeKey(jira, 'nope'), undefined);
});

test('normalizes GitHub issue numbers', () => {
	assert.equal(normalizeKey(github, '45'), '#45');
	assert.equal(normalizeKey(github, '#45'), '#45');
	assert.equal(normalizeKey(github, 'AV-1'), undefined);
	assert.equal(normalizeKey(project({}), '45'), undefined);
});

test('branch part is the lowercased key without the #', () => {
	assert.equal(ticketBranchPart({ key: 'AV-123', url: '' }), 'av-123');
	assert.equal(ticketBranchPart({ key: '#45', url: '' }), '45');
});

test('recent JQL is scoped to the project when it has a prefix', () => {
	assert.equal(recentJql(jira), 'project = "AV" AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
	assert.equal(recentJql(project({ tracker: 'jira' })), 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
});

test('flattens ADF to plain text', () => {
	const text = (t: string) => ({ type: 'text', text: t });
	const para = (...c: object[]) => ({ type: 'paragraph', content: c });
	const doc = {
		type: 'doc',
		content: [
			{ type: 'heading', attrs: { level: 2 }, content: [text('Goal')] },
			para(text('Do '), text('the thing.')),
			{
				type: 'bulletList',
				content: [
					{ type: 'listItem', content: [para(text('one'))] },
					{
						type: 'listItem',
						content: [para(text('two')), { type: 'orderedList', content: [{ type: 'listItem', content: [para(text('sub'))] }] }],
					},
				],
			},
		],
	};
	assert.equal(adfText(doc).trim(), '## Goal\n\nDo the thing.\n\n- one\n- two\n  1. sub');
});
