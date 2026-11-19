# output-orchestrator

## Running a thread's changes locally (Local)

`oo` is installed with `npm link`, so it runs `dist/` from this checkout. Putting a thread in Local
checks its branch out here, but nothing rebuilds unless the project's hooks do it:

1. `npm run clean-build` (a good enter local and leave local hook). tsc never deletes
   output, so a clean build drops stale files from renamed or removed modules.
2. Quit the board (`q`) and run `oo` again. The running board keeps the code it started with.
   Claude's hooks run `dist/hook.js` fresh on every event, so they're up to date as soon as the build is.

Leaving Local puts the checkout back on main, so rebuild and restart again to get that version back.

For a project with a `container` setting, Local checks nothing out. It forwards the project's ports to the
thread's container instead (`src/board/forward.ts`), and with `container.compose` runs the compose stack on the
host from the thread's worktree and joins the container to it (`src/stack.ts`), so the steps above don't apply.
`inCheckout` (threads.ts) is what tells the two kinds of Local apart. The stack's compose files come from the
project checkout, never the worktree, which the container can write.

## Containers

`src/container.ts` builds the `docker run`/`docker exec` args and mounts. Everything is mounted at its host
path, so worktree paths, transcripts and `--resume` mean the same inside. Container threads load
`claude-settings.container.json`, which runs the claude hooks with the image's `node`, and reach oo through
`DATA_DIR/bin/oo`, which runs this checkout's `dist` (mounted read-only). After changing anything claude's
hooks or `oo thread` run, rebuild here: containers pick it up straight away, like host threads do.
The reference image and firewall are in `docker/`. To try them, build the image (see README, Containers) and
set it on a scratch project, not on this one while you're running threads on it.

## Data files

oo's data lives in `~/.local/share/output-orchestrator` (`DATA_DIR`, state.ts), private to the user. `state.json` is
the board as it is now. `history.jsonl` gets a line for each change in a thread's life (created, moved, Local, PR, ticket,
plan), appended by `saveState` from a diff of the old and new state (`history.ts`), so every writer is covered.
`events.jsonl` gets a line for each claude hook event (`hook.ts`). The oo skill's "Asking about how the user works"
(`SKILL` in status.ts) tells claude how to read and join them, so describe a change to their shape there too.

## Nomenclature

- **Thread**: what moves through the board. It has a worktree, a branch and maybe a PR, and can
  span several claude runs. Use "thread" in the UI, docs and code, including for ones started
  outside the board (`OutsideThread`, imported with `i`).
- **Session**: only claude's own session ID (`sessionId`, `claude --resume`, the `SessionStart`
  hook) or the `oo` tmux session.
- **Message**: what one thread's claude sends another with `oo thread send`. It waits in the receiving
  thread's `inbox` until the board pastes it in or the SessionStart briefing carries it, then counts as delivered.
- **Card**: how a thread is drawn on the board, not a name for the thread itself.
- **Hook**: on its own, a project's shell command for something on the board (`enterLocal`, set in
  the projects screen, see `hooks.ts`). Claude's hooks (`hook.ts`, `status.ts`) are "claude hooks".
