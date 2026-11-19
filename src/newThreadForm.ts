// The `n` form on the board: the new thread's project, ticket, title, the prompt its claude starts on and its priority.
import type { Key } from 'ink';
import { unknownProject } from './errors.js';
import { choiceStep, fieldKey, fieldStep, isBack, isSubmit, loop, nextField, type Edit } from './input.js';
import { PRIORITIES, type Priority, type Project } from './state.js';
import { normalizeKey } from './tickets.js';

export type NewThreadField = 'project' | 'ticket' | 'title' | 'prompt' | 'priority';
export const NEW_THREAD_LABELS: Record<NewThreadField, string> = { project: 'project', ticket: 'ticket', title: 'title', prompt: 'initial prompt', priority: 'priority' };

export type NewThreadForm = {
	project: string;
	field: NewThreadField;
	ticketKey: string;
	title: string;
	prompt: string;
	priority: Priority;
	// The focused text field's (see fieldKey); the project and priority are only ever changed with h/l.
	edit: Edit;
};

/** What the form is submitted with, the ticket key normalized. */
export type NewThreadSubmit = { project: string; ticketKey?: string; title: string; prompt: string; priority: Priority };

/** What the keys need besides the form. */
export type NewThreadContext = { projects: Project[] };

export function newThreadForm(project: string): NewThreadForm {
	return { project, field: 'project', ticketKey: '', title: '', prompt: '', priority: 'normal', edit: null };
}

/** The form's fields for the project: no ticket without a tracker. The priority comes last, so ⏎ still goes from the title to the prompt. */
export function newThreadFields(project: Project | undefined): NewThreadField[] {
	return project && project.tracker !== 'none' ? ['project', 'ticket', 'title', 'prompt', 'priority'] : ['project', 'title', 'prompt', 'priority'];
}

/** Apply a keypress: the new form, what it ends with (null if cancelled), or why it can't be submitted yet. */
export function newThreadKey(
	form: NewThreadForm,
	input: string,
	key: Key,
	{ projects }: NewThreadContext,
): NewThreadForm | { done: NewThreadSubmit | null } | { problem: string } {
	if (isText(form.field)) {
		const next = fieldKey(fieldText(form, form.field), form.edit, input, key);
		if (next) return { ...withText(form, form.field, next.value), edit: next.edit };
	}
	const project = projects.find(p => p.name === form.project);
	if (isBack(input, key, form.edit)) return { done: null };
	if (isSubmit(input, key, form.edit)) return submit(form, project);
	const fields = newThreadFields(project);
	const index = fields.indexOf(form.field);
	if (key.return) {
		const { field, edit } = nextField(index, fields.length, i => (isText(fields[i]!) ? fieldText(form, fields[i]).length : undefined));
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
		return { ...moved, project: next.name, ticketKey: '' };
	}
	if (form.field === 'priority') return { ...moved, priority: PRIORITIES[loop(PRIORITIES.indexOf(form.priority), turn, PRIORITIES.length)]! };
	return moved;
}

type TextField = Exclude<NewThreadField, 'project' | 'priority'>;

const isText = (field: NewThreadField): field is TextField => field !== 'project' && field !== 'priority';

const fieldText = (form: NewThreadForm, field: TextField) => (field === 'ticket' ? form.ticketKey : form[field]);

function withText(form: NewThreadForm, field: TextField, value: string): NewThreadForm {
	return field === 'ticket' ? { ...form, ticketKey: value } : { ...form, [field]: value };
}

function submit(form: NewThreadForm, project: Project | undefined): { done: NewThreadSubmit } | { problem: string } {
	if (!project) return { problem: unknownProject(form.project) };
	const typed = project.tracker === 'none' ? '' : form.ticketKey.trim();
	const ticketKey = typed ? normalizeKey(project, typed) : undefined;
	if (typed && !ticketKey) return { problem: `Not a ${project.tracker === 'github' ? 'GitHub issue number' : 'Jira key'}: ${typed}` };
	const title = form.title.trim();
	if (!title && !ticketKey) return { problem: 'Give the thread a title or a ticket' };
	return { done: { project: project.name, ticketKey, title, prompt: form.prompt.trim(), priority: form.priority } };
}
