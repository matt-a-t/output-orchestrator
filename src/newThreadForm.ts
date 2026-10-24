// The `n` form on the board: the new thread's project, ticket, title and the prompt its claude starts on.
import type { Key } from 'ink';
import { editText, loop } from './input.js';
import type { Project } from './state.js';
import { normalizeKey, type Ticket } from './tickets.js';

export type NewThreadField = 'project' | 'ticket' | 'title' | 'prompt';
export const NEW_THREAD_LABELS: Record<NewThreadField, string> = { project: 'project', ticket: 'ticket', title: 'title', prompt: 'initial prompt' };

export type NewThreadForm = {
	project: string;
	field: NewThreadField;
	ticketKey: string;
	// Which of the recent tickets ←/→ picked; -1 for none, or a key typed by hand.
	ticket: number;
	title: string;
	// Typed by hand, so picking a ticket no longer fills it in.
	titleEdited: boolean;
	prompt: string;
};

/** What the form is submitted with: the ticket key normalized, and the recent ticket if one was picked. */
export type NewThreadSubmit = { project: string; ticketKey?: string; ticket?: Ticket; title: string; prompt: string };

/** What the keys need besides the form: the projects, and the project's recent tickets so far. */
export type NewThreadContext = { projects: Project[]; tickets: Ticket[] };

export function newThreadForm(project: string): NewThreadForm {
	return { project, field: 'project', ticketKey: '', ticket: -1, title: '', titleEdited: false, prompt: '' };
}

/** The form's fields for the project: no ticket without a tracker. */
export function newThreadFields(project: Project | undefined): NewThreadField[] {
	return project && project.tracker !== 'none' ? ['project', 'ticket', 'title', 'prompt'] : ['project', 'title', 'prompt'];
}

/** Apply a keypress: the new form, what it ends with (null if cancelled), or why it can't be submitted yet. */
export function newThreadKey(
	form: NewThreadForm,
	input: string,
	key: Key,
	{ projects, tickets }: NewThreadContext,
): NewThreadForm | { done: NewThreadSubmit | null } | { problem: string } {
	if (key.escape) return { done: null };
	const project = projects.find(p => p.name === form.project);
	if (key.return) return submit(form, project, tickets);
	const fields = newThreadFields(project);
	const step = key.upArrow || (key.tab && key.shift) ? -1 : key.downArrow || key.tab ? 1 : 0;
	if (step) return { ...form, field: fields[loop(fields.indexOf(form.field), step, fields.length)]! };
	const turn = key.leftArrow ? -1 : key.rightArrow ? 1 : 0;
	if (form.field === 'project') {
		if (!turn || projects.length === 0) return form;
		const next = projects[loop(projects.findIndex(p => p.name === form.project), turn, projects.length)]!;
		// Another project's tickets aren't this one's.
		return { ...form, project: next.name, ...pickTicket(form, -1, tickets) };
	}
	if (form.field === 'ticket') {
		// "None" then each recent ticket.
		if (turn) return { ...form, ...pickTicket(form, loop(form.ticket + 1, turn, tickets.length + 1) - 1, tickets) };
		const ticketKey = editText(form.ticketKey, input, key);
		return ticketKey === undefined ? form : { ...form, ticketKey, ticket: -1 };
	}
	const value = editText(form[form.field], input, key);
	if (value === undefined) return form;
	// Cleared, it goes back to following the ticket.
	return form.field === 'title' ? { ...form, title: value, titleEdited: value !== '' } : { ...form, prompt: value };
}

/** Pick recent ticket `index` (-1 for none), titling the thread after it unless the title was typed. */
function pickTicket(form: NewThreadForm, index: number, tickets: Ticket[]): Partial<NewThreadForm> {
	const ticket = tickets[index];
	return { ticket: ticket ? index : -1, ticketKey: ticket?.key ?? '', ...(form.titleEdited ? {} : { title: ticket?.summary ?? '' }) };
}

function submit(form: NewThreadForm, project: Project | undefined, tickets: Ticket[]): { done: NewThreadSubmit } | { problem: string } {
	if (!project) return { problem: `Unknown project "${form.project}"` };
	const typed = project.tracker === 'none' ? '' : form.ticketKey.trim();
	const ticketKey = typed ? normalizeKey(project, typed) : undefined;
	if (typed && !ticketKey) return { problem: `Not a ${project.tracker === 'github' ? 'GitHub issue number' : 'Jira key'}: ${typed}` };
	const title = form.title.trim();
	if (!title && !ticketKey) return { problem: 'Give the thread a title or a ticket' };
	// Picked from the list, it needn't be read again.
	const ticket = ticketKey ? tickets.find(t => t.key === ticketKey) : undefined;
	return { done: { project: project.name, ticketKey, ticket, title, prompt: form.prompt.trim() } };
}
