import type { Key } from 'ink';

/** Apply a keypress to a single-line text field; undefined if the key isn't for the field. */
export function editText(value: string, input: string, key: Key): string | undefined {
	// Terminals disagree on whether backspace arrives as backspace or delete.
	if (key.backspace || key.delete) return value.slice(0, -1);
	if (input && !key.ctrl && !key.meta && !key.tab && !key.return && !key.escape) return value + input;
}

/** Step `index` by `delta` through a list of `length` items, looping at both ends. */
export function loop(index: number, delta: number, length: number): number {
	return length === 0 ? 0 : (((index + delta) % length) + length) % length;
}
