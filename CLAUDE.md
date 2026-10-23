# output-orchestrator

## Running a thread's changes locally (Local)

`oo` is installed with `npm link`, so it runs `dist/` from this checkout. Putting a thread in Local
checks its branch out here, but nothing rebuilds unless the project's hooks do it:

1. `npm run clean-build` (a good enter local and leave local hook). tsc never deletes
   output, so a clean build drops stale files from renamed or removed modules.
2. Quit the board (`q`) and run `oo` again. The running board keeps the code it started with.
   Claude's hooks run `dist/hook.js` fresh on every event, so they're up to date as soon as the build is.

Leaving Local puts the checkout back on main, so rebuild and restart again to get that version back.

## Nomenclature

- **Thread**: what moves through the board. It has a worktree, a branch and maybe a PR, and can
  span several claude runs. Use "thread" in the UI, docs and code, including for ones started
  outside the board (`OutsideThread`, imported with `i`).
- **Session**: only claude's own session ID (`sessionId`, `claude --resume`, the `SessionStart`
  hook) or the `oo` tmux session.
- **Card**: how a thread is drawn on the board, not a name for the thread itself.
- **Hook**: on its own, a project's shell command for something on the board (`enterLocal`, set in
  the projects screen, see `hooks.ts`). Claude's hooks (`hook.ts`, `status.ts`) are "claude hooks".
