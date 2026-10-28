// Which threads' claudes have sat quiet long enough for the board to close their windows (see board/idle.ts).

import type { Project, Thread } from './state.js';
import type { Status } from './status.js';
import { undelivered } from './threads.js';
import { threadWindowName, type WindowInfo } from './tmux.js';

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
