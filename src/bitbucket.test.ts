import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { bitbucket, bitbucketError, bitbucketRepo, diffCounts, MERGE_WAIT, mergeStatus, openPrQuery, toDetails, type BitbucketPr, type MergeSignals } from './bitbucket.js';
import { checksLabel, mergeLabel } from './prHost.js';
import type { Thread } from './state.js';
import { git } from './testHelpers.js';

// Cut down from what `GET /2.0/repositories/acme/widgets/pullrequests/49` answers.
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
};

const SIGNALS = (diffstat: string[] = ['modified'], statuses: string[] = []): MergeSignals => ({
	diffstat: diffstat.map(status => ({ status })),
	statuses: statuses.map(state => ({ state, name: state.toLowerCase() })),
});
const CONFLICTS = SIGNALS(['modified', 'merge conflict']);
const CLEAN = SIGNALS();

const THREAD = { id: '1', branch: 'oo/testing-plan' } as Thread;

test("a Bitbucket remote's workspace and repo, in each form, and none for GitHub", () => {
	const widgets = { workspace: 'acme', repo: 'widgets' };
	assert.deepEqual(bitbucketRepo('https://someone@bitbucket.org/acme/widgets.git'), widgets);
	assert.deepEqual(bitbucketRepo('https://bitbucket.org/acme/widgets'), widgets);
	assert.deepEqual(bitbucketRepo('https://bitbucket.org/acme/widgets/\n'), widgets);
	assert.deepEqual(bitbucketRepo('git@bitbucket.org:acme/widgets.git'), widgets);
	assert.deepEqual(bitbucketRepo('ssh://git@bitbucket.org/acme/widgets.git'), widgets);
	assert.deepEqual(bitbucketRepo('git@bitbucket.org:acme/my.repo.git'), { workspace: 'acme', repo: 'my.repo' });
	assert.equal(bitbucketRepo('https://github.com/acme/widgets.git'), undefined);
	assert.equal(bitbucketRepo('https://github.com/someone/bitbucket.org-mirror'), undefined);
	assert.equal(bitbucketRepo(''), undefined);
});

test("Bitbucket's error is what's thrown, and a 401 says which credentials to fix", () => {
	assert.match(bitbucketError(401, '').message, /^Bitbucket said 401: check BITBUCKET_EMAIL .* and BITBUCKET_API_TOKEN/);
	assert.match(bitbucketError(403, '{}').message, /BITBUCKET_API_TOKEN/);
	const body = JSON.stringify({ type: 'error', error: { message: 'You can\'t merge until you resolve all merge conflicts.' } });
	assert.equal(bitbucketError(400, body).message, "Bitbucket said 400: You can't merge until you resolve all merge conflicts.");
	assert.equal(bitbucketError(404, 'not json').message, 'Bitbucket said 404');
});

test("mergeability reads as GitHub's, so the board's labels work unchanged", () => {
	const open = { state: 'OPEN' as const, participants: [] };
	assert.deepEqual(mergeLabel(mergeStatus(open, CONFLICTS)), ['conflicts with base', 'red']);
	assert.deepEqual(mergeLabel(mergeStatus(open, CLEAN)), ['ready to merge', 'green']);
	assert.deepEqual(mergeLabel(mergeStatus(open, SIGNALS(['modified'], ['SUCCESSFUL', 'FAILED']))), ['blocked (reviews/checks)', 'yellow']);
	assert.deepEqual(mergeLabel(mergeStatus(open, SIGNALS(['modified'], ['STOPPED']))), ['blocked (reviews/checks)', 'yellow']);
	assert.deepEqual(mergeLabel(mergeStatus(open, SIGNALS(['modified'], ['INPROGRESS']))), ['ready to merge', 'green']);
	const sentBack = { ...open, participants: [{ state: 'changes_requested' }] };
	assert.deepEqual(mergeLabel(mergeStatus(sentBack, CLEAN)), ['blocked (reviews/checks)', 'yellow']);
	// Couldn't say: UNKNOWN keeps what the board last knew.
	assert.equal(mergeStatus(open, undefined).mergeable, 'UNKNOWN');
	assert.equal(mergeStatus({ state: 'MERGED' }, CLEAN).state, 'MERGED');
	assert.equal(mergeStatus({ state: 'DECLINED' }, CLEAN).state, 'CLOSED');
	assert.equal(mergeStatus({ state: 'SUPERSEDED' }, undefined).state, 'CLOSED');
});

