// Threads' containers (see container.ts) across board runs: quitting the board leaves them running, like tmux
// windows, so starting it again clears out the ones nothing needs any more and picks up the others' ports.

import { useEffect, useState } from 'react';
import { containerProject, knownPorts, publishedPorts, removeContainer, strayContainers, threadContainers } from '../container.js';
import type { Board } from './board.js';

/** Once, as the board starts. Re-renders when it's found the ports, for the cards. No docker means nothing to do. */
export function useContainerSweep(board: Board) {
	const [, setFound] = useState(0);
	useEffect(() => {
		const { threads, projects } = board.state();
		// Only worth a docker call if some project uses containers.
		if (!projects.some(p => containerProject(p))) return;
		void (async () => {
			const containers = await threadContainers();
			const stray = strayContainers(containers, threads, projects);
			for (const name of stray) await removeContainer(name);
			for (const name of containers.keys()) if (!stray.includes(name)) knownPorts.set(name, await publishedPorts(name));
			if (stray.length) board.setMessage(`Removed ${stray.length} container${stray.length === 1 ? '' : 's'} no thread needs any more`);
			setFound(n => n + 1);
		})().catch(() => {});
	}, []);
}
