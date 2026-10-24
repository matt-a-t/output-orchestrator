// The board's keys for acting on threads, each listed next to what it does. keys.ts (the ? screen)
// and KEYS.md describe them for people; keep them in step.

import type { Key } from 'ink';
import type { Thread } from '../state.js';
import type { Board } from './board.js';
import { claudeKeys } from './claude.js';
import { localKeys } from './local.js';
import { moveKeys } from './moves.js';
import { prKeys } from './pr.js';
import { reviewKeys } from './review.js';

/**
 * `key` is the character typed, or ⏎ for Enter. A `meta` binding needs Alt held; the rest match
 * with or without it, after the `meta` ones have had their chance.
 */
export type Binding = { key: string; meta?: boolean; run: (board: Board, thread: Thread | undefined) => unknown };

const BINDINGS: Binding[] = [...claudeKeys, ...localKeys, ...moveKeys, ...prKeys, ...reviewKeys];

/** Run the binding for this keypress on the highlighted `thread`; returns whether there was one. */
export function runBinding(board: Board, input: string, key: Key, thread: Thread | undefined): boolean {
	const matches = (b: Binding) => (b.key === '⏎' ? key.return : input === b.key);
	const binding = BINDINGS.find(b => b.meta && key.meta && matches(b)) ?? BINDINGS.find(b => !b.meta && matches(b));
	binding?.run(board, thread);
	return !!binding;
}
