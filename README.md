# output-orchestrator

Kanban TUI for Claude Code threads, each running a real `claude` in tmux.
See [PLAN.md](PLAN.md) for the design and milestones.

## Setup

```bash
npm install
npm run build
npm link            # puts `oo` on your PATH
```

The board binds `prefix b` (`Ctrl-b b` by default) to jump back to it from any thread, and
`prefix Ctrl-b` too for when you're still holding ctrl, plus some `Alt` keys with no prefix in
thread windows only (see [KEYS.md](KEYS.md)), unless you've already bound those keys to
something else. `prefix Ctrl-b` normally sends a literal `Ctrl-b` (send-prefix), which this
replaces.

## Use

```bash
oo project add ~/code/my-repo [name]
oo
```

`oo` starts (or reattaches to) a tmux session called `oo` with the board in it. Run
inside tmux, it opens the board in the current window, or jumps to it if it's already
running.

`?` on the board lists every key, and so does [KEYS.md](KEYS.md). The mouse works too: click a card to select
it, double-click to open it, scroll to move up and down (the import list works the same way).
For that the board turns on tmux's `mouse` option for its session, so in claude windows
dragging selects into tmux's buffer; hold Shift while dragging for your terminal's own selection. `n` / `e` open `$EDITOR` (default vim)
in a tmux popup; Enter opens or jumps to the thread's `claude` window, resuming
the thread where it left off if its window was closed (e.g. after a restart).

Leaving Planned (or opening a thread) gives it its own git worktree and branch
(`oo/<id>-<title>`), under `~/.local/share/output-orchestrator/worktrees/`; claude runs
there. Review a step with `d` (diff since the last commit) or `D` (whole thread vs the
branch it came from), shown through `delta` in `less` — `n`/`N` jump between files and hunks,
and in a step diff `a` approves it (after a y/n confirm); `o` opens the changed hunks in vim as a
quickfix list; `c` opens the diff in vim for comments — write notes on lines starting `>>`
under the diff line they're about, and on save they're sent to the thread's claude as
`file:line — note` feedback (`:cq` cancels). Approving a step commits everything with a message
claude drafts, whose subject you edit on the board (esc cancels, leaving the changes staged; the
drafted body is kept as is). Confirmations (quit, archive, approve, resuming a busy thread) all
take `y`; any other key cancels.

To work beside claude, `s` opens a shell and `M-d` (alt-d) a diff on the right of the thread's claude
window (starting claude if it isn't running) and jumps there. The diff is the step's, or the
thread's when the step has none, and `t` switches between them; `r` refreshes it as claude makes
changes, and `q` closes it. `a` commits everything uncommitted, like approving from `d`: claude
drafts the message and it opens in `$EDITOR` (an empty subject cancels, leaving the changes
staged). Pressing the other key swaps what's on the right, and either
key jumps back to it later. From inside a thread's window, `M-s` / `M-d` do the same, and other
`Alt` keys move between panes and threads, scroll and go back to the board (see [KEYS.md](KEYS.md)).

`t` puts a thread in Local, a box beside the columns, to try it out in your usual dev setup:
its branch is checked out in the project's own checkout (which needs no uncommitted changes to
tracked files), its worktree is removed, and its claude moves there too. Only one thread per
project fits. The thread keeps its column, shown on its card, but can't move between columns
until `t` brings it back: that needs the checkout clean, puts it back on the default branch,
and gives the thread its worktree again.

Each project can set hooks in the projects screen (`P`): shell commands run when something
happens on the board. So far there are two, enter local and leave local, run in the project's
checkout once the branch is checked out or the checkout is back on main (in an imported thread,
enter runs in the thread's own directory). They run in a background tmux window named
`oo-hook-<project>` that becomes a shell when the command exits, so its output stays readable;
the next hook replaces it, stopping anything still running (e.g. a dev server). `OO_THREAD_ID`,
`OO_PROJECT` and `OO_BRANCH` are set for them.

Moving a thread to PR pushes its branch and opens a PR into the repo's default branch with `gh pr create`, whatever branch the thread started from. claude drafts the
title and description from the thread's commits and diff, and they open in vim for you to
change first (an empty title cancels). `b` opens the selected thread's PR in your browser
(`$BROWSER` if set; under WSL, Windows' default browser). The board checks open PRs every
minute and moves merged ones to Done. Moving a thread to Done or archiving it removes the
worktree and closes its claude window; the branch stays. Done keeps a worktree with
uncommitted changes; archiving refuses until they're committed or discarded. `F` moves a
thread straight to Done from any column, after a `y` to confirm (a thread in Local has to come
back with `t` first).

Columns too long for the window scroll with the cursor, with `↑ n more` / `↓ n more` marking
what's hidden. Done shows one line per thread and, while you're not in it, its newest arrivals.

`i` imports a thread you started outside the board (e.g. plain `claude` in the
project's directory): pick one from the project's recent threads and it lands in Planned,
where Enter resumes it, with badges from then on. Imported threads keep running in the
directory they started in rather than a worktree, so diffs, comments and approve work
there but they can't open a PR. If the thread looks like it's still open somewhere else, Enter
warns first; `y` resumes anyway.

Card badges (with a legend at the bottom of the board): ⚙ working, ⏸ needs you
(permission prompt), ✓ stopped, ○ window open with no activity yet, ↻ no window but
resumable, ± uncommitted changes waiting to be reviewed and approved. Each card shows the
thread number and project abbreviation (or name, if it has none), with the title beneath. `e` opens a thread's own screen: its title, project,
colour and diff base are edited in place, its plan in `$EDITOR`, and the rest of what the board
knows about it (branch, worktree, session, PR, …) is shown beneath. A thread that already has
a branch or directory can't change project.

State lives in `~/.local/share/output-orchestrator/state.json`.
