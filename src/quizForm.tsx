import { readFileSync, writeFileSync } from 'node:fs';
import { useState } from 'react';
import { Box, render, Text, useApp, useInput, type Key } from 'ink';
import { EDITING_HELP, FIELD_HELP, FieldText } from './fieldText.js';
import { choiceStep, fieldKey, fieldStep, isBack, isSubmit, loop, nextField, type Edit } from './input.js';
import type { Answers, Grade, Quiz } from './quiz.js';
import { OO_COMMAND } from './status.js';

/** The form as an editor command for progressPopup (see COMMIT_FORM for why it's joined unquoted). */
export const QUIZ_FORM = [...OO_COMMAND, 'quiz-form'].join(' ');

/**
 * What the form is opened on: the quiz to answer, or how it went, either before the PR opens (results, which
 * asks whether to go on) or afterwards from the board (review, which only shows it).
 */
export type QuizFormInput =
	| { mode: 'answer'; title: string; quiz: Quiz }
	| { mode: 'results' | 'review'; title: string; quiz: Quiz; answers: Answers; grades: Grade[] };

/** What the answer form gives back: the answers, skipped, or null if it was cancelled. */
export type AnswerReply = { answers: Answers } | 'skipped' | null;

export function parseAnswerReply(text: string, quiz: Quiz): AnswerReply {
	try {
		const json = JSON.parse(text) as { answers?: unknown; skipped?: unknown };
		if (json.skipped === true) return 'skipped';
		const answers = json.answers;
		if (!Array.isArray(answers) || answers.length !== quiz.length) return null;
		const ok = quiz.every((q, i) => (q.kind === 'text' ? typeof answers[i] === 'string' : answers[i] === null || (Number.isInteger(answers[i]) && answers[i] >= 0 && answers[i] < q.choices.length)));
		return ok ? { answers: answers as Answers } : null;
	} catch {
		return null;
	}
}

/** Whether the results form said to go on to the PR (open it anyway, if any answer was wrong); false if cancelled. */
export function parseResultsReply(text: string): boolean {
	try {
		return (JSON.parse(text) as { open?: unknown }).open === true;
	} catch {
		return false;
	}
}

/** The answer form: a pick (or none) per choice question, the written answer, the focused field and its `edit`. */
export type AnswerState = { picks: (number | null)[]; written: string; field: number; edit: Edit };

export const startAnswers = (quiz: Quiz): AnswerState => ({ picks: quiz.map(() => null), written: '', field: 0, edit: null });

const answersOf = (quiz: Quiz, state: AnswerState): Answers => quiz.map((q, i) => (q.kind === 'text' ? state.written : state.picks[i]!));

/** Apply a keypress to the answer form: the new state, or what it ends with (null if cancelled). */
export function answerKey(quiz: Quiz, state: AnswerState, input: string, key: Key): AnswerState | { done: Answers | 'skipped' | null } {
	const question = quiz[state.field]!;
	if (question.kind === 'text') {
		const next = fieldKey(state.written, state.edit, input, key);
		if (next) return { ...state, written: next.value, edit: next.edit };
	}
	if (isBack(input, key, state.edit)) return { done: null };
	if (isSubmit(input, key, state.edit)) return { done: answersOf(quiz, state) };
	if (typeof state.edit !== 'number' && input === 's' && !key.ctrl && !key.meta) return { done: 'skipped' };
	if (key.return) {
		const { field, edit } = nextField(state.field, quiz.length, i => (quiz[i]!.kind === 'text' ? state.written.length : undefined));
		return { ...state, field, edit };
	}
	const step = fieldStep(input, key);
	if (step) return { ...state, field: loop(state.field, step, quiz.length), edit: null };
	if (question.kind === 'choice') {
		const picks = [...state.picks];
		const n = Number(input);
		if (/^[1-9]$/.test(input) && n <= question.choices.length) picks[state.field] = n - 1;
		else {
			const turn = choiceStep(input, key);
			// From none picked, l starts at the first and h at the last.
			if (turn) picks[state.field] = loop(picks[state.field] ?? (turn > 0 ? -1 : 0), turn, question.choices.length);
		}
		return { ...state, picks, edit: null };
	}
	return { ...state, edit: null };
}

/** A keypress on the results: true to go on to the PR, false to stop, undefined to ignore it. `review` only closes. */
export function resultsKey(mode: 'results' | 'review', passed: boolean, input: string, key: Key): boolean | undefined {
	if (key.escape || input === 'q') return false;
	if (mode === 'review') return input === 'z' ? false : undefined;
	if (passed) return key.return || input === 'a' ? true : undefined;
	return input === 'y' ? true : input === 'n' ? false : undefined;
}

export const score = (grades: Grade[]) => `${grades.filter(g => g.correct).length}/${grades.length}`;

function Header({ title }: { title: string }) {
	return (
		<Text bold>
			Pop quiz on {title}
		</Text>
	);
}

