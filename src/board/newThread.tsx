// The `n` form, over the bottom of the board, and making the thread it describes.

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { errorMessage } from '../errors.js';
import { EDITING_HELP, FIELD_HELP, FieldText, formHelp } from '../fieldText.js';
import { runNewThreadHook } from '../hooks.js';
import { NEW_THREAD_LABELS, newThreadFields, newThreadForm, newThreadKey, type NewThreadField, type NewThreadSubmit } from '../newThreadForm.js';
import { PRIORITY_COLORS, type Project, type Thread } from '../state.js';
import { addThread, createWorktree, withPriority } from '../threads.js';
import { fetchTicket, ticketUrl } from '../tickets.js';
import type { Board } from './board.js';
import { launchClaude } from './claude.js';

const LABEL_WIDTH = Math.max(...Object.values(NEW_THREAD_LABELS).map(l => l.length)) + 2;

type Props = {
	board: Board;
	// The project it opens on.
	project: Project;
	// Whether it takes keys (not while the board is busy).
	active: boolean;
	onClose: () => void;
};

/** The `n` form: a field per line. */
export function NewThread({ board, project: opening, active, onClose }: Props) {
	const [form, setForm] = useState(() => newThreadForm(opening.name));

	useInput(
		(input, key) => {
			board.setMessage('');
			const next = newThreadKey(form, input, key, { projects: board.state().projects });
			if ('problem' in next) return board.setMessage(`✗ ${next.problem}`);
			if ('done' in next) {
				onClose();
				return next.done ? submitNewThread(board, next.done) : board.setMessage('Cancelled');
			}
			setForm(next);
		},
		{ isActive: active },
	);

	const project = board.project(form.project);
	const value = (field: NewThreadField, active: boolean) => {
		if (field === 'project') return <Text color={project?.color}>{active ? `‹ ${form.project} ›` : form.project}</Text>;
		if (field === 'priority') return <Text color={PRIORITY_COLORS[form.priority]}>{active ? `‹ ${form.priority} ›` : form.priority}</Text>;
		const edit = active ? form.edit : null;
		if (field === 'ticket') {
			return (
				<Text color="blue">
					<FieldText value={form.ticketKey} edit={edit} />
					{!form.ticketKey && typeof edit !== 'number' ? <Text dimColor>{active ? 'i to type a key' : 'none'}</Text> : null}
				</Text>
			);
		}
		return (
			<Text>
				<FieldText value={form[field]} edit={edit} />
				{field === 'prompt' && !form.prompt && typeof edit !== 'number' ? <Text dimColor>none — claude isn't started</Text> : null}
			</Text>
		);
	};
	const help =
		typeof form.edit === 'number'
			? EDITING_HELP
			: `${form.field === 'project' || form.field === 'priority' ? 'h/l change' : FIELD_HELP}  ${formHelp('create')}`;
	return (
		<Box flexDirection="column" borderStyle="round" borderColor={project?.color} paddingX={1}>
			<Text bold>New thread</Text>
			{newThreadFields(project).map(field => {
				const active = field === form.field;
				return (
					<Box key={field} flexDirection="column">
						<Text wrap="wrap">
							<Text dimColor={!active}>
								{active ? '› ' : '  '}
								{`${NEW_THREAD_LABELS[field]}:`.padEnd(LABEL_WIDTH)}
							</Text>
							{value(field, active)}
						</Text>
					</Box>
				);
			})}
			<Text dimColor>{help}</Text>
		</Box>
	);
}

/**
 * Create the thread from the form, titled and planned from its ticket when it has one, then run the
 * project's new thread hook and start its claude in the background on the initial prompt, if there
 * is one. With a prompt, the worktree comes first so the hook runs in it.
 */
const submitNewThread = (board: Board, { project: name, ticketKey, title, prompt, priority }: NewThreadSubmit) =>
	board.run(async () => {
		const project = board.project(name)!;
		const thread = await threadFromForm(board, project, { title, ...withPriority(priority) }, ticketKey);
		if (!thread) return;
		const change = prompt && !thread.cwd ? await createWorktree(project, thread) : undefined;
		if (change?.patch) board.updateThread(thread.id, change.patch);
		const created = { ...thread, ...change?.patch };
		const ran = await runNewThreadHook(project, created, prompt);
		if (prompt) await launchClaude(board, created, created.cwd ?? change!.path, { background: true, prompt });
		const done = `Created #${thread.id}${thread.ticket ? ` for ${thread.ticket.key}` : ''}`;
		if (ran || prompt) board.setMessage([done, ran, prompt && 'started claude on your prompt'].filter(Boolean).join(' · '));
	}, ticketKey ? `reading ${ticketKey}` : 'creating thread');

async function threadFromForm(board: Board, project: Project, fields: NewFields, ticketKey?: string): Promise<Thread | undefined> {
	const { title } = fields;
	if (!ticketKey) return createThread(board, project.name, fields);
	const ticket = await fetchTicket(project, ticketKey).catch((err: unknown) => {
		board.setMessage(`⚠ Couldn't read ${ticketKey}: ${errorMessage(err)}`);
		return undefined;
	});
	// Its description stays on the ticket, not the plan: anyone can file an issue, and claude follows plans.
	if (ticket) return createThread(board, project.name, { ...fields, title: title || ticket.summary, ticket: { ...ticket, key: ticketKey } });
	// Without the ticket there's nothing to title the thread after.
	if (!title) return void board.setMessage(`✗ Couldn't read ${ticketKey}, so it needs a title — press n to try again`);
	const url = await ticketUrl(project, ticketKey).catch(() => '');
	return createThread(board, project.name, { ...fields, ticket: { key: ticketKey, url } });
}

// What the form sets on the new thread besides its project.
type NewFields = Pick<Thread, 'title' | 'priority'> & Partial<Pick<Thread, 'ticket'>>;

function createThread(board: Board, project: string, fields: NewFields) {
	const { thread } = addThread(board.state(), { project, ...fields, origin: 'board' });
	board.setState(s => ({ ...s, threads: [...s.threads, thread] }));
	board.showAtEnd('planned');
	const { ticket } = thread;
	const outsider = ticket?.outsider ? ` · ⚠ ${ticket.key} is by ${ticket.author ?? 'someone'}, not a collaborator` : '';
	board.setMessage(`Created #${thread.id}${ticket ? ` for ${ticket.key}` : ''} — e to add a plan${outsider}`);
	return thread;
}
