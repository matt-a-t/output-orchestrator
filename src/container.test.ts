import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configLabel, containerHome, containerName, execCommand, forThread, mounts, NO_TOKEN, parsePorts, portsText, prepareHome, runArgs, strayContainers, threadShell, type Paths } from './container.js';
import { claudeShellRunning } from './tmux.js';
import type { Thread } from './state.js';
import type { Project } from './state.js';

const paths: Paths = { home: '/home/u', dataDir: '/home/u/.local/share/output-orchestrator', ooDir: '/home/u/dev/oo', uid: 1000, gid: 1000 };
const project: Project & { container: { image: string; allow: string[]; ports: number[] } } = {
	name: 'app',
	abbrev: '',
	path: '/home/u/dev/app',
	worktrees: true,
	color: 'cyan',
	wakePrompt: '',
	closeIdleAfter: 30,
	hooks: {},
	commands: [],
	tracker: 'none',
	jiraSite: '',
	jiraProject: '',
	container: { image: 'oo-thread', allow: ['pypi.org'], ports: [3000, 5173] },
};
const thread = { project: 'app', id: '7' };
const cwd = '/home/u/.local/share/output-orchestrator/worktrees/app/7';
const all = () => true;

test('a container is named for its project and thread, in what docker allows', () => {
	assert.equal(containerName(thread), 'oo-app-7');
	assert.equal(containerName({ project: 'my app/x', id: '12' }), 'oo-my-app-x-12');
});

test('a container sees its own worktree, not the other threads\' or their homes', () => {
	const m = mounts(project, thread, cwd, paths, all);
	const targets = m.map(x => x.target);
	const at = (target: string) => targets.indexOf(target);
	// DATA_DIR, then tmpfs over the worktrees and homes in it, then this worktree on top.
	assert.ok(at(paths.dataDir) < at(`${paths.dataDir}/worktrees`));
	assert.ok(at(`${paths.dataDir}/worktrees`) < at(cwd));
	assert.deepEqual(m.find(x => x.target === `${paths.dataDir}/worktrees`), { kind: 'tmpfs', target: `${paths.dataDir}/worktrees` });
	assert.deepEqual(m.find(x => x.target === `${paths.dataDir}/homes`), { kind: 'tmpfs', target: `${paths.dataDir}/homes` });
	// Its own home is at $HOME, mounted first.
	assert.deepEqual(m[0], { kind: 'bind', source: containerHome(paths, thread), target: paths.home });
	// Everything else is at its host path.
	for (const x of m.slice(1)) if (x.kind === 'bind') assert.equal(x.source, x.target);
});

test("the host runs .git's hooks and oo's settings, so the container can't change them", () => {
	const m = mounts(project, thread, cwd, paths, all);
	const readonly = (target: string) => (m.find(x => x.target === target && x.kind === 'bind') as { readonly?: boolean } | undefined)?.readonly;
	assert.equal(readonly('/home/u/dev/app/.git'), undefined);
	assert.equal(readonly('/home/u/dev/app/.git/hooks'), true);
	// git push -u and tracking branches write the config.
	assert.ok(!m.some(x => x.target === '/home/u/dev/app/.git/config'));
	// oo's data folder is read-only, state.json and the claude settings with it, but for what claude's hooks and oo thread write.
	assert.equal(readonly(paths.dataDir), true);
	assert.equal(readonly(`${paths.dataDir}/events.jsonl`), undefined);
	assert.equal(readonly(`${paths.dataDir}/requests.jsonl`), undefined);
	assert.ok(m.findIndex(x => x.target === paths.dataDir) < m.findIndex(x => x.target === `${paths.dataDir}/requests.jsonl`));
	assert.equal(readonly(paths.ooDir), true);
	// Your git config comes along read-only, so commits have your name.
	assert.equal(readonly('/home/u/.gitconfig'), true);
});

test('a path mounted twice is mounted once, the first way', () => {
	const m = mounts(project, thread, cwd, { ...paths, ooDir: cwd }, all);
	assert.deepEqual(m.filter(x => x.target === cwd), [{ kind: 'bind', source: cwd, target: cwd }]);
});

