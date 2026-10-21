# output-orchestrator

Kanban TUI for Claude Code threads, running real `claude` sessions in tmux.
See [PLAN.md](PLAN.md) for the design and milestones.

## Setup

```bash
npm install
npm run build
npm link            # puts `oo` on your PATH
```

Add to `~/.tmux.conf` to jump back to the board from any thread:

```
bind b select-window -t oo-board
```

Then reload it with `tmux source-file ~/.tmux.conf` (or restart tmux).

## Use

```bash
oo project add ~/code/my-repo [name]
oo
```

`oo` starts (or reattaches to) a tmux session called `oo` with the board in it. Run
inside tmux, it opens the board in the current window, or jumps to it if it's already
running.

Keys are listed at the bottom of the board. `n` / `e` open `$EDITOR` (default vim)
in a tmux popup; Enter opens or jumps to the thread's `claude` window, resuming
the thread's last session if its window was closed (e.g. after a restart).

Leaving Planned (or opening a thread) gives it its own git worktree and branch
(`oo/<id>-<title>`), under `~/.local/share/output-orchestrator/worktrees/`; claude runs
there. Review a step with `d` (diff since the last commit) or `D` (whole thread vs the
branch it came from), shown through `delta`; `o` opens the changed hunks in vim as a
quickfix list; `a` accepts the step by committing everything (`git commit -v`). Moving a
thread to Done or archiving it removes the worktree (kept if it has uncommitted changes)
and closes its claude window; the branch stays.

Card badges: ⚙ working, ⏸ needs you (permission prompt), ✓ stopped, ○ window open
with no activity yet, ↻ no window but resumable.

State lives in `~/.local/share/output-orchestrator/state.json`.