test("a branch's query quotes its name", () => {
	assert.equal(openPrQuery('oo/x'), 'source.branch.name = "oo/x" AND state = "OPEN"');
	assert.equal(openPrQuery('a"b\\c'), 'source.branch.name = "a\\"b\\\\c" AND state = "OPEN"');
});

test('the viewer gets the PR in the shape it shows', () => {
	const pr: BitbucketPr = {
		...PR,
		participants: [
			{ role: 'REVIEWER', approved: true, state: 'approved', user: { display_name: 'Rae Viewer' } },
			{ role: 'PARTICIPANT', approved: false, state: null, user: { display_name: 'Just Commented' } },
		],
	};
	const signals: MergeSignals = {
		diffstat: [{ status: 'merge conflict' }],
		statuses: [
			{ state: 'SUCCESSFUL', name: 'build' },
			{ state: 'INPROGRESS', key: 'e2e' },
		],
	};
	const details = toDetails(pr, signals, 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new\n+more\n');
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


const REPO = 'https://api.bitbucket.org/2.0/repositories/acme/widgets';

/** A checkout whose origin is acme/widgets on Bitbucket. */
async function checkout(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), 'oo-bitbucket-'));
	await git(dir, 'init', '-q');
	await git(dir, 'remote', 'add', 'origin', 'git@bitbucket.org:acme/widgets.git');
	return dir;
}

type Call = { url: string; method: string; auth?: string; body?: any };

/** Bitbucket answering `routes` (by URL after the repo's, longest first), with BITBUCKET_* set; records the calls. */
function mockBitbucket(t: TestContext, routes: Record<string, () => Response>, env: Record<string, string | undefined> = { BITBUCKET_EMAIL: 'me@example.com', BITBUCKET_API_TOKEN: 'token' }) {
	for (const [name, value] of Object.entries(env)) {
		const was = process.env[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
		t.after(() => void (was === undefined ? delete process.env[name] : (process.env[name] = was)));
	}
	const calls: Call[] = [];
	t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
		const headers = init.headers as Record<string, string>;
		calls.push({ url, method: init.method!, auth: headers.Authorization, body: init.body ? JSON.parse(String(init.body)) : undefined });
		const path = url.startsWith(REPO) ? url.slice(REPO.length) : url;
		const key = Object.keys(routes)
			.filter(k => path.startsWith(k))
			.sort((a, b) => b.length - a.length)[0];
		return key === undefined ? new Response('{"type":"error","error":{"message":"no route"}}', { status: 404 }) : routes[key]!();
	});
	return calls;
}

const page = (values: unknown[]) => Response.json({ values });

test("a branch's open PR is found, or none, with the token as basic auth", async t => {
	const cwd = await checkout();
	const calls = mockBitbucket(t, {
		[`/pullrequests?${new URLSearchParams({ q: openPrQuery('oo/testing-plan'), pagelen: '1' })}`]: () => page([PR]),
		'/pullrequests?': () => page([]),
	});
	assert.deepEqual(await bitbucket.findPr(cwd, 'oo/testing-plan'), { number: 49, url: 'https://bitbucket.org/acme/widgets/pull-requests/49' });
	assert.equal(await bitbucket.findPr(cwd, 'oo/nothing'), undefined);
	assert.equal(calls.length, 2);
	assert.equal(calls[0]!.auth, `Basic ${Buffer.from('me@example.com:token').toString('base64')}`);
});

test('without the credentials, nothing is sent and the error says what to set', async t => {
	const cwd = await checkout();
	const calls = mockBitbucket(t, {}, { BITBUCKET_EMAIL: undefined, BITBUCKET_API_TOKEN: undefined });
	await assert.rejects(bitbucket.findPr(cwd, 'oo/x'), /^Error: Set BITBUCKET_EMAIL .* to use Bitbucket PRs$/);
	assert.equal(calls.length, 0);
});

test('a 401 says which credentials to fix', async t => {
	const cwd = await checkout();
	mockBitbucket(t, { '/pullrequests/49': () => new Response('', { status: 401 }) });
	await assert.rejects(bitbucket.prStatus(cwd, { number: 49, url: '' }), /Bitbucket said 401: check BITBUCKET_EMAIL/);
});

