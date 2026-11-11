import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bitbucket, diffCounts, mergeStatus, parseTwg, toDetails, type BitbucketPr, type MergeCheck } from './bitbucket.js';
import { checksLabel, mergeLabel } from './prHost.js';
import type { Thread } from './state.js';
import { fakeCommand } from './testHelpers.js';

// Cut down from what `twg bitbucket pull-requests get 49 --statuses -o json` printed.
const PR: BitbucketPr = {
	id: 49,
	title: 'Testing plan by test login',
	description: '## What changed\n\n- New staff test users.',
	state: 'OPEN',
	draft: false,
	author: { display_name: 'Pat Author', nickname: 'Pat Author' },
	source: { branch: { name: 'oo/testing-plan' }, commit: { hash: '497b1a3e9fb0' } },
	destination: { branch: { name: 'main' } },
	links: { html: { href: 'https://bitbucket.org/acme/widgets/pull-requests/49' } },
	participants: [],
	_statuses: [],
};

// From `twg bitbucket pull-requests mergeability 49 -o json`, for a PR that conflicts with main.
const CONFLICTS: MergeCheck[] = [
	{ type: 'pullrequest_state_check', status: 'PASSED', blocking: false },
	{ type: 'current_user_permission_check', status: 'PASSED', blocking: false },
	{ type: 'git_mergeability_check', status: 'FAILED', blocking: true, reason: 'conflicts' },
];
const CLEAN: MergeCheck[] = CONFLICTS.map(c => ({ ...c, status: 'PASSED', blocking: false }));

const ARGS = '-o json --output-summary none';
const THREAD = { id: '1', branch: 'oo/testing-plan' } as Thread;

test("twg's error is what's thrown, with what to try when it's the token", () => {
	const auth = JSON.stringify({
		ok: false,
		error: { code: 'AUTH_INVALID', statusCode: 401, message: 'Authentication failed.', summary: 'Your Bitbucket token is missing or invalid.' },
	});
	assert.throws(() => parseTwg(auth, '', 1), /^Error: Bitbucket: Your Bitbucket token is missing or invalid\. \(if `twg setup bitbucket` keeps failing, set TWG_BBC_TOKEN/);
	const other = JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'No such pull request' } });
	assert.throws(() => parseTwg(other, '', 1), { message: 'Bitbucket: No such pull request' });
	// Not JSON: the last line of stderr, past its upgrade notices.
	assert.throws(() => parseTwg('', 'Upgrade available: 1.4.3 -> 1.4.4\nrepository not found\n', 2), { message: 'Bitbucket: repository not found' });
	assert.deepEqual(parseTwg('[{"id":1}]', 'Upgrade available', 0), [{ id: 1 }]);
});

test("mergeability reads as GitHub's, so the board's labels work unchanged", () => {
	assert.deepEqual(mergeLabel(mergeStatus('OPEN', CONFLICTS)), ['conflicts with base', 'red']);
	assert.deepEqual(mergeLabel(mergeStatus('OPEN', CLEAN)), ['ready to merge', 'green']);
	const unapproved = [...CLEAN, { type: 'minimum_approvals_check', status: 'FAILED', blocking: true }];
	assert.deepEqual(mergeLabel(mergeStatus('OPEN', unapproved)), ['blocked (reviews/checks)', 'yellow']);
	const behind = [...CLEAN, { type: 'maximum_commits_behind_check', status: 'FAILED', blocking: true }];
	assert.deepEqual(mergeLabel(mergeStatus('OPEN', behind)), ['behind base', 'yellow']);
	// A failing check that doesn't block doesn't hold it up.
	assert.deepEqual(mergeLabel(mergeStatus('OPEN', [...CLEAN, { type: 'build_check', status: 'FAILED', blocking: false }])), ['ready to merge', 'green']);
	// twg couldn't say: UNKNOWN keeps what the board last knew.
	assert.equal(mergeStatus('OPEN', undefined).mergeable, 'UNKNOWN');
	assert.equal(mergeStatus('MERGED', CLEAN).state, 'MERGED');
	assert.equal(mergeStatus('DECLINED', CLEAN).state, 'CLOSED');
	assert.equal(mergeStatus('SUPERSEDED', undefined).state, 'CLOSED');
});

