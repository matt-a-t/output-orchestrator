import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { contextUse, describeContext, formatTokens, lastAssistantText, readContextUse, shortDuration, worthFreshStart } from './transcripts.js';

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

const turn = (at: string, usage: object, extra: object = {}) => entry({ type: 'assistant', timestamp: at, message: { usage }, ...extra });

test('reads the context size from the last turn, and the cache lifetime from the last cache write', () => {
	const text = [
		'{"cut off',
		turn('2026-01-01T10:00:00Z', { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: 0 } }),
		turn('2026-01-01T10:05:00Z', { input_tokens: 2, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }),
		turn('2026-01-01T10:06:00Z', { input_tokens: 1, cache_read_input_tokens: 1 }, { isSidechain: true }),
		turn('2026-01-01T10:07:00Z', { input_tokens: 0, output_tokens: 0 }),
		entry({ type: 'user', message: { content: 'next' } }),
	].join('\n');
	assert.deepEqual(readContextUse(text), { tokens: 9002, at: Date.parse('2026-01-01T10:05:00Z'), cacheMs: 60 * 60_000 });
});

test('assumes the 5 minute cache when no cache write says otherwise, and nothing before a first turn', () => {
	const text = turn('2026-01-01T10:00:00Z', { input_tokens: 10, cache_read_input_tokens: 20 });
	assert.deepEqual(readContextUse(text), { tokens: 30, at: Date.parse('2026-01-01T10:00:00Z'), cacheMs: 5 * 60_000 });
	assert.equal(readContextUse(entry({ type: 'user', message: { content: 'hi' } })), undefined);
});

test('contextUse reads the transcript again once it changes', () => {
	const file = join(mkdtempSync(join(tmpdir(), 'oo-test-')), 't.jsonl');
	writeFileSync(file, turn('2026-01-01T10:00:00Z', { input_tokens: 10 }) + '\n');
	assert.equal(contextUse(file)?.tokens, 10);
	writeFileSync(file, turn('2026-01-01T10:00:00Z', { input_tokens: 10 }) + '\n' + turn('2026-01-01T10:01:00Z', { input_tokens: 2000 }) + '\n');
	assert.equal(contextUse(file)?.tokens, 2000);
	assert.equal(contextUse(join(tmpdir(), 'oo-missing.jsonl')), undefined);
});

test('formats context sizes and times short', () => {
	assert.deepEqual([850, 12_400, 379_000, 1_240_000].map(formatTokens), ['850', '12k', '379k', '1.2M']);
	assert.deepEqual([1, 59_000, 42 * 60_000, 3 * 3_600_000, 50 * 3_600_000].map(shortDuration), ['1m', '1m', '42m', '3h', '2d']);
	const use = { tokens: 379_000, at: 0, cacheMs: 60 * 60_000 };
	assert.equal(describeContext(use, 18 * 60_000), '379k tokens, cache warm for 42m');
	assert.equal(describeContext(use, 4 * 3_600_000), '379k tokens, cache went cold 3h ago, so resuming re-reads it all');
});

test('after a compaction since its last turn, guesses the context from the summary, with nothing cached', () => {
	const summary = 'x'.repeat(40_000);
	const text = [
		turn('2026-01-01T10:00:00Z', { input_tokens: 2, cache_read_input_tokens: 300_000, cache_creation: { ephemeral_1h_input_tokens: 10 } }),
		entry({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-01-01T10:30:00Z' }),
		entry({ type: 'user', isCompactSummary: true, message: { content: summary } }),
	].join('\n');
	const use = readContextUse(text)!;
	assert.equal(use.compacted, true);
	assert.equal(use.at, Date.parse('2026-01-01T10:30:00Z'));
	// The summary's 10k, and the system prompt and tools.
	assert.ok(use.tokens > 29_000 && use.tokens < 31_000, `${use.tokens}`);
	assert.equal(describeContext(use, Date.parse('2026-01-01T10:33:00Z')), '~30k tokens, compacted 3m ago');
	// A turn after the compaction says the real size again.
	const later = readContextUse(text + '\n' + turn('2026-01-01T11:00:00Z', { input_tokens: 12_000, cache_creation: { ephemeral_1h_input_tokens: 12_000 } }))!;
	assert.deepEqual(later, { tokens: 12_000, at: Date.parse('2026-01-01T11:00:00Z'), cacheMs: 60 * 60_000 });
});

test('a conversation of 50k tokens or more is worth a fresh start, unless it has been compacted', () => {
	const use = (tokens: number, compacted?: boolean) => ({ tokens, at: 0, cacheMs: 0, compacted });
	assert.ok(worthFreshStart(use(50_000)));
	assert.ok(!worthFreshStart(use(49_999)));
	assert.ok(!worthFreshStart(use(200_000, true)));
	assert.ok(!worthFreshStart(undefined));
});
