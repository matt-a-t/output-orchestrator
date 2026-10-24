import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrDetails } from './github.js';
import { prHeader } from './review.js';

const pr: PrDetails = {
	number: 7,
	title: 'Add foo',
	body: 'Does foo.',
	url: 'https://github.com/o/r/pull/7',
	author: { login: 'alice' },
	isDraft: false,
	state: 'OPEN',
	mergeable: 'MERGEABLE',
	mergeStateStatus: 'CLEAN',
	reviewDecision: 'CHANGES_REQUESTED',
	reviews: [
		{ author: { login: 'bob' }, state: 'CHANGES_REQUESTED', body: '' },
		{ author: { login: 'bob' }, state: 'COMMENTED', body: 'see above' },
		{ author: { login: 'carol' }, state: 'COMMENTED', body: '' },
		{ author: { login: 'carol' }, state: 'APPROVED', body: '' },
	],
	statusCheckRollup: [],
	headRefName: 'foo',
	baseRefName: 'main',
	additions: 3,
	deletions: 1,
};

const plain = (text: string) => text.replace(/\x1b\[\d+m/g, '');

test('the PR header says where it stands and each reviewer’s latest verdict', () => {
	const lines = plain(prHeader(pr)).split('\n');
	assert.deepEqual(lines.slice(0, 6), [
		'#7 Add foo',
		'alice wants to merge foo into main  +3 −1',
		'ready to merge · requested changes',
		'reviews: bob requested changes, carol approved',
		'',
		'Does foo.',
	]);
});

test('a header with nothing to report skips those lines', () => {
	const lines = plain(prHeader({ ...pr, body: '', reviews: [], reviewDecision: '', mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' })).split('\n');
	assert.deepEqual(lines.slice(0, 4), ['#7 Add foo', 'alice wants to merge foo into main  +3 −1', '', 'No description.']);
});
