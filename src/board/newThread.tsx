// The `n` form, over the bottom of the board, and making the thread it describes.

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { EDITING_HELP, FIELD_HELP, FieldText, formHelp } from '../fieldText.js';
import { runNewThreadHook } from '../hooks.js';
import { NEW_THREAD_LABELS, newThreadFields, newThreadForm, newThreadKey, type NewThreadField, type NewThreadSubmit } from '../newThreadForm.js';
import { PRIORITY_COLORS, type Project, type Thread } from '../state.js';
import { addThread, createWorktree, withPriority } from '../threads.js';
import { fetchTicket, recentTickets, ticketUrl, type Ticket } from '../tickets.js';
import type { Board } from './board.js';
import { launchClaude } from './claude.js';

const LABEL_WIDTH = Math.max(...Object.values(NEW_THREAD_LABELS).map(l => l.length)) + 2;

// A project's recent tickets; a string is why they couldn't be listed, null that they're loading.
type Recent = { project: string; tickets: Ticket[] | string | null } | null;

/** The form's recent tickets, kept on the board so opening the form again doesn't wait for them. */
export function useRecentTickets() {
	const [recent, setRecent] = useState<Recent>(null);
	/** List the project's recent tickets for the form, if it has a tracker. */
	const loadRecent = (project: Project) => {
		if (project.tracker === 'none') return setRecent(null);
		if (recent?.project === project.name && Array.isArray(recent.tickets)) return;
		setRecent({ project: project.name, tickets: null });
		recentTickets(project).then(
			tickets => setRecent(r => (r?.project === project.name ? { ...r, tickets } : r)),
			(err: unknown) => setRecent(r => (r?.project === project.name ? { ...r, tickets: err instanceof Error ? err.message : String(err) } : r)),
		);
	};
	return { recent, loadRecent };
}

type Props = {
	board: Board;
	// The project it opens on, whose recent tickets the opener has asked for.
	project: Project;
	recent: ReturnType<typeof useRecentTickets>;
	// Whether it takes keys (not while the board is busy).
	active: boolean;
	onClose: () => void;
};

/** The `n` form: a field per line, with the recent tickets under the ticket field while it's active. */
export function NewThread({ board, project: opening, recent: { recent, loadRecent }, active, onClose }: Props) {
	const [form, setForm] = useState(() => newThreadForm(opening.name));
	const recentFor = (project: string) => (recent?.project === project && Array.isArray(recent.tickets) ? recent.tickets : []);

	useInput(
		(input, key) => {
			board.setMessage('');
			const next = newThreadKey(form, input, key, { projects: board.state().projects, tickets: recentFor(form.project) });
			if ('problem' in next) return board.setMessage(`✗ ${next.problem}`);
			if ('done' in next) {
				onClose();
				return next.done ? submitNewThread(board, next.done) : board.setMessage('Cancelled');
			}
			if (next.project !== form.project) loadRecent(board.project(next.project)!);
			setForm(next);
		},
		{ isActive: active },
	);

	const project = board.project(form.project);
	const tickets = recent?.project === form.project ? recent.tickets : null;
	const value = (field: NewThreadField, active: boolean) => {
		if (field === 'project') return <Text color={project?.color}>{active ? `‹ ${form.project} ›` : form.project}</Text>;
		if (field === 'priority') return <Text color={PRIORITY_COLORS[form.priority]}>{active ? `‹ ${form.priority} ›` : form.priority}</Text>;
		const edit = active ? form.edit : null;
		if (field === 'ticket') {
			return (
				<Text color="blue">
					<FieldText value={form.ticketKey} edit={edit} />
					{!form.ticketKey && typeof edit !== 'number' ? <Text dimColor>{active ? 'i to type a key, h/l for recent' : 'none'}</Text> : null}
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
			: `${form.field === 'project' || form.field === 'priority' ? 'h/l change' : form.field === 'ticket' ? `${FIELD_HELP}  h/l recent` : FIELD_HELP}  ${formHelp('create')}`;
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
						{field === 'ticket' && active ? (
							<Box flexDirection="column" marginLeft={LABEL_WIDTH + 2}>
								{tickets === null ? <Text dimColor>loading recent tickets…</Text> : null}
								{typeof tickets === 'string' ? <Text dimColor>{tickets}</Text> : null}
								{Array.isArray(tickets) && tickets.length === 0 ? <Text dimColor>none open and assigned to you</Text> : null}
								{Array.isArray(tickets)
									? tickets.map((t, i) => (
											<Text key={t.key} wrap="truncate" inverse={i === form.ticket}>
												<Text color="blue">{t.key}</Text> {t.summary}
											</Text>
										))
									: null}
							</Box>
						) : null}
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
const submitNewThread = (board: Board, { project: name, ticketKey, ticket: known, title, prompt, priority }: NewThreadSubmit) =>
	board.run(async () => {
		const project = board.project(name)!;
		const thread = await threadFromForm(board, project, { title, ...withPriority(priority) }, ticketKey, known);
		if (!thread) return;
		const change = prompt && !thread.cwd ? await createWorktree(project, thread) : undefined;
		if (change?.patch) board.updateThread(thread.id, change.patch);
		const created = { ...thread, ...change?.patch };
		const ran = await runNewThreadHook(project, created, prompt);
		if (prompt) await launchClaude(board, created, created.cwd ?? change!.path, { background: true, prompt });
		const done = `Created #${thread.id}${thread.ticket ? ` for ${thread.ticket.key}` : ''}`;
		if (ran || prompt) board.setMessage([done, ran, prompt && 'started claude on your prompt'].filter(Boolean).join(' · '));
	}, ticketKey ? `reading ${ticketKey}` : 'creating thread');

async function threadFromForm(board: Board, project: Project, fields: NewFields, ticketKey?: string, known?: Ticket): Promise<Thread | undefined> {
	const { title } = fields;
	if (!ticketKey) return createThread(board, project.name, fields);
	const ticket = await fetchTicket(project, ticketKey).catch((err: unknown) => {
		board.setMessage(`⚠ Couldn't read ${ticketKey}: ${err instanceof Error ? err.message : String(err)}`);
		return known;
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
	const { thread } = addThread(board.state(), { project, ...fields });
	board.setState(s => ({ ...s, threads: [...s.threads, thread] }));
	board.showAtEnd('planned');
	const { ticket } = thread;
	const outsider = ticket?.outsider ? ` · ⚠ ${ticket.key} is by ${ticket.author ?? 'someone'}, not a collaborator` : '';
	board.setMessage(`Created #${thread.id}${ticket ? ` for ${ticket.key}` : ''} — e to add a plan${outsider}`);
	return thread;
}
