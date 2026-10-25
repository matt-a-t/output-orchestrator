// The Jira tickets and GitHub issues threads work on, read with `gh` or Jira Cloud's REST API.
import { execa } from 'execa';
import { parseUntrusted } from './sanitize.js';
import { isJiraCloudHost, JIRA_CLOUD_ONLY, type Project, type Thread } from './state.js';

export type TicketRef = NonNullable<Thread['ticket']>;
export type Ticket = TicketRef & { summary: string; description: string };

/** How many tickets the new-thread picker lists. */
const RECENT = 5;

/** The ticket's key in the project's form: `AV-123` for Jira (a bare `123` gets the project's prefix), `#45` for GitHub. */
export function normalizeKey(project: Project, input: string): string | undefined {
	const key = input.trim();
	if (project.tracker === 'github') {
		const m = /^#?(\d+)$/.exec(key);
		return m ? `#${m[1]}` : undefined;
	}
	if (project.tracker === 'jira') {
		if (/^\d+$/.test(key) && project.jiraProject) return `${project.jiraProject.toUpperCase()}-${key}`;
		return /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key) ? key.toUpperCase() : undefined;
	}
}

/** What starts the branch name: `av-123` for Jira, `45` for GitHub. */
export function ticketBranchPart(ticket: TicketRef): string {
	return ticket.key.replace(/^#/, '').toLowerCase();
}

export const isGithubKey = (key: string) => key.startsWith('#');

/** Where the ticket is on the web, without asking the tracker; GitHub's needs the repo, so it asks gh. */
export async function ticketUrl(project: Project, key: string): Promise<string> {
	if (!isGithubKey(key)) return `https://${jiraHost(project)}/browse/${key}`;
	const { stdout } = await execa('gh', ['repo', 'view', '--json', 'url', '-q', '.url'], { cwd: project.path });
	return `${stdout.trim()}/issues/${key.slice(1)}`;
}

/** Up to five open tickets assigned to you, most recently updated first. */
export async function recentTickets(project: Project): Promise<Ticket[]> {
	if (project.tracker === 'github') {
		const { stdout } = await execa(
			'gh',
			['issue', 'list', '--assignee', '@me', '--state', 'open', '--search', 'sort:updated-desc', '--limit', String(RECENT), '--json', 'number,title,url'],
			{ cwd: project.path },
		);
		return parseUntrusted<{ number: number; title: string; url: string }[]>(stdout).map(i => ({
			key: `#${i.number}`,
			url: i.url,
			summary: i.title,
			description: '',
		}));
	}
	if (project.tracker !== 'jira') return [];
	const { issues } = (await jira(project, '/rest/api/3/search/jql', {
		jql: recentJql(project),
		maxResults: RECENT,
		fields: ['summary'],
	})) as { issues: { key: string; fields: { summary: string } }[] };
	return issues.map(i => ({ key: i.key, url: `https://${jiraHost(project)}/browse/${i.key}`, summary: i.fields.summary, description: '' }));
}

export function recentJql(project: Project): string {
	const scope = project.jiraProject ? `project = "${project.jiraProject}" AND ` : '';
	return `${scope}assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`;
}

/** The ticket's summary and description. */
export async function fetchTicket(project: Project, key: string): Promise<Ticket> {
	if (isGithubKey(key)) {
		const { stdout } = await execa('gh', ['issue', 'view', key.slice(1), '--json', 'title,body,url'], { cwd: project.path });
		const issue = parseUntrusted<{ title: string; body: string; url: string }>(stdout);
		return { key, url: issue.url, summary: issue.title, description: issue.body.trim() };
	}
	const issue = (await jira(project, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description`)) as {
		fields: { summary: string; description: Adf | null };
	};
	return {
		key,
		url: `https://${jiraHost(project)}/browse/${key}`,
		summary: issue.fields.summary,
		description: issue.fields.description ? adfText(issue.fields.description).trim() : '',
	};
}

function jiraHost(project: Project): string {
	const host = project.jiraSite.replace(/^https?:\/\//, '').replace(/\/+$/, '');
	if (!host) throw new Error(`Set ${project.name}'s jira site on the projects screen`);
	return host;
}

/** A Jira Cloud REST call (POST when there's a body), with the API token from JIRA_EMAIL and JIRA_API_TOKEN. */
async function jira(project: Project, path: string, body?: unknown): Promise<unknown> {
	const { JIRA_EMAIL: email, JIRA_API_TOKEN: token } = process.env;
	if (!email || !token) throw new Error('Set JIRA_EMAIL and JIRA_API_TOKEN to read Jira tickets');
	// Checked here too, for a site saved before projectProblem refused it.
	const host = jiraHost(project);
	if (!isJiraCloudHost(host)) throw new Error(JIRA_CLOUD_ONLY);
	const response = await fetch(`https://${host}${path}`, {
		method: body ? 'POST' : 'GET',
		headers: {
			Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
			Accept: 'application/json',
			...(body ? { 'Content-Type': 'application/json' } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`Jira said ${response.status} ${response.statusText}`);
	return parseUntrusted(await response.text());
}

/** A node of Atlassian Document Format, which Jira's v3 API uses for rich text. */
export type Adf = { type: string; text?: string; content?: Adf[]; attrs?: Record<string, unknown> };

const BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'blockquote', 'rule', 'mediaSingle', 'panel', 'table', 'tableRow']);

/** ADF as plain text: blocks on their own lines, list items as `- ` bullets. */
export function adfText(node: Adf, indent = ''): string {
	if (node.type === 'text') return node.text ?? '';
	if (node.type === 'hardBreak') return '\n';
	if (node.type === 'mention' || node.type === 'emoji') return String(node.attrs?.text ?? '');
	if (node.type === 'inlineCard') return String(node.attrs?.url ?? '');
	const children = node.content ?? [];
	if (node.type === 'bulletList' || node.type === 'orderedList') {
		const items = children.map((item, i) => {
			const mark = node.type === 'bulletList' ? '- ' : `${i + 1}. `;
			return `${indent}${mark}${adfText(item, `${indent}  `).trim()}`;
		});
		return `${items.join('\n')}\n`;
	}
	// An item's paragraph and any nested list go on consecutive lines.
	if (node.type === 'listItem') return children.map(c => adfText(c, indent)).join('').replace(/\n{2,}/g, '\n').replace(/\n+$/, '');
	const inner = children.map(c => adfText(c, indent)).join('');
	if (node.type === 'heading') return `${'#'.repeat(Number(node.attrs?.level ?? 1))} ${inner}\n\n`;
	if (node.type === 'codeBlock') return `\`\`\`\n${inner}\n\`\`\`\n\n`;
	if (BLOCKS.has(node.type)) return `${inner}\n\n`;
	return inner;
}
