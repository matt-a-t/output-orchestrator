import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { execa } from 'execa';

/**
 * oo's recommended delta styles (the README's [delta] section): file headers a solid bar, hunk
 * headers dim. Values are as git config stores them, so `#` needs no quoting here.
 */
export const RECOMMENDED: [string, string][] = [
	['file-style', 'bold black #87afff'],
	['file-decoration-style', '#87afff ol ul'],
	['hunk-header-style', 'line-number syntax dim'],
	['hunk-header-decoration-style', 'none'],
];

// Keys that change the label HUNK_LABEL in viewerModel.ts looks for, so }/{ stop finding hunks.
const NAVIGATE_KEYS = ['hunk-label'];

// Two files and three hunks, with function context in the hunk headers.
const SAMPLE_DIFF = `diff --git a/src/greet.ts b/src/greet.ts
index 3b18e51..a9c2f4d 100644
--- a/src/greet.ts
+++ b/src/greet.ts
@@ -3,4 +3,4 @@ import { name } from './name.js';
 export function greet(who: string): string {
-	return 'Hello, ' + who;
+	return \`Hello, \${who}!\`;
 }
 export function wave(who: string): string {
@@ -12,3 +12,4 @@ export function shout(who: string): string {
 	const loud = greet(who).toUpperCase();
-	return loud;
+	// Shouting twice is louder.
+	return \`\${loud} \${loud}\`;
 }
diff --git a/src/name.ts b/src/name.ts
index 7d1e2a0..c40b9e3 100644
--- a/src/name.ts
+++ b/src/name.ts
@@ -1,2 +1,2 @@
-export const name = 'world';
+export const name = process.env.USER ?? 'world';
 export const greeting = 'Hello';
`;

/** `git config --get-regexp` output as key → value, keeping only top-level delta.<key> lines. */
export function parseDeltaConfig(output: string): Map<string, string> {
	const config = new Map<string, string>();
	for (const line of output.split('\n')) {
		const space = line.indexOf(' ');
		const key = space === -1 ? line : line.slice(0, space);
		const match = /^delta\.([^.]+)$/.exec(key);
		if (match) config.set(match[1]!, space === -1 ? '' : line.slice(space + 1));
	}
	return config;
}

/** Your [delta] keys, from every git config scope. */
export async function deltaConfig(): Promise<Map<string, string>> {
	// Exits 1 when nothing matches, so there's nothing to parse.
	const result = await execa('git', ['config', '--get-regexp', '^delta\\.[^.]+$'], { reject: false });
	return parseDeltaConfig(result.stdout);
}

/** The recommended keys you haven't set. Ones you have, to anything, are left alone. */
export function missing(config: Map<string, string>): [string, string][] {
	return RECOMMENDED.filter(([key]) => !config.has(key));
}

/** What in your config gets in the way of oo's diffs. (navigate doesn't: oo passes --navigate.) */
export function navigateWarnings(config: Map<string, string>): string[] {
	const warnings: string[] = [];
	for (const key of NAVIGATE_KEYS) {
		if (config.has(key)) warnings.push(`${key} is set: }/{ look for delta's default hunk label, so they may skip hunks`);
	}
	if (config.has('features')) warnings.push(`features is set (${config.get('features')}): a feature's styles can override these`);
	return warnings;
}

/** True when none of the recommended styles is set, so files and hunks look alike. */
export async function noStyling(): Promise<boolean> {
	return missing(await deltaConfig()).length === RECOMMENDED.length;
}

/**
 * `oo delta`: show your [delta] config, what oo would add, and a preview, then add it to
 * ~/.gitconfig on y. Exits 0 when it wrote, 2 when cancelled and 3 when there's nothing to add.
 */
export async function deltaCommand(): Promise<number> {
	const config = await deltaConfig();
	console.log('Your [delta] config:');
	if (config.size === 0) console.log('  (none set)');
	for (const [key, value] of config) console.log(`  ${key} = ${value}`);
	for (const warning of navigateWarnings(config)) console.log(`⚠ ${warning}`);
	const adding = missing(config);
	if (adding.length === 0) {
		console.log("\nIt already has oo's styles.");
		return 3;
	}
	console.log('\noo would add:');
	for (const [key, value] of adding) console.log(`  git config --global delta.${key} '${value}'`);
	console.log('\nPreview:');
	const flags = adding.map(([key, value]) => `--${key}=${value}`);
	const preview = await execa('delta', ['--paging=never', '--navigate', ...flags], {
		input: SAMPLE_DIFF,
		stdout: 'inherit',
		reject: false,
	});
	if ((preview as { code?: string }).code === 'ENOENT') {
		console.log('  delta is not installed: https://github.com/dandavison/delta');
	}
	const rl = createInterface({ input: stdin, output: stdout });
	const answer = await rl.question('\nAdd these to ~/.gitconfig? [y/N] ');
	rl.close();
	if (answer.trim().toLowerCase() !== 'y') return 2;
	for (const [key, value] of adding) await execa('git', ['config', '--global', `delta.${key}`, value]);
	console.log(`Added ${adding.length} key${adding.length === 1 ? '' : 's'}`);
	return 0;
}
