import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Copy a claude transcript to where claude looks for sessions started in `cwd`, so
 * `claude --resume` finds it after the thread moves directory. Returns the new path.
 */
export function copySession(transcriptPath: string, cwd: string): string | undefined {
	if (!existsSync(transcriptPath)) return;
	// claude keys its project folders by the directory with every non-alphanumeric replaced by `-`.
	const dir = join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
	const target = join(dir, basename(transcriptPath));
	mkdirSync(dir, { recursive: true });
	copyFileSync(transcriptPath, target);
	return target;
}
