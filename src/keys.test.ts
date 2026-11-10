import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BINDINGS } from './board/bindings.js';
import { bindingRows, KEY_SECTIONS } from './keys.js';

// The keys a row's label names: 'd / D' is d and D, 'H/L' is H and L.
const keysOf = (label: string) => label.split(/[\s/]+/).filter(Boolean);

test('every thread binding is on the ? screen, alone or in a pair', () => {
	const shown = new Set(BINDINGS.flatMap(b => (b.help ? keysOf(b.help.keys ?? b.key) : [])));
	for (const b of BINDINGS) assert.ok(shown.has(b.key), `${b.key} has no row on the ? screen`);
});

test('the ? screen and its sections still have the bound rows', () => {
	const section = (title: string) => KEY_SECTIONS.find(s => s.title === title)!.keys;
	for (const title of ['Board', 'Reviewing'] as const) {
		for (const [key, what] of bindingRows(title)) assert.ok(section(title).some(([k, w]) => k === key && w === what), `${key} is missing from ${title}`);
	}
});

test('KEYS.md lists every bound key in the same section', () => {
	const doc = readFileSync(new URL('../KEYS.md', import.meta.url), 'utf8');
	// Each section's table rows, by its ## heading.
	const sections = new Map(
		doc.split(/^## /m).slice(1).map(part => [part.split('\n')[0]!.trim(), part.split('\n').filter(line => line.startsWith('| `')).join('\n')]),
	);
	for (const b of BINDINGS) {
		if (!b.help) continue;
		const rows = sections.get(b.help.section) ?? '';
		for (const k of keysOf(b.help.keys ?? b.key)) {
			// The key column, backquoted: `d` / `D`, `H`/`L`.
			const listed = rows.split('\n').some(line => line.split(' | ')[0]!.includes(`\`${k}\``));
			assert.ok(listed, `KEYS.md's ${b.help.section} table doesn't list ${k}`);
		}
	}
});