function AnswerForm({ title, quiz, onDone }: { title: string; quiz: Quiz; onDone: (reply: Answers | 'skipped' | null) => void }) {
	const { exit } = useApp();
	const [state, setState] = useState(() => startAnswers(quiz));
	useInput((input, key) => {
		const next = answerKey(quiz, state, input, key);
		if ('done' in next) {
			onDone(next.done);
			return exit();
		}
		setState(next);
	});
	const editing = typeof state.edit === 'number';
	return (
		<Box flexDirection="column">
			<Header title={title} />
			{quiz.map((q, i) => {
				const focused = i === state.field;
				return (
					<Box key={i} flexDirection="column" marginTop={1}>
						<Text color={focused ? 'cyan' : undefined} bold={focused}>
							{focused ? '› ' : '  '}
							{i + 1}. {q.question}
						</Text>
						{q.kind === 'choice' ? (
							q.choices.map((c, n) => (
								<Text key={n} dimColor={!focused && state.picks[i] !== n}>
									{'    '}
									{state.picks[i] === n ? '(●)' : '( )'} {n + 1} {c}
								</Text>
							))
						) : (
							<Text>
								{'    '}
								{state.written || focused ? <FieldText value={state.written} edit={focused ? state.edit : null} /> : <Text dimColor>(your answer, in a sentence or two)</Text>}
							</Text>
						)}
					</Box>
				);
			})}
			<Box flexGrow={1} />
			<Text dimColor>
				{editing
					? EDITING_HELP
					: quiz[state.field]!.kind === 'choice'
						? '1–4 or h/l pick  j/k question  a submit  s skip the quiz  q/esc cancel'
						: `${FIELD_HELP}  j/k question  a submit  s skip the quiz  q/esc cancel`}
			</Text>
		</Box>
	);
}

/** What you got right and wrong; `results` also asks whether to go on, `review` only shows it. */
function Results({ input, onDone }: { input: Extract<QuizFormInput, { mode: 'results' | 'review' }>; onDone: (open: boolean) => void }) {
	const { exit } = useApp();
	const { mode, title, quiz, answers, grades } = input;
	const passed = grades.every(g => g.correct);
	useInput((input, key) => {
		const open = resultsKey(mode, passed, input, key);
		if (open === undefined) return;
		onDone(open);
		exit();
	});
	const help =
		mode === 'review' ? 'q/esc close' : passed ? '⏎/a go on to the PR description  q/esc cancel the PR' : 'open the PR anyway? y open it  n/q/esc don’t';
	return (
		<Box flexDirection="column">
			<Header title={title} />
			<Text>
				{passed ? <Text color="green">✓ {score(grades)}</Text> : <Text color="red">✗ {score(grades)}</Text>}
				{passed ? '' : ' — the PR opens only if you say so'}
			</Text>
			{quiz.map((q, i) => {
				const grade = grades[i]!;
				const answer = answers[i];
				const yours = q.kind === 'choice' ? (typeof answer === 'number' ? q.choices[answer] : undefined) : typeof answer === 'string' && answer.trim() ? answer : undefined;
				const right = q.kind === 'choice' ? q.choices[q.answer] : q.answer;
				return (
					<Box key={i} flexDirection="column" marginTop={1}>
						<Text>
							{grade.correct ? <Text color="green">✓</Text> : <Text color="red">✗</Text>} {i + 1}. {q.question}
						</Text>
						<Text>
							{'    '}
							<Text dimColor>you: </Text>
							{yours ?? <Text dimColor>(no answer)</Text>}
						</Text>
						{q.kind === 'text' || !grade.correct ? (
							<Text>
								{'    '}
								<Text dimColor>answer: </Text>
								{right}
							</Text>
						) : null}
						{grade.note ? (
							<Text dimColor>
								{'    '}
								{grade.note}
							</Text>
						) : null}
					</Box>
				);
			})}
			<Box flexGrow={1} />
			<Text dimColor={passed || mode === 'review'} color={passed || mode === 'review' ? undefined : 'yellow'}>
				{help}
			</Text>
		</Box>
	);
}

/** `oo quiz-form <file>`: answer the quiz in `file`, or see how it went, with the reply written back to it. */
export async function quizFormCommand([file]: string[]): Promise<number> {
	if (!file) {
		console.error('usage: oo quiz-form <file>');
		return 1;
	}
	const input = JSON.parse(readFileSync(file, 'utf8')) as QuizFormInput;
	let reply: object = { cancelled: true };
	const app =
		input.mode === 'answer'
			? render(<AnswerForm title={input.title} quiz={input.quiz} onDone={r => (reply = r === null ? { cancelled: true } : r === 'skipped' ? { skipped: true } : { answers: r })} />)
			: render(<Results input={input} onDone={open => (reply = { open })} />);
	await app.waitUntilExit();
	writeFileSync(file, JSON.stringify(reply));
	return 0;
}
