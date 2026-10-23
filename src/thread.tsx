import { useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { editPlan } from './editor.js';
import { hasWorktree, worktreePath } from './git.js';
import { editText } from './input.js';
import { COLORS, COLUMN_LABELS, LOCAL_LABEL, type State, type Thread } from './state.js';

const FIELDS = ['title', 'project', 'color', 'base', 'plan'] as const;
type Field = (typeof FIELDS)[number];
const FIELD_LABELS: Record<Field, string> = { title: 'title', project: 'project', color: 'colour', base: 'base', plan: 'plan' };
// undefined means the project's colour.
const COLOR_CHOICES = [undefined, ...COLORS];

type Draft = Pick<Thread, 'title' | 'project' | 'color' | 'plan'> & { base: string };

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
		thread ? { title: thread.title, project: thread.project, color: thread.color, plan: thread.plan, base: thread.base ?? '' } : null,
	);
	const [field, setField] = useState(0);
	const [message, setMessage] = useState('');
	// The plan's editor popup is open.
	const [editing, setEditing] = useState(false);
	const { rows } = useWindowSize();

	const save = (thread: Thread, draft: Draft) => {
		const title = draft.title.trim();
		if (!title) return setMessage('✗ Title is empty');
		// The branch and worktree belong to the old project's repo.
		if (draft.project !== thread.project && (thread.branch || thread.cwd)) {
			return setMessage(`✗ #${thread.id} already has work in ${thread.project}; it can't move project`);
		}
		updateThread(thread.id, { ...draft, title, base: draft.base.trim() || undefined });
		onClose(`Saved #${thread.id}`);
	};

	useInput((input, key) => {
		if (editing || !thread || !draft) return;
		setMessage('');
		const name = FIELDS[field]!;
		if (key.escape) return onClose('Cancelled');
		if (key.return) return save(thread, draft);
		if (key.upArrow || (key.tab && key.shift)) return setField((field + FIELDS.length - 1) % FIELDS.length);
		if (key.downArrow || key.tab) return setField((field + 1) % FIELDS.length);
		if (name === 'project' || name === 'color') {
			const delta = key.leftArrow ? -1 : key.rightArrow || input === ' ' ? 1 : 0;
			if (!delta) return;
			const step = <T,>(choices: readonly T[], current: T) =>
				choices[(choices.indexOf(current) + delta + choices.length) % choices.length]!;
			if (name === 'color') return setDraft({ ...draft, color: step(COLOR_CHOICES, draft.color) });
			return setDraft({ ...draft, project: step(state.projects.map(p => p.name), draft.project) });
		}
		if (name === 'plan') {
			if (input !== ' ' && !key.rightArrow) return;
			setEditing(true);
			editPlan(draft.plan, `#${thread.id} ${draft.title}`)
				.then(plan => setDraft(d => d && { ...d, plan }))
				.catch(err => setMessage(`✗ ${err instanceof Error ? err.message : String(err)}`))
				.finally(() => setEditing(false));
			return;
		}
		const value = editText(draft[name], input, key);
		if (value !== undefined) setDraft({ ...draft, [name]: value });
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
		if (name === 'color') return draft.color ? choice(draft.color, draft.color) : choice(`project's (${project?.color ?? '?'})`, project?.color);
		if (name === 'plan') {
			if (!draft.plan) return <Text dimColor>{active ? 'space to write one' : 'none'}</Text>;
			return <Text dimColor={!active}>{active ? 'space to edit' : `${planLines.length} lines`}</Text>;
		}
		return (
			<Text>
				{draft[name]}
				{active ? <Text inverse> </Text> : null}
			</Text>
		);
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
					{' '.repeat(LABEL_WIDTH)}… {hiddenPlan} more lines — space on plan opens $EDITOR
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
			<Text color={message.startsWith('✗') ? 'red' : 'green'}>{editing ? '… editing plan' : message}</Text>
			<Text dimColor>↑/↓ or tab field  ←/→ or space change  space on plan opens $EDITOR  ⏎ save  esc cancel</Text>
		</Box>
	);
}
