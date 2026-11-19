// Slow actions on one thread (Local in/out, waking) run in the background, so the board stays usable meanwhile.

import { useRef, useState } from 'react';
import { errorMessage } from '../errors.js';
import type { Thread } from '../state.js';
import type { Board } from './board.js';

/** What a thread is doing in the background, shown on its card (e.g. `leaving Local`). */
export type Job = { label: string; kind: 'local' | 'wake' };

export type Jobs = {
	jobs: () => ReadonlyMap<string, Job>;
	/**
	 * Run fn as the thread's job, refused with a message if it already has one. An error goes on the
	 * message line; either way the job ends when fn does. Key handlers `void` it; a request awaits it.
	 */
	startJob: (thread: Thread, job: Job, fn: () => Promise<void>) => Promise<void>;
};

/** Jobs kept in a map, calling `changed` with a copy whenever one starts or ends. */
export function jobTracker(setMessage: (message: string) => void, changed: (jobs: ReadonlyMap<string, Job>) => void = () => {}): Jobs {
	const jobs = new Map<string, Job>();
	return {
		jobs: () => jobs,
		startJob: async (thread, job, fn) => {
			const running = jobs.get(thread.id);
			if (running) return setMessage(busyMessage(thread, running));
			jobs.set(thread.id, job);
			changed(new Map(jobs));
			try {
				await fn();
			} catch (err) {
				setMessage(`✗ #${thread.id}: ${errorMessage(err)}`);
			} finally {
				jobs.delete(thread.id);
				changed(new Map(jobs));
			}
		},
	};
}

/** The board's jobs, with `shown` a copy that re-renders the board when one starts or ends. */
export function useJobs(setMessage: (message: string) => void): Jobs & { shown: ReadonlyMap<string, Job> } {
	const [shown, setShown] = useState<ReadonlyMap<string, Job>>(new Map());
	const tracker = useRef<Jobs>(null);
	tracker.current ??= jobTracker(setMessage, setShown);
	return { ...tracker.current, shown };
}

const busyMessage = (thread: Thread, job: Job) => `⚠ #${thread.id} is busy (${job.label})`;

/** Why nothing else can be done to the thread right now: it has a job running. */
export function jobProblem(board: Board, thread: Thread): string | undefined {
	const job = board.jobs().get(thread.id);
	return job && busyMessage(thread, job);
}

/** The jobs running, for the quit question: ` ⚠ #12 is still leaving Local, #7 is still waking`. */
export function jobsWarning(jobs: ReadonlyMap<string, Job>): string {
	if (jobs.size === 0) return '';
	return ` ⚠ ${[...jobs].map(([id, job]) => `#${id} is still ${job.label}`).join(', ')}`;
}
