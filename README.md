# output-orchestrator

Kanban TUI for Claude Code threads, running real `claude` sessions in tmux.
See [PLAN.md](PLAN.md) for the design and milestones.

## Setup

```bash
npm install
npm run build
npm link            # puts `oo` on your PATH
```

The board binds `prefix b` (`Ctrl-b b` by default) to jump back to it from any thread, and
`prefix Ctrl-b` too for when you're still holding ctrl, plus `Alt-b` with no prefix in thread
windows (where it no longer moves back a word), unless you've already bound those keys
to something else. `prefix Ctrl-b` normally sends a literal `Ctrl-b` (send-prefix), which this
replaces.

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
quickfix list; `c` opens the diff in vim for comments — write notes on lines starting `>>`
under the diff line they're about, and on save they're sent to the thread's claude as
`file:line — note` feedback (`:cq` cancels); `a` accepts the step by committing everything (`git commit -v`).

Moving a thread to PR pushes its branch and opens a PR with `gh pr create`. claude drafts the
title and description from the thread's commits and diff, and they open in vim for you to
change first (an empty title cancels). The board checks open PRs every
minute and moves merged ones to Done. Moving a thread to Done or archiving it removes the
worktree and closes its claude window; the branch stays. Done keeps a worktree with
uncommitted changes; archiving refuses until they're committed or discarded.

Card badges (with a legend at the bottom of the board): ⚙ working, ⏸ needs you
(permission prompt), ✓ stopped, ○ window open with no activity yet, ↻ no window but
resumable. Each card shows the project and thread number, with the title beneath.

State lives in `~/.local/share/output-orchestrator/state.json`.
