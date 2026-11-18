import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../testHelpers.js';
import { sameCard, type CardProps } from './card.js';

test('a card redraws only when something it shows changed', () => {
	const { state } = fixture([{}, {}]);
	const [thread, blocker] = state.threads as [CardProps['thread'], CardProps['thread']];
	const props: CardProps = { thread, selected: false, project: state.projects[0], live: true, status: 'working', resumable: false, stalled: false, unreviewed: false, merge: undefined, blockers: [blocker], running: false, ports: '', tokens: 120_000, warmFor: '42m', compacted: false };
	// blockers is a new array every render.
	assert.ok(sameCard(props, { ...props, blockers: [blocker] }));
	assert.ok(!sameCard(props, { ...props, blockers: [] }));
	assert.ok(!sameCard(props, { ...props, blockers: [{ ...blocker, title: 'renamed' }] }));
	assert.ok(!sameCard(props, { ...props, status: 'stopped' }));
	assert.ok(!sameCard(props, { ...props, thread: { ...thread } }));
	assert.ok(sameCard(props, { ...props, tokens: 120_000, warmFor: '42m' }));
	assert.ok(!sameCard(props, { ...props, warmFor: '41m' }));
});
