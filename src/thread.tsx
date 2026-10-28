import { useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { editPlan } from './editor.js';
import { hasWorktree, renameBranch, worktreePath } from './git.js';
import { FieldText, EDITING_HELP, FIELD_HELP, formHelp } from './fieldText.js';
import { choiceStep, fieldKey, fieldStep, isBack, isSubmit, loop, nextField, type Edit } from './input.js';
import { COLORS, COLUMN_LABELS, LOCAL_LABEL, PRIORITIES, PRIORITY_COLORS, type Priority, type State, type Thread } from './state.js';
import { priorityOf, withPriority } from './threads.js';
import { normalizeKey, ticketUrl } from './tickets.js';

const FIELDS = ['title', 'ticket', 'project', 'color', 'priority', 'base', 'plan'] as const;
type Field = (typeof FIELDS)[number];
const FIELD_LABELS: Record<Field, string> = { title: 'title', ticket: 'ticket', project: 'project', color: 'colour', priority: 'priority', base: 'base', plan: 'plan' };
// undefined means the project's colour.
const COLOR_CHOICES = [undefined, ...COLORS];

// The ticket is edited as its key, and normal priority is spelled out.
type Draft = Pick<Thread, 'title' | 'project' | 'color' | 'plan'> & { base: string; ticket: string; priority: Priority };

type Props = {
	state: State;
	threadId: string;
	updateThread: (id: string, patch: Partial<Thread>) => void;
	onClose: (message: string) => void;
};

const LABEL_WIDTH = 13;

/** Full-screen form for one thread: edits what's safe to change by hand and shows the rest. */
export function ThreadView({ state, threadId, updateThread, onClose }: Props) {
	const thread = state.threads.find(t => t.id === threadId);
	const [draft, setDraft] = useState<Draft | null>(
		thread
			? { title: thread.title, ticket: thread.ticket?.key ?? '', project: thread.project, color: thread.color, priority: priorityOf(thread), plan: thread.plan, base: thread.base ?? '' }
			: null,
	);
	const [field, setField] = useState(0);
	// The focused text field is being edited (see fieldKey).
	const [edit, setEdit] = useState<Edit>(null);
	const [message, setMessage] = useState('');
	// The plan's editor popup is open.
	const [editing, setEditing] = useState(false);
	// Looking up the ticket or renaming the branch.
	const [saving, setSaving] = useState(false);
	const { rows } = useWindowSize();

	const save = (thread: Thread, draft: Draft) => {
		const title = draft.title.trim();
		if (!title) return setMessage('✗ Title is empty');
		// The branch and worktree belong to the old project's repo.
		if (draft.project !== thread.project && (thread.branch || thread.cwd)) {
			return setMessage(`✗ #${thread.id} already has work in ${thread.project}; it can't move project`);
		}
		const project = state.projects.find(p => p.name === draft.project);
		const key = draft.ticket.trim() && project ? normalizeKey(project, draft.ticket) : undefined;
		if (draft.ticket.trim() && !key) {
			if (project?.tracker === 'none') return setMessage(`✗ ${draft.project} has no ticket tracker; set one on the projects screen (P)`);
			return setMessage(`✗ Not a ${project?.tracker === 'github' ? 'GitHub issue number' : 'Jira key'}: ${draft.ticket.trim()}`);
		}
		const fields = { ...draft, title, base: draft.base.trim() || undefined, ...withPriority(draft.priority) };
		if (key === thread.ticket?.key) {
			updateThread(thread.id, { ...fields, ticket: thread.ticket });
			return onClose(`Saved #${thread.id}`);
		}
		setSaving(true);
		(async () => {
			const ticket = key && project ? { key, url: await ticketUrl(project, key).catch(() => '') } : undefined;
			// The branch is named after the ticket (see branchName), so follow it while that's still safe.
			const renamed = project && thread.branch ? await renameBranch(project.path, { ...thread, title, ticket }) : {};
			updateThread(thread.id, { ...fields, ticket, ...(renamed.branch ? { branch: renamed.branch } : {}) });
			// "Renamed…" or "⚠ Kept…" says it was saved too.
			onClose(renamed.message ?? `Saved #${thread.id}`);
		})().catch((err: unknown) => {
			setSaving(false);
			setMessage(`✗ ${err instanceof Error ? err.message : String(err)}`);
		});
	};

	useInput((input, key) => {
		if (editing || saving || !thread || !draft) return;
		setMessage('');
		const name = FIELDS[field]!;
		if (name === 'title' || name === 'ticket' || name === 'base') {
			const next = fieldKey(draft[name], edit, input, key);
			if (next) {
				setEdit(next.edit);
				return setDraft({ ...draft, [name]: next.value });
			}
		}
		setEdit(null);
		if (isBack(input, key, edit)) return onClose('Cancelled');
		if (isSubmit(input, key, edit)) return save(thread, draft);
		const move = fieldStep(input, key);
		if (move) return setField(loop(field, move, FIELDS.length));
		const delta = choiceStep(input, key);
		if (name === 'plan') {
			if (!key.return && delta !== 1) return;
			setEditing(true);
			editPlan(draft.plan, `#${thread.id} ${draft.title}`)
				.then(plan => setDraft(d => d && { ...d, plan }))
				.catch(err => setMessage(`✗ ${err instanceof Error ? err.message : String(err)}`))
				.finally(() => setEditing(false));
			return;
		}
		if (key.return) {
			const next = nextField(field, FIELDS.length, i => {
				const f = FIELDS[i]!;
				return f === 'title' || f === 'ticket' || f === 'base' ? draft[f].length : undefined;
			});
			setField(next.field);
			return setEdit(next.edit);
		}
		if (!delta || (name !== 'project' && name !== 'color' && name !== 'priority')) return;
		const step = <T,>(choices: readonly T[], current: T) => choices[loop(choices.indexOf(current), delta, choices.length)]!;
		if (name === 'color') return setDraft({ ...draft, color: step(COLOR_CHOICES, draft.color) });
		if (name === 'priority') return setDraft({ ...draft, priority: step(PRIORITIES, draft.priority) });
		return setDraft({ ...draft, project: step(state.projects.map(p => p.name), draft.project) });
	});

	if (!thread || !draft) {
		return (
			<Box flexDirection="column" flexGrow={1}>
				<Text color="red">✗ Thread #{threadId} is gone — esc to go back</Text>
			</Box>
		);
	}

	const planLines = draft.plan ? draft.plan.split('\n') : [];
	const project = state.projects.find(p => p.name === draft.project);
	const pad = (s: string) => s.padEnd(LABEL_WIDTH);
	const value = (name: Field, active: boolean) => {
		const choice = (text: string, color?: string) => <Text color={color}>{active ? `‹ ${text} ›` : text}</Text>;
		if (name === 'project') return choice(draft.project, project?.color);
		if (name === 'priority') return choice(draft.priority, PRIORITY_COLORS[draft.priority]);
		if (name === 'color') return draft.color ? choice(draft.color, draft.color) : choice(`project's (${project?.color ?? '?'})`, project?.color);
		if (name === 'plan') {
			if (!draft.plan) return <Text dimColor>{active ? '⏎/l to write one' : 'none'}</Text>;
			return <Text dimColor={!active}>{active ? '⏎/l to edit' : `${planLines.length} lines`}</Text>;
		}
		return <FieldText value={draft[name]} edit={active ? edit : null} />;
	};

	const worktree = thread.cwd ? undefined : `${worktreePath(thread)}${hasWorktree(thread) ? '' : ' (not created)'}`;
	const info: [string, string | undefined][] = [
		['column', `${COLUMN_LABELS[thread.column]}${thread.local ? ` (in ${LOCAL_LABEL})` : ''}`],
		['branch', thread.branch],
		['worktree', worktree],
		['directory', thread.cwd],
		['session', thread.sessionId],
		['transcript', thread.transcriptPath],
		['PR', thread.pr && `#${thread.pr.number} ${thread.pr.url}`],
		['created', new Date(thread.createdAt).toLocaleString()],
		['updated', new Date(thread.updatedAt).toLocaleString()],
	].filter(([, v]) => v) as [string, string][];
	// What fits between the fields and the info below: the rest of the window, less the board's title bar,
	// the #id header, the fields, the info and its margin, and the message and help lines.
	const planRoom = Math.max(1, rows - (1 + 1 + FIELDS.length + 1 + info.length + 2));
	// A plan too long for that ends with how much is left, for $EDITOR.
	const shownPlan = planLines.length > planRoom ? planLines.slice(0, planRoom - 1) : planLines;
	const hiddenPlan = planLines.length - shownPlan.length;

	return (
		<Box flexDirection="column" flexGrow={1} overflow="hidden">
			<Text bold>
				#{thread.id} <Text color={project?.color}>{project?.abbrev || thread.project}</Text>
			</Text>
			{FIELDS.map((name, i) => {
				const active = i === field;
				return (
					<Text key={name} wrap="truncate">
						<Text dimColor={!active}>
							{active ? '› ' : '  '}
							{pad(`${FIELD_LABELS[name]}:`)}
						</Text>
						{value(name, active)}
					</Text>
				);
			})}
			{shownPlan.map((line, i) => (
				<Text key={i} wrap="truncate" dimColor>
					{'  '}
					{' '.repeat(LABEL_WIDTH)}
					{line}
				</Text>
			))}
			{hiddenPlan ? (
				<Text wrap="truncate" dimColor>
					{'  '}
					{' '.repeat(LABEL_WIDTH)}… {hiddenPlan} more lines — ⏎ on plan opens $EDITOR
				</Text>
			) : null}
			<Box flexDirection="column" marginTop={1}>
				{info.map(([label, v]) => (
					<Text key={label} wrap="truncate" dimColor>
						{'  '}
						{pad(`${label}:`)}
						{v}
					</Text>
				))}
			</Box>
			<Box flexGrow={1} />
			<Text color={message.startsWith('✗') ? 'red' : 'green'}>{editing ? '… editing plan' : saving ? '… saving' : message}</Text>
			<Text dimColor>
				{typeof edit === 'number'
					? EDITING_HELP
					: `${FIELDS[field] === 'project' || FIELDS[field] === 'color' || FIELDS[field] === 'priority' ? 'h/l change' : FIELDS[field] === 'plan' ? '⏎/l opens $EDITOR' : FIELD_HELP}  ${formHelp('save')}`}
			</Text>
		</Box>
	);
}
