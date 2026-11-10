// The board's keys for acting on threads, each listed next to what it does and its line on the ?
// screen (keys.ts builds those rows from BINDINGS). KEYS.md describes them too; keys.test.ts checks it has them.

import type { Key } from 'ink';
import type { Thread } from '../state.js';
import type { Board } from './board.js';
import { claudeKeys } from './claude.js';
import { localKeys } from './local.js';
import { moveKeys } from './moves.js';
import { prKeys } from './pr.js';
import { reviewKeys } from './review.js';

/** A binding's row on the ? screen: `keys` labels a row covering a pair (`'d / D'`), whose other key leaves `help` off. */
export type BindingHelp = { section: 'Board' | 'Reviewing'; keys?: string; what: string };

/**
 * `key` is the character typed, or ⏎ for Enter. A `meta` binding needs Alt held; the rest match
 * with or without it, after the `meta` ones have had their chance.
 */
export type Binding = { key: string; meta?: boolean; run: (board: Board, thread: Thread | undefined) => unknown; help?: BindingHelp };

// In the order the ? screen lists them.
export const BINDINGS: Binding[] = [...claudeKeys, ...moveKeys, ...localKeys, ...reviewKeys, ...prKeys];

/** Run the binding for this keypress on the highlighted `thread`; returns whether there was one. */
export function runBinding(board: Board, input: string, key: Key, thread: Thread | undefined): boolean {
	const matches = (b: Binding) => (b.key === '⏎' ? key.return : input === b.key);
	const binding = BINDINGS.find(b => b.meta && key.meta && matches(b)) ?? BINDINGS.find(b => !b.meta && matches(b));
	binding?.run(board, thread);
	return !!binding;
}
