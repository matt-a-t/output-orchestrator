#!/usr/bin/env node
// Claude hook, run as a thread's claude starts (new, resumed, cleared or compacted): tell it where the
// thread's checkpoints stand, so a new claude picks up where the last one stopped. Must never fail or block claude.
import { readFileSync } from 'node:fs';
import { defaultContext, sessionStarted } from './threadCommand.js';

try {
	const briefing = sessionStarted(JSON.parse(readFileSync(0, 'utf8')), defaultContext());
	if (briefing) {
		console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `oo board: ${briefing}` } }));
	}
} catch {}
