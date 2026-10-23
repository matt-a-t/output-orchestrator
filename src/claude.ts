import { execa } from 'execa';

// Enough for claude to see the changes without blowing up the prompt on huge diffs.
const MAX_DIFF = 60_000;

export function truncateDiff(diff: string): string {
	return diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n[diff truncated]` : diff;
}

/**
 * One-off `claude -p` in `cwd`, without saving a transcript; returns its reply minus any code fence,
 * or undefined if it failed or `signal` stopped it.
 */
export async function askClaude(cwd: string, prompt: string, signal?: AbortSignal): Promise<string | undefined> {
	const result = await execa('claude', ['-p', '--no-session-persistence', '--tools', 'Read,Grep,Glob'], {
		cwd,
		input: prompt,
		cancelSignal: signal,
		reject: false,
	});
	if (result.exitCode !== 0) return;
	return result.stdout.trim().replace(/^```\w*\n|\n```$/g, '');
}