test('the viewer gets the PR in the shape it shows', () => {
	const pr: BitbucketPr = {
		...PR,
		participants: [
			{ role: 'REVIEWER', approved: true, state: 'approved', user: { display_name: 'Rae Viewer' } },
			{ role: 'PARTICIPANT', approved: false, state: null, user: { display_name: 'Just Commented' } },
		],
		_statuses: [
			{ state: 'SUCCESSFUL', name: 'build' },
			{ state: 'INPROGRESS', key: 'e2e' },
		],
	};
	const details = toDetails(pr, CONFLICTS, 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new\n+more\n');
	assert.equal(details.number, 49);
	assert.equal(details.url, 'https://bitbucket.org/acme/widgets/pull-requests/49');
	assert.equal(details.author.login, 'Pat Author');
	assert.equal(details.headRefName, 'oo/testing-plan');
	assert.equal(details.baseRefName, 'main');
	assert.equal(details.headRefOid, '497b1a3e9fb0');
	assert.equal(details.mergeStateStatus, 'DIRTY');
	assert.deepEqual(details.reviews, [{ author: { login: 'Rae Viewer' }, state: 'APPROVED', body: '' }]);
	assert.equal(details.reviewDecision, 'APPROVED');
	assert.deepEqual(checksLabel(details.statusCheckRollup), ['checks: 1 pending, 1 passing', 'yellow']);
	assert.deepEqual([details.additions, details.deletions], [2, 1]);
	const sentBack = toDetails({ ...pr, participants: [{ approved: false, state: 'changes_requested', user: { nickname: 'Rae' } }] }, CLEAN, '');
	assert.equal(sentBack.reviewDecision, 'CHANGES_REQUESTED');
});

test("diff counts leave out the files' --- and +++ lines", () => {
	assert.deepEqual(diffCounts(''), { additions: 0, deletions: 0 });
	assert.deepEqual(diffCounts('--- a/f\n+++ b/f\n@@\n+a\n+b\n-c\n context\n'), { additions: 2, deletions: 1 });
});

test("a branch's open PR is found, or none", async t => {
	const twg = fakeCommand(t, 'twg', {
		[`bitbucket pull-requests query --source oo/testing-plan --state OPEN --limit 1 ${ARGS}`]: { stdout: JSON.stringify([PR]) },
		[`bitbucket pull-requests query --source oo/nothing --state OPEN --limit 1 ${ARGS}`]: { stdout: '[]' },
	});
	assert.deepEqual(await bitbucket.findPr('.', 'oo/testing-plan'), { number: 49, url: 'https://bitbucket.org/acme/widgets/pull-requests/49' });
	assert.equal(await bitbucket.findPr('.', 'oo/nothing'), undefined);
	assert.equal(twg.calls().length, 2);
});

test('opening a PR passes the title and description as values, even ones starting with a dash', async t => {
	const twg = fakeCommand(t, 'twg', { 'bitbucket pull-requests create': { stdout: JSON.stringify(PR) } });
	const pr = await bitbucket.createPr('.', THREAD, '-dash title', '- a bullet\n- another', 'oo/parent');
	assert.deepEqual(pr, { number: 49, url: 'https://bitbucket.org/acme/widgets/pull-requests/49' });
	assert.deepEqual(twg.calls()[0], [
		'bitbucket',
		'pull-requests',
		'create',
		'--title=-dash title',
		'--source=oo/testing-plan',
		'--dest=oo/parent',
		'--description=- a bullet\n- another',
		...ARGS.split(' '),
	]);
});

test('status comes from the PR and its mergeability checks', async t => {
	fakeCommand(t, 'twg', {
		[`bitbucket pull-requests get 49 ${ARGS}`]: { stdout: JSON.stringify(PR) },
		[`bitbucket pull-requests mergeability 49 ${ARGS}`]: { stdout: JSON.stringify(CONFLICTS) },
	});
	assert.deepEqual(await bitbucket.prStatus('.', { number: 49, url: '' }), { state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
});

test("merging moves on from a strategy the repo doesn't allow, but not from other failures", async t => {
	const refused = { stdout: JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', summary: 'Merge strategy merge_commit is not allowed' } }), exitCode: 1 };
	const twg = fakeCommand(t, 'twg', {
		'bitbucket pull-requests merge --pull-request 49 --merge-strategy merge_commit': refused,
		'bitbucket pull-requests merge --pull-request 49 --merge-strategy squash': { stdout: JSON.stringify({ ...PR, state: 'MERGED' }) },
	});
	assert.equal(await bitbucket.mergePr('.', 49), 'squash');
	assert.equal(twg.calls().length, 2);
	twg.answer({
		'bitbucket pull-requests merge': { stdout: JSON.stringify({ ok: false, error: { summary: 'The pull request has conflicts' } }), exitCode: 1 },
	});
	await assert.rejects(bitbucket.mergePr('.', 49), { message: 'Bitbucket: The pull request has conflicts' });
	assert.equal(twg.calls().length, 3);
});

test("reviewing isn't offered for Bitbucket", () => {
	assert.equal(bitbucket.canReview, false);
	assert.throws(() => bitbucket.viewerLogin('.'), /web UI/);
});
