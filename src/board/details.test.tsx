import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Box, renderToString } from 'ink';
import type { PrStatus } from '../prHost.js';
import { fakeBoard, fixture } from '../testHelpers.js';
import { Details, DETAIL_TABS, type DetailTab } from './details.js';

const { state } = fixture([
	{
		title: 'Rework the cards',
		plan: '# Card rethink\n\nFour lines a card.',
		ticket: { key: 'AV-12', url: 'https://jira/AV-12', author: 'someone' },
		pr: { number: 123, url: 'https://github/pr/123' },
		todos: [
			{ subject: 'Pack the alerts', status: 'done' },
			{ subject: 'Add line 3', status: 'review' },
		],
		inbox: [{ from: '2', text: 'the glyphs changed', ts: new Date().toISOString(), delivered: false }],
		drafts: { commit: 'Give cards a line for what moves each thread on' },
		quiz: {
			questions: [{ kind: 'text', question: 'Why four lines?', answer: 'Room for line 3' }],
			answers: ['for line 3'],
			grades: [{ correct: true, note: 'Right.' }],
			result: 'passed',
			score: '1/1',
			at: new Date().toISOString(),
		},
		blockedBy: ['2'],
	},
	{ title: 'The blocker' },
]);
const board = fakeBoard(state);
const thread = state.threads[0]!;

const render = (tab: DetailTab) =>
	renderToString(
		// The board gives it the rows under its title bar.
		<Box flexDirection="column" height={30}>
			<Details board={board} state={state} thread={thread} tab={tab} setTab={() => {}} merge={{ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' } as PrStatus} active={false} onClose={() => {}} />
		</Box>,
		{ columns: 120 },
	);

test("each of a thread's details tabs shows its part", () => {
	const expected: Record<DetailTab, string[]> = {
		overview: ['Rework the cards', 'AV-12', '#123 ready to merge', '#2 The blocker', 'not started'],
		plan: ['# Card rethink', 'Four lines a card.'],
		steps: ['Pack the alerts', 'Add line 3'],
		messages: ['from #2', 'waiting for its claude', 'the glyphs changed'],
		quiz: ['1/1 passed', 'Why four lines?', 'for line 3'],
		info: ['Give cards a line for what moves each thread on'],
	};
	for (const tab of DETAIL_TABS) {
		const out = render(tab);
		// The tab bar, on every tab.
		assert.match(out, /3 steps 1\/2.*4 messages 1 \(1 new\)/);
		for (const text of expected[tab]) assert.ok(out.includes(text), `${tab} doesn't show ${text}:\n${out}`);
	}
});
