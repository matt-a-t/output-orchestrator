import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Key } from 'ink';
import { parseQuiz } from './quiz.js';
import { answerKey, parseAnswerReply, parseResultsReply, resultsKey, startAnswers, type AnswerState } from './quizForm.js';

const key = (k: Partial<Key> = {}) => k as Key;
const quiz = parseQuiz(
	JSON.stringify({
		choices: [
			{ question: 'What happens when the push fails?', right: 'It retries once', wrong: ['It gives up', 'It loops forever', 'It deletes the branch'], why: 'pushBranch catches it.' },
			{ question: 'Who is told?', right: 'The board', wrong: ['Nobody', 'The PR'], why: 'It sets a message.' },
		],
		written: { question: 'Why only once?', answer: 'A second failure is almost never transient.' },
	}),
	() => 0.999,
)!;
const start = startAnswers(quiz);
const press = (state: AnswerState, ...keys: [string, Partial<Key>?][]) =>
	keys.reduce<AnswerState | { done: unknown }>((s, [input, k]) => ('done' in s ? s : answerKey(quiz, s, input, key(k))), state);

test('a choice is picked with its number, or stepped through with h/l and space', () => {
	assert.deepEqual((press(start, ['3']) as AnswerState).picks, [2, null, null]);
	// Past the last choice there's nothing to pick.
	assert.deepEqual((press(start, ['5']) as AnswerState).picks, [null, null, null]);
	assert.deepEqual((press(start, ['l']) as AnswerState).picks, [0, null, null]);
	assert.deepEqual((press(start, ['h']) as AnswerState).picks, [3, null, null]);
	assert.deepEqual((press(start, ['l'], [' '], ['l'], ['h']) as AnswerState).picks, [1, null, null]);
	assert.deepEqual((press(start, ['j'], ['l'], ['h']) as AnswerState).picks, [null, 2, null]);
});

test('j/k and ⏎ move between questions, ⏎ editing the written answer, and a submits', () => {
	assert.equal((press(start, ['k']) as AnswerState).field, 2);
	const editing = press(start, ['1'], ['', { return: true }], ['2'], ['', { return: true }]) as AnswerState;
	assert.deepEqual(editing, { picks: [0, 1, null], written: '', field: 2, edit: 0 });
	// Typed while editing, a, s and q are just letters.
	const typed = press(editing, ['a'], ['s'], ['q']) as AnswerState;
	assert.equal(typed.written, 'asq');
	assert.deepEqual(press(typed, ['', { escape: true }], ['a']), { done: [0, 1, 'asq'] });
	// Nothing picked is a null answer.
	assert.deepEqual(press(start, ['a']), { done: [null, null, ''] });
});

test('s skips the quiz and q or esc cancels it', () => {
	assert.deepEqual(press(start, ['s']), { done: 'skipped' });
	assert.deepEqual(press(start, ['q']), { done: null });
	assert.deepEqual(press(start, ['', { escape: true }]), { done: null });
});

test("the form's replies are read back, with anything malformed taken as cancelled", () => {
	assert.deepEqual(parseAnswerReply(JSON.stringify({ answers: [0, null, 'Flaky.'] }), quiz), { answers: [0, null, 'Flaky.'] });
	assert.equal(parseAnswerReply(JSON.stringify({ skipped: true }), quiz), 'skipped');
	assert.equal(parseAnswerReply(JSON.stringify({ cancelled: true }), quiz), null);
	assert.equal(parseAnswerReply(JSON.stringify({ answers: [9, null, ''] }), quiz), null);
	assert.equal(parseAnswerReply(JSON.stringify({ answers: [0, null] }), quiz), null);
	assert.equal(parseAnswerReply('vim was here', quiz), null);
	assert.equal(parseResultsReply(JSON.stringify({ open: true })), true);
	assert.equal(parseResultsReply(JSON.stringify({ open: false })), false);
	assert.equal(parseResultsReply(''), false);
});

test('the results go on with ⏎ or a when passed, ask y or n when not, and review only closes', () => {
	assert.equal(resultsKey('results', true, '', key({ return: true })), true);
	assert.equal(resultsKey('results', true, 'a', key()), true);
	assert.equal(resultsKey('results', true, 'y', key()), undefined);
	assert.equal(resultsKey('results', false, 'a', key()), undefined);
	assert.equal(resultsKey('results', false, 'y', key()), true);
	assert.equal(resultsKey('results', false, 'n', key()), false);
	assert.equal(resultsKey('results', false, 'q', key()), false);
	assert.equal(resultsKey('review', true, '', key({ return: true })), undefined);
	assert.equal(resultsKey('review', true, 'z', key()), false);
	assert.equal(resultsKey('review', false, '', key({ escape: true })), false);
});
