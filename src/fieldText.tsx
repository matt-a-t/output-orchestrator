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
export const EDITING_HELP = '←/→ move  ctrl-u/ctrl-w delete  ⏎ next  esc done';
/** The text field keys for a form's help line when it isn't being edited. */
export const FIELD_HELP = 'i/⏎ edit  I edit from start  dd clear';
/** The end of a form's help line when nothing is being edited: moving, submitting (`verb`, e.g. save) and closing. */
export const formHelp = (verb: string) => `j/k field  shift-⏎ ${verb}  q/esc cancel`;
/** The help line on a form's submit row. */
export const submitHelp = (verb: string) => `⏎ ${verb}  j/k field  q/esc cancel`;

/** The row after a form's last field that ⏎ submits from, e.g. [ Save ]; `indent` lines it up under the values. */
export function SubmitRow({ label, active, indent }: { label: string; active: boolean; indent: number }) {
	return (
		<Text>
			{active ? '› ' : '  '}
			{' '.repeat(indent)}
			<Text inverse={active} dimColor={!active} bold={active}>{`[ ${label} ]`}</Text>
		</Text>
	);
}