test('only this directory\'s transcripts and the project\'s memory come from ~/.claude, with settings read-only', () => {
	const m = mounts(project, thread, cwd, paths, path => !path.endsWith('agents'));
	const claude = m.filter(x => x.target.startsWith('/home/u/.claude')).map(x => [x.target, x.kind === 'bind' && !!x.readonly]);
	assert.deepEqual(claude, [
		['/home/u/.claude/projects/-home-u--local-share-output-orchestrator-worktrees-app-7', false],
		['/home/u/.claude/projects/-home-u-dev-app/memory', false],
		['/home/u/.claude/settings.json', true],
		['/home/u/.claude/CLAUDE.md', true],
		['/home/u/.claude/skills', true],
		['/home/u/.claude/commands', true],
		['/home/u/.claude/keybindings.json', true],
	]);
	// Not the whole of it, and so not the credentials.
	assert.ok(!m.some(x => x.target === '/home/u/.claude'));
});

test('the run args drop capabilities, publish ports on loopback and label the container', () => {
	const args = runArgs(project, thread, cwd, paths, all);
	const joined = args.join(' ');
	assert.deepEqual(args.slice(0, 2), ['run', '-d']);
	assert.deepEqual(args.slice(-3), ['oo-thread', 'sleep', 'infinity']);
	assert.match(joined, /--user 1000:1000 -e HOME=\/home\/u/);
	// Commits made in it are yours, wherever your git config keeps your name.
	const withGit = runArgs(project, thread, cwd, { ...paths, git: { name: 'Ann Lee', email: 'ann@example.com' } }, all);
	for (const v of ['GIT_AUTHOR_NAME=Ann Lee', 'GIT_COMMITTER_NAME=Ann Lee', 'GIT_AUTHOR_EMAIL=ann@example.com', 'GIT_COMMITTER_EMAIL=ann@example.com']) assert.equal(withGit[withGit.indexOf(v) - 1], '-e');
	assert.match(joined, /--cap-drop ALL --cap-add NET_ADMIN --cap-add NET_RAW --security-opt no-new-privileges/);
	assert.match(joined, /-p 127\.0\.0\.1::3000 -p 127\.0\.0\.1::5173/);
	assert.match(joined, /--label oo\.thread=7 --label oo\.project=app/);
	assert.match(joined, /--tmpfs \/home\/u\/\.local\/share\/output-orchestrator\/worktrees/);
	assert.match(joined, /type=bind,source=\/home\/u\/dev\/app\/\.git\/hooks,target=\/home\/u\/dev\/app\/\.git\/hooks,readonly/);
});

test('a change to the image, ports or hosts changes the config label, so the container is made again', () => {
	const label = (p: typeof project) => configLabel(runArgs(p, thread, cwd, paths, all));
	const base = label(project);
	assert.match(base ?? '', /^[0-9a-f]{16}$/);
	assert.equal(label({ ...project }), base);
	assert.notEqual(label({ ...project, container: { ...project.container, image: 'other' } }), base);
	assert.notEqual(label({ ...project, container: { ...project.container, ports: [3000] } }), base);
	assert.notEqual(label({ ...project, container: { ...project.container, allow: [] } }), base);
});

test('commands run in the container with oo on PATH, and the token passed by name only', () => {
	const command = execCommand('oo-app-7', cwd, ['claude', '--resume', 'abc'], { OO_THREAD_ID: '7' }, { dataDir: paths.dataDir, key: 'oo-thread-7' });
	// Its session is recorded under the window's key, since closing the window doesn't end it.
	assert.deepEqual(command, [
		'docker', 'exec', '-it', '-w', cwd, '-e', 'OO_THREAD_ID=7', '-e', 'CLAUDE_CODE_OAUTH_TOKEN', 'oo-app-7',
		'sh', '-c', 'echo $$ >> /tmp/oo-oo-thread-7.pid; PATH="$0:$PATH" exec "$@"', `${paths.dataDir}/bin`, 'claude', '--resume', 'abc',
	]);
	assert.equal(execCommand('n', cwd, ['true'], {}, { interactive: false })[2], '-i');
});

test('reads published ports, keeping the first of an IPv4/IPv6 pair', () => {
	const ports = parsePorts(['3000/tcp -> 127.0.0.1:49153', '3000/tcp -> [::1]:49154', '5173/tcp -> 127.0.0.1:49155', '53/udp -> 127.0.0.1:1', ''].join('\n'));
	assert.deepEqual([...ports], [[3000, 49153], [5173, 49155]]);
});

