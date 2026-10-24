import type { Key } from 'ink';

/** Apply a keypress to a single-line text field at `cursor`; undefined if the key isn't for the field. */
export function editAt(value: string, cursor: number, input: string, key: Key): { value: string; cursor: number } | undefined {
	const before = value.slice(0, cursor);
	const after = value.slice(cursor);
	if (key.leftArrow) return { value, cursor: Math.max(0, cursor - 1) };
	if (key.rightArrow) return { value, cursor: Math.min(value.length, cursor + 1) };
	if (key.ctrl && input === 'a') return { value, cursor: 0 };
	if (key.ctrl && input === 'e') return { value, cursor: value.length };
	// Terminals disagree on whether backspace arrives as backspace or delete.
	if (key.backspace || key.delete) return { value: before.slice(0, -1) + after, cursor: Math.max(0, cursor - 1) };
	// As in a shell: ctrl-u clears back to the start and ctrl-w deletes back over the last word.
	if (key.ctrl && input === 'u') return { value: after, cursor: 0 };
	if (key.ctrl && input === 'w') {
		const kept = before.replace(/\S*\s*$/, '');
		return { value: kept + after, cursor: kept.length };
	}
	if (input && !key.ctrl && !key.meta && !key.tab && !key.return && !key.escape) return { value: before + input + after, cursor: cursor + input.length };
}

/**
 * A form's focused text field: being edited with the cursor at a position, after the first `d` of
 * `dd`, or not being edited (keys move around the form rather than typing).
 */
export type Edit = number | 'd' | null;

/**
 * Apply a keypress to a form's focused text field, vim-style: `i`/⏎ edit at the end, `I` at the
 * start, `dd` clears it and edits, and esc stops editing. Undefined if the key is for the form
 * (⏎ while editing, esc while not, moving fields, submitting), which should then set `edit` back to null.
 */
export function fieldKey(value: string, edit: Edit, input: string, key: Key): { value: string; edit: Edit } | undefined {
	if (typeof edit === 'number') {
		if (key.escape) return { value, edit: null };
		const next = editAt(value, Math.min(edit, value.length), input, key);
		return next && { value: next.value, edit: next.cursor };
	}
	if (key.ctrl || key.meta || isSubmit(input, key, edit)) return;
	if (input === 'i' || key.return) return { value, edit: value.length };
	if (input === 'I') return { value, edit: 0 };
	// Typed quickly, dd can arrive as one input.
	if (input === 'dd' || (input === 'd' && edit === 'd')) return { value: '', edit: 0 };
	if (input === 'd') return { value, edit: 'd' };
}

// The keys every form shares, around fieldKey: it goes first, so these only see what it passes on.

/** Submit the form: shift-⏎ (where the terminal sends it apart from ⏎), or `a` while not editing. */
export function isSubmit(input: string, key: Key, edit: Edit): boolean {
	return (key.return && key.shift) || (typeof edit !== 'number' && input === 'a' && !key.ctrl && !key.meta);
}

/** Close the form: esc (once fieldKey has stopped any editing), or `q` while not editing. */
export function isBack(input: string, key: Key, edit: Edit): boolean {
	return key.escape || (typeof edit !== 'number' && input === 'q' && !key.ctrl && !key.meta);
}

/** Move between fields: -1 for k/↑/shift-tab, 1 for j/↓/tab, else 0. */
export function fieldStep(input: string, key: Key): number {
	return key.upArrow || (key.tab && key.shift) || input === 'k' ? -1 : key.downArrow || key.tab || input === 'j' ? 1 : 0;
}

/** Change a choice field: -1 for h/←, 1 for l/→/space, else 0. */
export function choiceStep(input: string, key: Key): number {
	return key.leftArrow || input === 'h' ? -1 : key.rightArrow || input === 'l' || input === ' ' ? 1 : 0;
}

/**
 * ⏎ on field `index` of `count` once fieldKey has passed it on (while editing it, or on a choice):
 * the next field, edited at its end if it's text (`textLength` of it, undefined for a choice). The
 * last field stays, with editing stopped, since only the submit key submits.
 */
export function nextField(index: number, count: number, textLength: (index: number) => number | undefined): { field: number; edit: Edit } {
	if (index + 1 >= count) return { field: index, edit: null };
	return { field: index + 1, edit: textLength(index + 1) ?? null };
}

/** Step `index` by `delta` through a list of `length` items, looping at both ends. */
export function loop(index: number, delta: number, length: number): number {
	return length === 0 ? 0 : (((index + delta) % length) + length) % length;
}
