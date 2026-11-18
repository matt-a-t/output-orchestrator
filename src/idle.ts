// Which threads' claudes have sat quiet long enough for the board to close their windows (see board/idle.ts).

import type { Project, Thread } from './state.js';
import type { Status } from './status.js';
import { undelivered } from './threads.js';
import { threadWindowName, type WindowInfo } from './tmux.js';
import { cacheLeft, LARGE_CONTEXT, type ContextUse } from './transcripts.js';

/**
 * Whether to compact a quiet thread's conversation before closing its window: it's large and its cache is still
 * warm, so compacting now reads it cheaply, and the next resume sends the summary instead of all of it.
 * Not once it's Done (or archived): nothing will resume it, so compacting would be spent for nothing.
 */
export function worthCompacting(thread: Thread, use: ContextUse | undefined, now: number): boolean {
	if (!use || use.compacted || thread.column === 'done' || thread.column === 'archived') return false;
	return use.tokens >= LARGE_CONTEXT && cacheLeft(use, now) > 0;
}

/**
 * Whether the /compact sent to a thread at `sentAt` has finished: its transcript shows the conversation compacted
 * since. Clocks can disagree a little, hence the slack.
 */
export const compactedSince = (use: ContextUse | undefined, sentAt: number) => !!use?.compacted && use.at >= sentAt - 5_000;

/** Statuses that mean claude is at its prompt with nothing to do: stopped, or opened and never prompted. */
const QUIET: Status[] = ['stopped', 'idle'];

/**
 * Threads whose claude window is open but has been stopped (or idle) for their project's `closeIdleAfter`
 * minutes, and that nothing's waiting on: not on screen, with no split beside claude, no messages still to
 * paste in and no move to or from Local pending. Whether a shell is still running is checked after, for these only.
 */
export function quietThreads(
	threads: Thread[],
	projects: Project[],
	statuses: Record<string, Status>,
	since: Map<string, number>,
	windows: WindowInfo[],
	pendingLocal: Map<string, boolean>,
	now: number,
): Thread[] {
	return threads.filter(t => {
		const window = windows.find(w => w.name === threadWindowName(t.id));
		const minutes = projects.find(p => p.name === t.project)?.closeIdleAfter ?? 0;
		const quietSince = since.get(t.id);
		return (
			!!window &&
			!window.viewed &&
			!window.split &&
			minutes > 0 &&
			QUIET.includes(statuses[t.id]!) &&
			quietSince !== undefined &&
			now - quietSince >= minutes * 60_000 &&
			undelivered(t.inbox).length === 0 &&
			!pendingLocal.has(t.id)
		);
	});
}
