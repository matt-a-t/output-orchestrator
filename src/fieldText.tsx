import { Text } from 'ink';
import type { Edit } from './input.js';

/** A form's text field: just its text, or with the cursor drawn in while it's being edited. */
export function FieldText({ value, edit }: { value: string; edit: Edit }) {
	if (typeof edit !== 'number') return <Text>{value}</Text>;
	const cursor = Math.min(edit, value.length);
	return (
		<Text>
			{value.slice(0, cursor)}
			<Text inverse>{value[cursor] ?? ' '}</Text>
			{value.slice(cursor + 1)}
		</Text>
	);
}

/** A form's help line while a text field is being edited (`edit` is a cursor position). */
export const EDITING_HELP = '←/→ move  ctrl-u/ctrl-w delete  esc done  ⏎ save';
/** The text field keys for a form's help line when it isn't being edited. */
export const FIELD_HELP = 'i/⏎ edit  I edit from start  dd clear';