test('opening a PR sends its title, description, source and destination', async t => {
	const cwd = await checkout();
	const calls = mockBitbucket(t, { '/pullrequests': () => Response.json(PR, { status: 201 }) });
	const pr = await bitbucket.createPr(cwd, THREAD, '-dash title', '- a bullet', 'oo/parent');
	assert.deepEqual(pr, { number: 49, url: 'https://bitbucket.org/acme/widgets/pull-requests/49' });
	assert.deepEqual(calls[0], {
		url: `${REPO}/pullrequests`,
		method: 'POST',
		auth: calls[0]!.auth,
		body: { title: '-dash title', description: '- a bullet', source: { branch: { name: 'oo/testing-plan' } }, destination: { branch: { name: 'oo/parent' } } },
	});
	await bitbucket.createPr(cwd, THREAD, 't', 'b');
	assert.equal(calls[1]!.body.destination, undefined);
});

test('retargeting changes only the destination', async t => {
	const cwd = await checkout();
	const calls = mockBitbucket(t, { '/pullrequests/49': () => Response.json(PR) });
	await bitbucket.retargetPr(cwd, { number: 49, url: '' }, 'main');
	assert.deepEqual([calls[0]!.method, calls[0]!.url, calls[0]!.body], ['PUT', `${REPO}/pullrequests/49`, { destination: { branch: { name: 'main' } } }]);
});

test('status comes from the PR, its diffstat and its builds, and a closed PR skips the last two', async t => {
	const cwd = await checkout();
	let state = 'OPEN';
	const calls = mockBitbucket(t, {
		'/pullrequests/49': () => Response.json({ ...PR, state }),
		'/pullrequests/49/diffstat': () => page([{ status: 'merge conflict' }]),
		'/pullrequests/49/statuses': () => page([]),
	});
	assert.deepEqual(await bitbucket.prStatus(cwd, { number: 49, url: '' }), { state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
	assert.equal(calls.length, 3);
	state = 'MERGED';
	assert.equal((await bitbucket.prStatus(cwd, { number: 49, url: '' })).state, 'MERGED');
	assert.equal(calls.length, 4);
});

test("the viewer's details carry the diff and builds", async t => {
	const cwd = await checkout();
	mockBitbucket(t, {
		'/pullrequests/49': () => Response.json(PR),
		'/pullrequests/49/diffstat': () => page([{ status: 'modified' }]),
		'/pullrequests/49/statuses': () => page([{ state: 'SUCCESSFUL', name: 'build' }]),
		'/pullrequests/49/diff': () => new Response('--- a/x\n+++ b/x\n+new\x1b[31m\n'),
	});
	const details = await bitbucket.prDetails(cwd, 49);
	assert.equal(details.mergeStateStatus, 'CLEAN');
	assert.deepEqual(checksLabel(details.statusCheckRollup), ['checks: 1 passing', 'green']);
	assert.equal(details.additions, 1);
	assert.equal(await bitbucket.prDiff(cwd, 49), '--- a/x\n+++ b/x\n+new\n');
});

test('merging makes a merge commit, waits for one Bitbucket finishes later, and a failure is final', async t => {
	const cwd = await checkout();
	MERGE_WAIT.every = 1;
	t.after(() => void (MERGE_WAIT.every = 2_000));
	const tasks = ['PENDING', 'SUCCESS'];
	let merge = () => Response.json({ ...PR, state: 'MERGED' });
	const calls = mockBitbucket(t, {
		'/pullrequests/49/merge': () => merge(),
		'/pullrequests/49/merge/task-status/1': () => Response.json({ task_status: tasks.shift() }),
	});
	assert.equal(await bitbucket.mergePr(cwd, 49), 'merge commit');
	assert.deepEqual(calls[0]!.body, { merge_strategy: 'merge_commit' });
	merge = () => new Response('', { status: 202, headers: { Location: `${REPO}/pullrequests/49/merge/task-status/1` } });
	assert.equal(await bitbucket.mergePr(cwd, 49), 'merge commit');
	assert.equal(calls.length, 4);
	merge = () => Response.json({ type: 'error', error: { message: 'Merge strategy merge_commit is not allowed' } }, { status: 400 });
	await assert.rejects(bitbucket.mergePr(cwd, 49), { message: 'Bitbucket said 400: Merge strategy merge_commit is not allowed' });
});

test('a task link off api.bitbucket.org is never sent the token', async t => {
	const cwd = await checkout();
	const calls = mockBitbucket(t, { '/pullrequests/49/merge': () => new Response('', { status: 202, headers: { Location: 'https://evil.example/task' } }) });
	await assert.rejects(bitbucket.mergePr(cwd, 49), /won't send the token to evil\.example/);
	assert.equal(calls.length, 1);
});

test("reviewing isn't offered for Bitbucket", () => {
	assert.equal(bitbucket.canReview, false);
	assert.throws(() => bitbucket.viewerLogin('.'), /web UI/);
});
