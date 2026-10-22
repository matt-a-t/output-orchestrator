# output-orchestrator

## Running a thread's changes locally (UI testing)

`oo` is installed with `npm link`, so it runs `dist/` from this checkout. Moving a thread to UI
testing checks its branch out here, but nothing rebuilds:

1. `rm -rf dist && npm run build`. tsc never deletes output, so a clean build drops stale files
   from renamed or removed modules.
2. Quit the board (`q`) and run `oo` again. The running board keeps the code it started with.
   Hooks run `dist/hook.js` fresh on every event, so they're up to date as soon as the build is.

Leaving UI testing puts the checkout back, so rebuild and restart again to get the previous
version back.

## Nomenclature

- **Thread**: what moves through the board. It has a worktree, a branch and maybe a PR, and can
  span several claude runs. Use "thread" in the UI, docs and code, including for ones started
  outside the board (`OutsideThread`, imported with `i`).
- **Session**: only claude's own session ID (`sessionId`, `claude --resume`, the `SessionStart`
  hook) or the `oo` tmux session.
- **Card**: how a thread is drawn on the board, not a name for the thread itself.
