// The `n` form on the board: the new thread's project, ticket, title and the prompt its claude starts on.
import type { Key } from 'ink';
import { choiceStep, fieldKey, fieldStep, isBack, isSubmit, loop, nextField, type Edit } from './input.js';
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
	// The focused text field's (see fieldKey); the project is only ever changed with h/l.
	edit: Edit;
};

/** What the form is submitted with: the ticket key normalized, and the recent ticket if one was picked. */
export type NewThreadSubmit = { project: string; ticketKey?: string; ticket?: Ticket; title: string; prompt: string };

/** What the keys need besides the form: the projects, and the project's recent tickets so far. */
export type NewThreadContext = { projects: Project[]; tickets: Ticket[] };

export function newThreadForm(project: string): NewThreadForm {
	return { project, field: 'project', ticketKey: '', ticket: -1, title: '', titleEdited: false, prompt: '', edit: null };
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
	if (form.field !== 'project') {
		const next = fieldKey(fieldText(form, form.field), form.edit, input, key);
		if (next) return { ...withText(form, form.field, next.value), edit: next.edit };
	}
	const project = projects.find(p => p.name === form.project);
	if (isBack(input, key, form.edit)) return { done: null };
	if (isSubmit(input, key, form.edit)) return submit(form, project, tickets);
	const fields = newThreadFields(project);
	const index = fields.indexOf(form.field);
	if (key.return) {
		const { field, edit } = nextField(index, fields.length, i => (fields[i] === 'project' ? undefined : fieldText(form, fields[i]!).length));
		return { ...form, field: fields[field]!, edit };
	}
	const moved = { ...form, edit: null };
	const step = fieldStep(input, key);
	if (step) return { ...moved, field: fields[loop(index, step, fields.length)]! };
	const turn = choiceStep(input, key);
	if (!turn) return moved;
	if (form.field === 'project') {
		if (projects.length === 0) return moved;
		const next = projects[loop(projects.findIndex(p => p.name === form.project), turn, projects.length)]!;
		// Another project's tickets aren't this one's.
		return { ...moved, project: next.name, ...pickTicket(form, -1, tickets) };
	}
	// "None" then each recent ticket.
	if (form.field === 'ticket') return { ...moved, ...pickTicket(form, loop(form.ticket + 1, turn, tickets.length + 1) - 1, tickets) };
	return moved;
}

type TextField = Exclude<NewThreadField, 'project'>;

const fieldText = (form: NewThreadForm, field: TextField) => (field === 'ticket' ? form.ticketKey : form[field]);

/** Set a text field; only a change counts as typing it (forgetting the picked ticket, or no longer titling after it). */
function withText(form: NewThreadForm, field: TextField, value: string): NewThreadForm {
	if (value === fieldText(form, field)) return form;
	if (field === 'ticket') return { ...form, ticketKey: value, ticket: -1 };
	// Cleared, it goes back to following the ticket.
	return field === 'title' ? { ...form, title: value, titleEdited: value !== '' } : { ...form, prompt: value };
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
