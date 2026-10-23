# output-orchestrator

`oo` is a kanban board in your terminal for running several Claude Code threads at once. Each
thread gets its own git worktree, branch and real `claude` running in a tmux window. You move
it from Planned through Active and Polish to PR and Done, and review and approve claude's changes
from the board as you go.

<!-- TODO: screenshot or asciinema of the board -->

## Requirements

Works on macOS, Linux and WSL.

| Tool | Version | What for | Install |
| --- | --- | --- | --- |
| [Node.js](https://nodejs.org) | 22+ | runs oo | `brew install node` / [nodejs.org](https://nodejs.org/en/download) |
| [tmux](https://github.com/tmux/tmux/wiki/Installing) | 3.2+ | the board and every thread's window | `brew install tmux` / `apt install tmux` |
| git | any recent | worktrees and branches | usually already there |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | | the threads themselves | `npm i -g @anthropic-ai/claude-code` |
| [GitHub CLI](https://cli.github.com) | | opening PRs and noticing when they merge; run `gh auth login` once | `brew install gh` / [cli.github.com](https://github.com/cli/cli#installation) |
| [delta](https://github.com/dandavison/delta) | | reviewing diffs (`d`, `D`, `M-d`) | `brew install git-delta` / `apt install git-delta` |
| vim | | commenting on diffs (`c`) and the changed-hunks list (`o`) | usually already there |

`oo` checks for these when it starts. It won't start without tmux, git and claude, and it warns
about the rest, which only some actions need.

## Install

```bash
npm install -g output-orchestrator
```

Run the same command again to update.

## Quick start

```bash
oo project add ~/code/my-repo    # once per repo; the name defaults to the folder's
oo                               # open the board
```

On the board, `n` starts a thread in Planned (you give it a project, a ticket if the project
has a tracker, and a title, and `e` adds a plan if you want one), and Enter opens its claude. `Ctrl-b b` (or `Alt-b`) brings you back to the
board. `?` on the board lists every key, and so does [KEYS.md](KEYS.md).

`oo` starts (or reattaches to) a tmux session called `oo` with the board in it. If you run it
inside tmux, it opens the board in the current window, or jumps to the board if it's already
running.

## How it works

### Threads and columns

A **thread** is one piece of work: a git worktree, a branch, possibly a PR, and the claude runs
that worked on it. Its columns are **Planned → Active → Polish → PR → Done**. `H` / `L` move the
selected thread between columns, and `J` / `K` reorder it within one.

Leaving Planned (or opening a thread) gives it its own worktree and branch (`av-123-<title>` from its ticket, or `oo/<title>` without one),
under `~/.local/share/output-orchestrator/worktrees/`, and claude runs there. If a thread in
Planned has claude make a plan and you approve it, the plan is saved to the thread and the thread
moves to Active.

Thread numbers (`#12`) only mean something on this machine's board, so they stay out of git:
branches and PRs are named after the thread's ticket instead (see [Tickets](#tickets)).

Enter opens or jumps to the thread's `claude` window. If the window was closed (e.g. after a
restart), Enter resumes the thread where it left off. If the window was closed while claude was
still working, `w` resumes it in the background and tells it to keep going without you leaving
the board, and `W` does the same for every thread like that, after asking first. The project's
wake prompt (`P`) changes what it's told. `e` opens a thread's own screen. Its title,
ticket, project, colour and diff base are edited in place and its plan in `$EDITOR`, and the rest of what
the board knows about it (branch, worktree, session, PR, …) is shown beneath. A thread that
already has a branch or directory can't change project.

Card badges: ⚙ working, ⏸ needs you (permission prompt), ✓ stopped, ○ window open with no
activity yet, ↻ no window but resumable (red if it was closed mid-work, for `w` / `W`), ± uncommitted changes waiting to be reviewed and
approved. Each card shows the thread number and project abbreviation (or name, if it has none),
with the title beneath (after its ticket key, if it has one).

### Tickets

Threads usually work on a ticket: a Jira ticket at work, a GitHub issue elsewhere. Set where a
project's tickets come from with **tickets** in the projects screen (`P`):

- **github**: issues in the project's repo, read with `gh`.
- **jira**: also set **jira site** (e.g. `yourco.atlassian.net`) and **jira project**, the key
  prefix (e.g. `AV`), so `123` means `AV-123`. oo reads Jira Cloud's REST API with an
  [API token](https://id.atlassian.com/manage-profile/security/api-tokens): export
  `JIRA_EMAIL` and `JIRA_API_TOKEN` in the shell you start `oo` from.

`n` on such a project asks for the ticket first:

```
Attach key: AV-123     fetch the ticket; its summary is the title, its description the plan
No key, use oo         no ticket: type a title as usual
Recent tickets:        your five most recently updated open tickets, to pick from
```

The ticket names the branch (`av-123-<title>` for Jira, `45-<title>` for issue #45; threads
without one get `oo/<title>`) and the PR: its title starts with `AV-123: ` or `#45: `, and its
description ends with a link to the Jira ticket or `Closes #45`. Adding or changing a thread's
ticket later (`e`) renames its branch to match, unless the branch has already been pushed.
`oo thread add --ticket <key>` attaches one from the command line.

### Reviewing and approving

- `d` shows the diff since the last commit (the current **step**), and `D` the whole thread
  against the branch it came from. Both go through `delta` in `less`, under a `git diff --stat` of
  the changed files and how much each changed, and `n` / `N` jump between files and hunks.
- In a step diff, `a` approves the step (after a y/n confirm). Approving commits everything with
  a message claude drafts, and you edit its subject on the board (esc cancels, leaving the changes
  staged; the drafted body is kept as is). If the thread's claude has stopped (✓), it's then told
  the step was committed and to move on to the next checkpoint.
- `c` opens the diff in vim for comments. Write notes on lines starting `>>` under the diff line
  they're about, and when you save they're sent to the thread's claude as `file:line — note`
  feedback (`:cq` cancels).
- `o` opens the changed hunks in vim as a quickfix list.

Confirmations (quit, archive, approve, resuming a busy thread) all take `y`. Any other key cancels.

### Working beside claude

`s` opens a shell and `M-d` (alt-d) a diff to the right of the thread's claude window (starting
claude if it isn't running) and jumps there. The diff is the step's, or the thread's when the
step has none, and `t` switches between them. `r` refreshes it as claude makes changes, and `q`
closes it. `a` commits everything uncommitted, like approving from `d`: claude drafts the message
and it opens in `$EDITOR` (an empty subject cancels, leaving the changes staged), and a stopped
claude is told to move on. Pressing the
other key swaps what's on the right, and either key jumps back to it later. From inside a
thread's window, `M-s` / `M-d` do the same, and other `Alt` keys move between panes and threads,
scroll and go back to the board (see [KEYS.md](KEYS.md)).

### Local: trying a thread in your usual setup

`t` puts a thread in Local, so you can try it out in your usual dev
setup. Its branch is checked out in the project's own checkout (which must have no uncommitted
changes to tracked files), its worktree is removed, and its claude moves there too. Only one
thread per project fits. The thread stays where it is in its column, its card outlined in yellow,
but it can't move between columns until `t` brings it back. Bringing it back needs the checkout clean, puts
the checkout back on the default branch, and gives the thread its worktree again.

`oo thread local [id] [in|out]` does the same from the shell, and a thread's claude offers it when you want
to try its change. If the thread's claude is working, the move waits until its turn ends.

### Project hooks

Each project can set hooks in the projects screen (`P`). These are shell commands that run when
something happens on the board. So far there are two, enter local and leave local. They run in
the project's checkout once the branch is checked out or the checkout is back on main (for an
imported thread, enter runs in the thread's own directory). For example, `npm install && npm run
dev` as the enter local hook gives you a running dev server for the thread.

They run in a background tmux window named `oo-hook-<project>`. The window becomes a shell when
the command exits, so its output stays readable. The next hook replaces it and stops anything
still running (e.g. a dev server). `OO_THREAD_ID`, `OO_PROJECT` and `OO_BRANCH` are set for them.

### PRs and Done

Moving a thread to PR pushes its branch and opens a PR into the repo's default branch with
`gh pr create`, whatever branch the thread started from. claude drafts the title and description
from the thread's commits and diff (with the ticket added, see [Tickets](#tickets)), and they open in vim for you to change first (an empty title
cancels). `b` opens the selected thread's PR in your browser (`$BROWSER` if set; under WSL,
Windows' default browser). The board checks open PRs every minute and moves merged ones to Done.

Moving a thread to Done or archiving it (`x`) removes the worktree and closes its claude window.
The branch stays. Done keeps a worktree that has uncommitted changes, and archiving refuses
until they're committed or discarded. `F` moves a thread straight to Done from any column after
a `y` to confirm (a thread in Local has to come back with `t` first).

### Importing threads

`i` imports a thread you started outside the board (e.g. plain `claude` in the project's
directory). Pick one from the project's recent threads and it lands in Planned, where Enter
resumes it, with badges from then on. Imported threads keep running in the directory they
started in rather than a worktree, so diffs, comments and approve work there but they can't
open a PR. If the thread looks like it's still open somewhere else, Enter warns first, and `y`
resumes anyway.

### From the command line

`oo thread add|list|show|move|plan` reads and changes the board from a shell, and from inside a
thread's claude, where the thread id defaults to that thread. Run `oo help` to see them all.
claude learns these commands from an `oo` skill that the board installs (see below), so you can
ask a thread's claude to file follow-up work as a new thread.

## Keys

`?` on the board lists every key, and [KEYS.md](KEYS.md) has the same list.

The mouse works too. Click a card to select it, double-click to open it, and scroll to move up
and down (the import list works the same way). For this the board turns on tmux's `mouse` option
for its session, so in claude windows dragging selects into tmux's buffer. Hold Shift while
dragging to use your terminal's own selection.

Columns too long for the window scroll with the cursor, with `↑ n more` / `↓ n more` marking
what's hidden. Done shows one line per thread and, while you're not in it, only its newest arrivals.

## What oo changes outside its own folder

- **tmux key bindings**, set when the board starts: `prefix b` and `prefix Ctrl-b` jump to the
  board, plus some `Alt` keys in thread windows only (see [KEYS.md](KEYS.md); everywhere else
  those keys still reach the program, e.g. readline's `M-b` back-a-word). Keys you've already
  bound to something else are left alone, except that `prefix Ctrl-b` replaces tmux's default
  send-prefix (sending a literal `Ctrl-b`).
- **tmux `mouse` on**, for the `oo` session only.
- **`~/.claude/skills/oo/SKILL.md`**, rewritten each time the board starts, which teaches claude the
  `oo thread` commands.
- Your own Claude Code settings are left alone. Thread claudes get oo's claude hooks through
  `--settings` pointing at oo's own settings file.

Everything else lives in `~/.local/share/output-orchestrator/`: `state.json` (projects and
threads), claude hook events, and the thread worktrees.

## Development

```bash
git clone https://github.com/matt-a-t/output-orchestrator.git
cd output-orchestrator
npm install
npm run build
npm link            # puts this checkout's `oo` on your PATH
```

`npm run dev` runs from source with tsx, `npm test` runs the tests, and `npm run typecheck` checks
types. After changing code, `rm -rf dist && npm run build` and restart the board (`q`, then `oo`):
the running board keeps the code it started with, while claude hooks pick up the new build
straight away. [PLAN.md](PLAN.md) has the design and milestones.

To release: `npm version patch` (or `minor`), `npm publish`, `git push --follow-tags`.
`prepublishOnly` does a clean build first.
