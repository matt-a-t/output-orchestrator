import { readFileSync, writeFileSync } from 'node:fs';
import { useState } from 'react';
import { Box, render, Text, useApp, useInput, type Key } from 'ink';
import { editText } from './input.js';
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

export type FormState = { values: [string, string]; field: 0 | 1 };

/** Apply a keypress to the form: the new state, or what it ends with (null if cancelled). */
export function formKey(state: FormState, input: string, key: Key): FormState | { done: CommitForm | null } {
	if (key.escape) return { done: null };
	if (key.return) return { done: { message: state.values[0], notes: state.values[1] } };
	if (key.tab || key.upArrow || key.downArrow) return { ...state, field: state.field === 0 ? 1 : 0 };
	const value = editText(state.values[state.field], input, key);
	if (value === undefined) return state;
	const values: [string, string] = [...state.values];
	values[state.field] = value;
	return { ...state, values };
}

const LABELS = ['commit:', 'for claude:'];
const LABEL_WIDTH = Math.max(...LABELS.map(l => l.length)) + 1;

function Form({ initial, note, onDone }: { initial: string; note?: string; onDone: (result: CommitForm | null) => void }) {
	const { exit } = useApp();
	const [state, setState] = useState<FormState>({ values: [initial, ''], field: 0 });
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
					{state.values[i]}
					{i === state.field ? <Text inverse> </Text> : null}
				</Text>
			))}
			{note ? <Text color="yellow">{note}</Text> : null}
			<Box flexGrow={1} />
			<Text dimColor>tab or ↑/↓ field  ⏎ commit  esc cancel  ctrl-u clear  ctrl-w delete word</Text>
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
