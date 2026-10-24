import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrDetails } from './github.js';
import { parsePrReview, prHeader } from './review.js';

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

const diff = [
	'diff --git a/src/foo.ts b/src/foo.ts',
	'index 1111111..2222222 100644',
	'--- a/src/foo.ts',
	'+++ b/src/foo.ts',
	'@@ -10,3 +10,3 @@ function foo() {',
	'>> on the hunk header',
	' const a = 1;',
	'>> on a kept line',
	'-const b = 2;',
	'>> on a removed line',
	'>> that goes on',
	'+const b = 3;',
	'>> on an added line',
	' const c = 4;',
].join('\n');

test('notes on diff lines become line comments: removed lines on the old side, the rest on the new', () => {
	const review = parsePrReview(`# instructions\n\nLooks close.\n\n${diff}\n`);
	assert.deepEqual(review.comments, [
		{ path: 'src/foo.ts', line: 10, side: 'RIGHT', body: 'on a kept line' },
		{ path: 'src/foo.ts', line: 11, side: 'LEFT', body: 'on a removed line\nthat goes on' },
		{ path: 'src/foo.ts', line: 11, side: 'RIGHT', body: 'on an added line' },
	]);
	// GitHub can't pin a note on a hunk header, so it joins the main comment saying where it was.
	assert.equal(review.body, 'Looks close.\n\n- `src/foo.ts:10`: on the hunk header');
});

test('a review with nothing written is empty', () => {
	const untouched = diff.split('\n').filter(l => !l.startsWith('>>')).join('\n');
	assert.deepEqual(parsePrReview(`# instructions\n\n\n${untouched}\n`), { body: '', comments: [] });
});
