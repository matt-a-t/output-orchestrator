import { readFileSync, writeFileSync } from 'node:fs';
import { useState } from 'react';
import { Box, render, Text, useApp, useInput, type Key } from 'ink';
import { EDITING_HELP, FIELD_HELP, FieldText, formHelp, SubmitRow, submitHelp } from './fieldText.js';
import { fieldKey, fieldStep, isBack, isSubmit, loop, nextField, type Edit } from './input.js';
import { OO_COMMAND } from './status.js';

/**
 * The form as an editor command for progressPopup, which runs it as `$editor "$dir/edit.md"`: joined
 * unquoted since bash only word-splits it, which holds as long as oo's own path has no spaces.
 */
export const COMMIT_FORM = [...OO_COMMAND, 'commit-form'].join(' ');

/** What the form edits: the commit message and comments for claude. An empty message means cancelled. */
export type CommitForm = { message: string; notes: string };

/** What the form is opened on: the drafted message and a note shown under it. */
export function commitFormText(message: string, note?: string): string {
	return JSON.stringify({ message, note });
}

/** Read back the form once submitted; null if it was cancelled or the message left empty. */
export function parseCommitForm(text: string): CommitForm | null {
	try {
		const { message, notes } = JSON.parse(text) as Partial<CommitForm>;
		return message?.trim() ? { message: message.trim(), notes: notes?.trim() ?? '' } : null;
	} catch {
		return null;
	}
}

/** `field` 2 is the [ Commit ] row. `edit` is the focused field's (see fieldKey). */
export type FormState = { values: [string, string]; field: 0 | 1 | 2; edit: Edit };

const SUBMIT = 2;

/** Apply a keypress to the form: the new state, or what it ends with (null if cancelled). */
export function formKey(state: FormState, input: string, key: Key): FormState | { done: CommitForm | null } {
	const { field: at } = state;
	if (at !== SUBMIT) {
		const next = fieldKey(state.values[at], state.edit, input, key);
		if (next) {
			const values: [string, string] = [...state.values];
			values[at] = next.value;
			return { ...state, values, edit: next.edit };
		}
	}
	if (isBack(input, key, state.edit)) return { done: null };
	if (isSubmit(key) || (key.return && at === SUBMIT)) return { done: { message: state.values[0], notes: state.values[1] } };
	if (key.return) {
		const { field, edit } = nextField(at, SUBMIT + 1, i => state.values[i]?.length);
		return { ...state, field: field as FormState['field'], edit };
	}
	const step = fieldStep(input, key);
	if (step) return { ...state, field: loop(at, step, SUBMIT + 1) as FormState['field'], edit: null };
	return { ...state, edit: null };
}

const LABELS = ['commit:', 'for claude:'];
const LABEL_WIDTH = Math.max(...LABELS.map(l => l.length)) + 1;

function Form({ initial, note, onDone }: { initial: string; note?: string; onDone: (result: CommitForm | null) => void }) {
	const { exit } = useApp();
	const [state, setState] = useState<FormState>({ values: [initial, ''], field: 0, edit: null });
	useInput((input, key) => {
		const next = formKey(state, input, key);
		if ('done' in next) {
			onDone(next.done);
			return exit();
		}
		setState(next);
	});
	return (
		<Box flexDirection="column">
			{LABELS.map((label, i) => (
				<Text key={label}>
					<Text dimColor={i !== state.field}>{label.padEnd(LABEL_WIDTH)}</Text>
					<FieldText value={state.values[i]!} edit={i === state.field ? state.edit : null} />
				</Text>
			))}
			<SubmitRow label="Commit" active={state.field === SUBMIT} indent={LABEL_WIDTH - 2} />
			{note ? <Text color="yellow">{note}</Text> : null}
			<Box flexGrow={1} />
			<Text dimColor>
				{typeof state.edit === 'number' ? EDITING_HELP : state.field === SUBMIT ? submitHelp('commit') : `${FIELD_HELP}  ${formHelp('commit')}`}
			</Text>
		</Box>
	);
}

/** `oo commit-form <file>`: edit the commit message and comments in `file`, written back on submit. */
export async function commitFormCommand([file]: string[]): Promise<number> {
	if (!file) {
		console.error('usage: oo commit-form <file>');
		return 1;
	}
	const { message = '', note } = JSON.parse(readFileSync(file, 'utf8')) as { message?: string; note?: string };
	let result: CommitForm | null = null;
	const app = render(<Form initial={message} note={note} onDone={r => (result = r)} />);
	await app.waitUntilExit();
	writeFileSync(file, JSON.stringify(result ?? { message: '', notes: '' }));
	return 0;
}
