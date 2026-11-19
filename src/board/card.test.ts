import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../testHelpers.js';
import stringWidth from 'string-width';
import type { PrStatus } from '../prHost.js';
import { COLUMN_LABELS, type Column } from '../state.js';
import { cardLines, headMarks, nextLine, staleAge, LEGEND, LOCAL_BORDER_LINES, MIN_COLUMN_WIDTH, sameCard, type CardProps } from './card.js';

test('a card redraws only when something it shows changed', () => {
	const { state } = fixture([{}, {}]);
	const [thread, blocker] = state.threads as [CardProps['thread'], CardProps['thread']];
	const props: CardProps = { thread, selected: false, project: state.projects[0], live: true, status: 'working', resumable: false, stalled: false, unreviewed: false, merge: undefined, blockers: [blocker], running: false, ports: '', tokens: 120_000, warmFor: '42m', compacted: false, age: undefined };
	// blockers is a new array every render.
	assert.ok(sameCard(props, { ...props, blockers: [blocker] }));
	assert.ok(!sameCard(props, { ...props, blockers: [] }));
	assert.ok(!sameCard(props, { ...props, blockers: [{ ...blocker, title: 'renamed' }] }));
	assert.ok(!sameCard(props, { ...props, status: 'stopped' }));
	assert.ok(!sameCard(props, { ...props, thread: { ...thread } }));
	assert.ok(sameCard(props, { ...props, tokens: 120_000, warmFor: '42m' }));
	assert.ok(!sameCard(props, { ...props, warmFor: '41m' }));
});

test('unfinished cards take four lines and a gap, finished ones one line, and Local adds its outline', () => {
	const { state } = fixture([{}]);
	const thread = state.threads[0]!;
	assert.equal(cardLines({ ...thread, column: 'active' }), 5);
	assert.equal(cardLines({ ...thread, column: 'planned', local: true }), 7);
	assert.equal(cardLines({ ...thread, column: 'done' }), 1);
	assert.equal(cardLines({ ...thread, column: 'archived', local: true }), 3);
});

// Characters that can show as text or emoji: string-width (and so Ink) counts them one cell, but some terminals
// draw them two wide (Windows Terminal does ⚙ ⏸ ✉), which wraps full-width rows and throws Ink's redraw off.
test('badges are glyphs terminals and Ink agree on the width of', () => {
	for (const [badge] of LEGEND)
		for (const ch of badge) assert.ok(!/\p{Extended_Pictographic}/u.test(ch) || /\p{Emoji_Presentation}/u.test(ch), `${ch} in ${badge} can draw as a wide emoji`);
});

test("a card's first line fits the narrowest column with every mark its column can show", () => {
	const { state } = fixture([{}, {}]);
	const [base, blocker] = state.threads as [CardProps['thread'], CardProps['thread']];
	const message = { from: '1', text: 'hi', ts: new Date(0).toISOString(), delivered: false };
	for (const column of Object.keys(COLUMN_LABELS) as Column[]) {
		// A three-digit id, and every alert at once with a one-digit count.
		const thread: CardProps['thread'] = {
			...base,
			id: '999',
			column,
			local: true,
			priority: 'high',
			rebaseFrom: 'abc',
			inbox: Array(9).fill(message),
			// A step after the merge left in Follow-up; elsewhere, every step before it approved.
			todos: column === 'followup' ? [{ subject: 'deploy', status: 'pending', afterMerge: true }] : [{ subject: 'do it', status: 'done' }],
		};
		const props: CardProps = { thread, selected: true, project: state.projects[0], live: true, status: 'waiting', resumable: true, stalled: true, unreviewed: true, // Only threads in PR have their merge state polled.
			merge: column === 'pr' ? ({ mergeable: 'CONFLICTING' } as PrStatus) : undefined, blockers: Array(9).fill(blocker), running: true, job: 'leaving Local', ports: '3000→49153', tokens: undefined, warmFor: undefined, compacted: false, age: undefined };
		const width = stringWidth(headMarks(props).map(m => m.text).join(''));
		// The Local outline takes a column each side, and one is left between columns.
		assert.ok(width + LOCAL_BORDER_LINES + 1 <= MIN_COLUMN_WIDTH, `${column}: ${headMarks(props).map(m => m.text).join('')} is ${width} wide`);
	}
});

test("a card's third line shows what moves it on from its column", () => {
	const { state } = fixture([{}]);
	const thread = state.threads[0]!;
	const text = (t: Partial<CardProps['thread']>, merge?: PrStatus) => nextLine({ ...thread, ...t }, merge).map(m => m.text).join('');
	assert.equal(text({ column: 'planned', plan: '# Rework the cards\n\nMore.' }), 'Rework the cards');
	assert.equal(text({ column: 'planned', plan: '' }), '');
	const steps = [
		{ subject: 'one', status: 'done' as const },
		{ subject: 'two', status: 'pending' as const },
		{ subject: 'deploy', status: 'pending' as const, afterMerge: true },
	];
	assert.equal(text({ column: 'active', todos: steps }), '1/3 ▸ two');
	assert.equal(text({ column: 'active', todos: [steps[0]!, { subject: 'two', status: 'review' }] }), '1/2 ● two');
	assert.equal(text({ column: 'active', todos: [] }), '');
	assert.equal(text({ column: 'polish' }), 'commit pr quiz');
	assert.equal(
		text({ column: 'polish', drafts: { commit: 'Do it', pr: { title: 'Do it', body: '' } }, quiz: { questions: [], answers: [], grades: [], result: 'passed', score: '4/5', at: '' } }),
		'commit✓ pr✓ quiz 4/5',
	);
	assert.equal(text({ column: 'pr', pr: { number: 123, url: '' } }, { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' } as PrStatus), '#123 ready to merge');
	assert.equal(text({ column: 'pr', pr: { number: 123, url: '' } }), '#123');
	assert.equal(text({ column: 'followup', todos: steps }), '⤳1 deploy');
	assert.equal(text({ column: 'done', todos: steps }), '');
	// A background job takes the line while it runs.
	assert.equal(nextLine({ ...thread, column: 'active', todos: steps }, undefined, 'leaving Local').map(m => m.text).join(''), '⟳ leaving Local');
});

test("a card shows its age once it's gone a day unchanged", () => {
	const now = Date.parse('2026-11-19T12:00:00Z');
	assert.equal(staleAge('2026-11-19T00:00:00Z', now), undefined);
	assert.equal(staleAge('2026-11-18T12:00:00Z', now), '1d');
	assert.equal(staleAge('2026-11-16T11:00:00Z', now), '3d');
});
