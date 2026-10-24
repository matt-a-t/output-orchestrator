import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checksLabel, withTicket } from './github.js';

const jira = { key: 'AV-123', url: 'https://example.atlassian.net/browse/AV-123' };
const github = { key: '#45', url: 'https://github.com/o/r/issues/45' };

test('PRs are titled with the ticket key and link to it', () => {
	assert.deepEqual(withTicket({ title: 'Add foo', body: 'Does foo.' }, jira), {
		title: 'AV-123: Add foo',
		body: 'Does foo.\n\nJira: [AV-123](https://example.atlassian.net/browse/AV-123)',
	});
	assert.deepEqual(withTicket({ title: 'Add foo', body: '' }, github), { title: '#45: Add foo', body: 'Closes #45' });
});

test('adding the ticket twice changes nothing', () => {
	for (const ticket of [jira, github]) {
		const once = withTicket({ title: 'Add foo', body: 'Does foo.' }, ticket);
		assert.deepEqual(withTicket(once, ticket), once);
	}
	assert.deepEqual(withTicket({ title: 'av-123 add foo', body: 'Fixes #45' }, jira).title, 'av-123 add foo');
	assert.deepEqual(withTicket({ title: 'x', body: 'Fixes #45' }, github).body, 'Fixes #45');
});

test('a longer key or issue number is not the same ticket', () => {
	assert.equal(withTicket({ title: '#450: Add foo', body: '' }, github).title, '#45: #450: Add foo');
	assert.equal(withTicket({ title: 'AV-1234 thing', body: '' }, jira).title, 'AV-123: AV-1234 thing');
	assert.equal(withTicket({ title: 'x', body: 'Closes #450' }, github).body, 'Closes #450\n\nCloses #45');
});

test('no ticket, no change', () => {
	const draft = { title: 'Add foo', body: 'Does foo.' };
	assert.equal(withTicket(draft, undefined), draft);
});

test('checks are summed up by how they stand, colored by the worst', () => {
	assert.equal(checksLabel([]), undefined);
	const run = (status: string, conclusion = '') => ({ __typename: 'CheckRun' as const, name: 'ci', status, conclusion });
	const ctx = (state: string) => ({ __typename: 'StatusContext' as const, context: 'ci', state });
	assert.deepEqual(checksLabel([run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED'), ctx('SUCCESS')]), ['checks: 3 passing', 'green']);
	assert.deepEqual(checksLabel([run('IN_PROGRESS'), ctx('PENDING'), run('COMPLETED', 'SUCCESS')]), ['checks: 2 pending, 1 passing', 'yellow']);
	assert.deepEqual(checksLabel([run('COMPLETED', 'FAILURE'), ctx('ERROR'), run('QUEUED')]), ['checks: 2 failing, 1 pending', 'red']);
});