test('the container\'s home has the mount points ready, owned by you, and claude set up', () => {
	const root = mkdtempSync(join(tmpdir(), 'oo-container-'));
	const home = join(root, 'home');
	const local: Paths = { home, dataDir: join(home, '.local/share/oo'), ooDir: join(home, 'dev/oo'), uid: 1000, gid: 1000 };
	const repo = join(home, 'dev/app');
	mkdirSync(join(repo, '.git/hooks'), { recursive: true });
	writeFileSync(join(repo, '.git/config'), '');
	mkdirSync(join(home, '.claude'), { recursive: true });
	writeFileSync(join(home, '.claude/settings.json'), '{}');
	const p = { ...project, path: repo };
	const work = join(local.dataDir, 'worktrees/app/7');
	prepareHome(p, thread, work, local);
	const inHome = containerHome(local, thread);
	assert.ok(statSync(join(inHome, '.local/share/oo')).isDirectory());
	assert.ok(statSync(join(inHome, 'dev/oo')).isDirectory());
	assert.ok(statSync(join(inHome, '.claude/settings.json')).isFile());
	// The transcript and memory directories exist on the host too, else docker makes them as root.
	assert.ok(existsSync(join(home, '.claude/projects', work.replace(/[^a-zA-Z0-9]/g, '-'))));
	const config = JSON.parse(readFileSync(join(inHome, '.claude.json'), 'utf8'));
	assert.equal(config.hasCompletedOnboarding, true);
	assert.equal(config.projects[work].hasTrustDialogAccepted, true);
	// Made again, it leaves what claude has written since alone.
	writeFileSync(join(inHome, '.claude.json'), '{"kept":true}');
	prepareHome(p, thread, work, local);
	assert.equal(readFileSync(join(inHome, '.claude.json'), 'utf8'), '{"kept":true}');
});

test("a project without a container runs a thread's commands as they are", async () => {
	const host = { ...project, container: undefined };
	const t = { ...thread, title: 't', column: 'active', createdAt: '', updatedAt: '' } as never;
	assert.deepEqual(await forThread(host, t, cwd, ['claude'], { OO_THREAD_ID: '7' }, { needsToken: true, token: undefined }), { command: ['claude'], env: { OO_THREAD_ID: '7' } });
	assert.deepEqual(threadShell(host), [process.env.SHELL || 'bash']);
});

test("claude in a container needs the token, and says how to get one, before docker is touched", async () => {
	const t = { ...thread, title: 't', column: 'active', createdAt: '', updatedAt: '' } as never;
	await assert.rejects(forThread(project, t, cwd, ['claude'], {}, { needsToken: true, token: undefined }), { message: NO_TOKEN });
	assert.match(NO_TOKEN, /claude setup-token/);
	assert.equal(threadShell(project)[0], 'sh');
});

test("at startup the board removes containers that no thread needs any more, and keeps the rest", () => {
	const t = (id: string, column: string, p = 'app') => ({ id, project: p, column }) as Thread;
	const threads = [t('1', 'active'), t('2', 'done'), t('3', 'archived'), t('4', 'ideas'), t('5', 'polish', 'plain'), t('6', 'planned')];
	const plain = { ...project, name: 'plain', container: undefined };
	const containers = new Map([
		['oo-app-1', '1'],
		['oo-app-2', '2'],
		['oo-app-3', '3'],
		['oo-app-4', '4'],
		['oo-plain-5', '5'],
		['oo-app-6', '6'],
		['oo-app-99', '99'],
		// A label that doesn't match the name it's under isn't one of ours to keep.
		['oo-other-1', '1'],
	]);
	assert.deepEqual(strayContainers(containers, threads, [project, plain]), ['oo-app-2', 'oo-app-3', 'oo-app-4', 'oo-plain-5', 'oo-app-99', 'oo-other-1']);
});

test("ports read as inside→host for the card", () => {
	assert.equal(portsText(new Map([[3000, 49153], [5173, 49155]])), '3000→49153 5173→49155');
	assert.equal(portsText(undefined), '');
});

test("a claude shell anywhere in a thread's container keeps its claude open", () => {
	// containerProcesses' pid ppid args, from the container's /proc: claude's Bash tool sources its shell snapshot.
	const ps = ['1 0 /sbin/docker-init -- sleep infinity', '7 1 sleep infinity', '20 0 sh -c PATH="$0:$PATH" exec "$@" claude', '31 20 /bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash.sh && npm run dev'].join('\n');
	assert.ok(claudeShellRunning(ps, 0));
	assert.ok(!claudeShellRunning(ps.split('\n').slice(0, 3).join('\n'), 0));
});
