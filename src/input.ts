import type { Key } from 'ink';

/** Apply a keypress to a single-line text field; undefined if the key isn't for the field. */
export function editText(value: string, input: string, key: Key): string | undefined {
	// Terminals disagree on whether backspace arrives as backspace or delete.
	if (key.backspace || key.delete) return value.slice(0, -1);
	if (input && !key.ctrl && !key.meta && !key.tab && !key.return && !key.escape) return value + input;
}
