import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lastAssistantText } from './transcripts.js';

const entry = (e: object) => JSON.stringify(e);

test("reads claude's last message, all of its text blocks, skipping subagents", () => {
	const file = join(mkdtempSync(join(tmpdir(), 'oo-test-')), 't.jsonl');
	writeFileSync(
		file,
		[
			entry({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'earlier' }] } }),
			entry({ type: 'user', message: { content: 'next' } }),
			entry({ type: 'assistant', message: { id: 'm2', content: [{ type: 'thinking', thinking: 'hmm' }] } }),
			entry({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Done: \x1b[31mred\x1b[0m' }] } }),
			entry({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', name: 'Bash' }] } }),
			entry({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'and more' }] } }),
			entry({ type: 'assistant', isSidechain: true, message: { id: 'm3', content: [{ type: 'text', text: 'subagent' }] } }),
			'not json',
			entry({ type: 'last-prompt' }),
			'',
		].join('\n'),
	);
	assert.equal(lastAssistantText(file), 'Done: red\n\nand more');
	assert.equal(lastAssistantText(join(tmpdir(), 'oo-missing.jsonl')), undefined);
});
