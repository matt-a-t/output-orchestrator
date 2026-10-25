// The board's `/` search: what's typed, the box it's typed in, and its keys.
import { useState } from 'react';
import { Text, type Key } from 'ink';
import { FieldText } from './fieldText.js';
import { editAt } from './input.js';

export type Search = ReturnType<typeof useSearch>;

/**
 * The search narrows the board as it's typed; `onChange` hears each new query so the board can
 * keep its cursor in place. ⏎ closes the box keeping the search, esc closes it dropping it.
 */
export function useSearch(onChange: (query: string) => void) {
	const [query, setQuery] = useState('');
	// Where the cursor is in the box, or null while it's closed.
	const [cursor, setCursor] = useState<number | null>(null);
	return {
		query,
		cursor,
		// Whether the box is open, taking every key.
		typing: cursor !== null,
		open: () => setCursor(query.length),
		// Set the query without telling `onChange`, for callers that place the cursor themselves.
		set: setQuery,
		/** Apply a keypress to the open box; false if it isn't open. */
		key(input: string, key: Key): boolean {
			if (cursor === null) return false;
			if (key.return || key.escape) {
				setCursor(null);
				if (key.escape) {
					setQuery('');
					onChange('');
				}
				return true;
			}
			const next = editAt(query, cursor, input, key);
			if (!next) return true;
			setCursor(next.cursor);
			if (next.value === query) return true;
			setQuery(next.value);
			onChange(next.value);
			return true;
		},
	};
}

export function SearchBox({ search }: { search: Search }) {
	if (!search.typing) return null;
	return (
		<Text>
			<Text bold>/</Text> <FieldText value={search.query} edit={search.cursor} />
			<Text dimColor>  ⏎ keep  esc clear</Text>
		</Text>
	);
}
