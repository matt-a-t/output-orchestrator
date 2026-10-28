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

On the board, `n` opens the new thread form: a project, a ticket if the project has a tracker, a
title, an initial prompt and a priority (normal unless you change it). Its fields are edited vim-style: `i` to type into one, ⏎ on to the
next, `a` to create it and `q` or esc to cancel. The thread starts in Planned, and `e` adds a plan if you want one.
With an initial prompt, its claude starts straight away in the background, in plan mode, on that
prompt; without one, Enter opens its claude when you're ready. `Ctrl-b b` (or `Alt-b`) brings you back to the
board. `?` on the board lists every key, and so does [KEYS.md](KEYS.md).

`oo` starts (or reattaches to) a tmux session called `oo` with the board in it. If you run it
inside tmux, it opens the board in the current window, or jumps to the board if it's already
running.

## How it works

### Threads and columns

A **thread** is one piece of work: a git worktree, a branch, possibly a PR, and the claude runs
that worked on it. Its columns are **Planned → Active → Polish → PR → Done**. `H` / `L` move the
selected thread between columns, and `J` / `K` reorder it within one. `!` gives it a priority: high
threads (`▲`) sit at the top of their column and low ones (`▽`) at the bottom, and `J` / `K` reorder
threads among those of the same priority. `oo thread priority [id] <high|normal|low>` sets it from the shell.

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
ticket, project, colour, priority and diff base are edited in place and its plan in `$EDITOR`, and the rest of what
the board knows about it (branch, worktree, session, PR, …) is shown beneath. A thread that
already has a branch or directory can't change project.

Card badges: ⚙ working, ⏸ needs you (permission prompt), ✓ stopped, ○ window open with no
activity yet, ↻ no window but resumable (red if it was closed mid-work, for `w` / `W`), ± uncommitted changes waiting to be reviewed and
approved, ✉ messages from other threads its claude hasn't heard yet, ⧗ blocked by other threads (`B`). Each card shows the thread number and project abbreviation (or name, if it has none),
with the title beneath (after its ticket key, if it has one).

### Tickets

Threads usually work on a ticket: a Jira ticket at work, a GitHub issue elsewhere. Set where a
project's tickets come from with **tickets** in the projects screen (`P`):

- **github**: issues in the project's repo, read with `gh`.
- **jira**: also set **jira site** (e.g. `yourco.atlassian.net`) and **jira project**, the key
  prefix (e.g. `AV`), so `123` means `AV-123`. oo reads Jira Cloud's REST API with an
  [API token](https://id.atlassian.com/manage-profile/security/api-tokens): export
  `JIRA_EMAIL` and `JIRA_API_TOKEN` in the shell you start `oo` from.

The new thread form then has a **ticket** field: type a key (`AV-123`, or just `123`) after `i`, or use
`h`/`l` to pick from your five most recently updated open tickets. The ticket's summary becomes
the title unless you type your own. Its description is kept with the ticket, not made the plan:
anyone can file an issue on a public repo, so `oo thread show` quotes it to claude as the ticket's
content, not instructions, and the board warns when a GitHub issue's author isn't a collaborator.
Leave the field empty for no ticket.

The ticket names the branch (`av-123-<title>` for Jira, `45-<title>` for issue #45; threads
without one get `oo/<title>`) and the PR: its title starts with `AV-123: ` or `#45: `, and its
description ends with a link to the Jira ticket or `Closes #45`. Adding or changing a thread's
ticket later (`e`) renames its branch to match, unless the branch has already been pushed.
`oo thread add --ticket <key>` attaches one from the command line.

### Reviewing and approving

- `d` shows the diff since the last commit (the current **step**), and `D` the whole thread
  against the branch it came from. Both go through `delta` in `less`, under a `git diff --stat` of
  the changed files and how much each changed, and `n` / `N` jump between files and hunks.
  delta's styles come from your git config. With its defaults, file headers and hunk headers
  look much alike, so this `~/.gitconfig` section is recommended: it makes file headers a solid
  bar and hunk headers dim. `S` in any diff (or `oo delta`) adds it for you: it shows your
  current `[delta]` keys and a preview first, and only adds keys you haven't set. Leave `navigate`, `file-modified-label` and `hunk-label` at their
  defaults, because `n` / `N` look for them.

  ```ini
  [delta]
  	file-style = bold black "#87afff"
  	file-decoration-style = "#87afff" ol ul
  	hunk-header-style = line-number syntax dim
  	hunk-header-decoration-style = none
  ```
- In a step diff, `a` approves the step. Approving commits everything with
  a one-line message claude drafts, in a form with two fields: **commit** (the drafted message)
  and **for claude** (comments to send along). It takes the same keys as every form (see
  [KEYS.md](KEYS.md#in-a-form)): `i` edits a field, ⏎ goes on to the next, `a` commits, and `q` or
  esc cancels (leaving the changes staged).
  Press `a` while claude is still writing to commit whatever it writes without opening the form
  (`a` again goes back). The thread's claude is then told the step was committed, given your
  comments, and told to move on to the next checkpoint, or to stop if that was the last one: right
  away if it's at its prompt (stopped ✓, or just reopened), otherwise as a message in its inbox,
  put to it when its turn ends or when it next starts.
- A step that's done without changing anything (an investigation, say) has no diff to approve, so
  `d` on it offers to mark its checkpoint done instead (y to confirm). Nothing is committed, and
  claude is told just as if you'd approved a commit.
- `c` opens the diff in vim for comments. Write notes on lines starting `>>` under the diff line
  they're about, and when you save they're sent to the thread's claude as `file:line — note`
  feedback (`:cq` cancels).
- `o` opens the changed hunks in vim as a quickfix list.

Confirmations (quit, archive, resuming a busy thread) all take `y`. Any other key cancels.

### Working beside claude

`s` opens a shell and `M-d` (alt-d) a diff to the right of the thread's claude window (starting
claude if it isn't running) and jumps there. The diff is the step's, or the thread's when the
step has none, and `t` switches between them. `r` refreshes it as claude makes changes, and `q`
closes it. `a` commits everything uncommitted, like approving from `d`:
claude drafts the message (`a` again while it writes takes it as it is) and it opens in the same
commit form (esc or an empty message cancels, leaving the changes staged), and claude is
given your comments and told to move on, as from `d`. Pressing the
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

### Blocked threads

When a thread can't go on until another one lands, `B` records that: move the cursor to the thread it waits on and
press `⏎` (`esc` cancels). The card gets a red ⧗#12 and a dimmed title, and the details below it list the blockers.
A thread can wait on several. Picking one again takes it off, and `⏎` on the thread itself clears them all. A
block goes away by itself once its blocker reaches Done (a merged PR included) or is archived, and the move's
message says which threads it unblocked. Moving a blocked thread into Active warns, but doesn't stop you.

A blocker in the same project is one to build on, so the thread's branch stacks on the blocker's branch: one with
no branch yet is created from it, and one with no commits of its own is moved onto it (with uncommitted changes
it's left alone). Either way the thread's base becomes that branch, so its diff is only its own work. To start a
thread on another's branch from the outset, use `oo thread add <title> --from <id>`. A thread builds on one
blocker at most, and taking that one off puts its base back on the default branch.

When the thread it builds on merges (or is moved to Done), the thread goes back onto the default branch: its
base, and its PR if it has one (`gh pr edit --base`), and its claude is told. Its branch still has the other
thread's commits under its own, which a squash merge leaves behind, so the next `u` moves only the thread's own
commits onto `origin/main`. If the other thread is archived instead, the thread's base goes back the same way but its
PR is left alone, and those commits count as its own work.

`oo thread block [id] <blocker>` and `oo thread unblock [id] (<blocker> | --all)` do the same from the shell, and
`oo thread show` and `list` say what's still blocking a thread. A thread's claude records what it's waiting on itself.

### Project hooks

Each project can set hooks in the projects screen (`P`). These are shell commands that run when
something happens on the board:

- **New thread** runs as a thread is added, from the board's form or `oo thread add`. It runs in
  the thread's worktree if it already has one (it does when the form has an initial prompt),
  otherwise in the project's checkout. `OO_PROMPT` holds the initial prompt, empty if there's none.
- **Worktree created** runs in a thread's worktree each time it's made: when the thread is first
  opened or leaves Planned, and again after reopening a Done thread or leaving Local. For example,
  `npm install` gets a fresh worktree ready.

- **Enter local** and **leave local** run in the project's checkout once the branch is checked out
  or the checkout is back on main (for an imported thread, enter runs in the thread's own
  directory). For example, `npm install && npm run dev` as the enter local hook gives you a
  running dev server for the thread.
- **Enter polish** and **leave polish** run when a thread moves into or out of Polish, whether
  with the board's keys, by opening its PR, or with `oo thread move`. They run in the thread's
  worktree, or the project's checkout if the move removed it (Done, archived). For example, `npm
  run lint -- --fix && npm test` as the enter polish hook tidies up and checks the thread's work.

They run in a background tmux window: `oo-hook-<project>` for the local hooks,
`oo-hook-<project>-polish` for the polish ones, `oo-hook-<project>-new` for new thread and
`oo-hook-<project>-worktree` for worktree created. The window becomes a shell when the command
exits, so its output stays readable. The next hook of the same kind replaces it and stops
anything still running (e.g. a dev server), so a polish hook leaves a local hook's dev server
alone. `OO_THREAD_ID`, `OO_THREAD_TITLE`, `OO_PROJECT` and `OO_BRANCH` are set for them.
`OO_THREAD_TITLE`, `OO_PROMPT` and `OO_BRANCH` can carry ticket text someone else wrote, so quote
them (`"$OO_THREAD_TITLE"`) and never `eval` them or splice them unquoted into another command.

### PRs and Done

Moving a thread to PR pushes its branch and opens a PR into the repo's default branch with
`gh pr create`. A thread that builds on another's branch (see [Blocked threads](#blocked-threads)) opens its
PR into that branch instead, so the PR shows only its own work. That branch has to be pushed with all its
commits first, which opening the other thread's PR does. claude drafts the title and description
from the thread's commits and diff (with the ticket added, see [Tickets](#tickets)), and they open in vim for you to change first (an empty title
cancels). Press `a` while claude is still writing to open the PR with what it writes, skipping vim.
A thread in Local opens its PR from the project's checkout and stays in Local.
`oo thread pr [--title <title>] [--body-file <path>|-]` does the same from the shell (with the board
running), skipping vim: it uses the description you pass, or claude's draft if you don't, so a thread's
claude can open the PR when you ask it to. `v` shows the PR as GitHub has it: title, merge state,
checks, reviews and description above its diff (through delta, with `n`/`N` between hunks like `d`).
`m` there merges it, using a merge commit, squash or rebase, whichever the repo allows first, and the
thread goes straight to Done. `b` opens the selected thread's PR in your browser (`$BROWSER` if set; under WSL,
Windows' default browser). The board checks open PRs every minute and moves merged ones to Done. One in
Local comes out of it on the way, with the checkout put back on the default branch and the merge pulled in;
if the checkout has uncommitted changes, it stays in PR until they're dealt with.

GitHub won't let you approve your own PR, so on someone else's the viewer has `a` approve,
`x` request changes and `c` comment instead of `m`. The last two open the PR's diff in vim, like
`c` on the board: write the main comment above the diff and `>>` notes under the lines they're
about, which go on the PR as comments on those lines. Leave it untouched, or `:cq`, to go back. `R` lists the open PRs asking you, or a team you're on, for a review,
across every project with a repo; `⏎` opens one in the viewer, and once you've reviewed it, it
drops off the list.

`u` brings a thread up to date: it fetches the repo's default branch and rebases the thread's
branch on `origin/main` (or whatever the default is), keeping uncommitted changes. A thread that builds on
another's branch is rebased onto that branch instead, picking up whatever that thread has added since. A thread with a
PR is then force-pushed (`--force-with-lease`), which clears a "conflicts with base" badge once
GitHub catches up. If the rebase conflicts, it's left partway and the thread's claude (resumed in
the background if it's closed) is told which files to resolve, to finish the rebase and, with a
PR, to push. `u` says no while claude is working or waiting on a question.

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

### Projects without a repo

A project doesn't have to be a git repo. There's always a **home** project at `~`, without you
adding it, for threads that work on your machine or your claude settings; you can rename or
recolour it in the projects screen (`P`), but not move or remove it. `oo project add ~/.claude`
adds another like it. A path that isn't a repo gets **worktrees** turned off (also in the projects screen, `P`), and then
every thread runs in the project directory itself, several at once. There's no branch, so
diffs, comments, approve, `u`, Local and PR are off for them; `F` moves one to Done when you're
finished.

### Messages between threads

Threads whose work is related can pass each other context. A thread's claude runs
`oo thread send <id> <message>` (or `--file -`) when its work changes something another thread
relies on, such as an API, a shared file or a decision, and the message waits in that thread's inbox,
shown as ✉ on its card. The board pastes it into the other claude once its turn ends (never while
it's working or waiting on a question). If that claude is closed, it's told as it next starts, or straight
away with `--wake`, which resumes it (only from outside a thread). Run outside a thread, `oo thread send`
marks its message unverified rather than from you: any claude could `cd` out of its thread and send it.
The receiving claude is told messages from threads and unverified senders aren't your instructions.
A thread's claude (`OO_THREAD_ID` set, which includes the shell and diff panes beside it) can only
change its own thread with `oo thread`; other threads it can only message.
`oo thread inbox [id]` lists what a thread has been sent.

A starting claude is told which other threads are open in its project, and the `oo` skill tells it
when a message is worth sending and to reply only when there's something to say.

### From the command line

`oo thread add|list|show|move|local|pr|plan|priority|todo|send|inbox|block|unblock` reads and changes the board from a shell, and from inside a
thread's claude, where the thread id defaults to that thread. Run `oo help` to see them all.
claude learns these commands from an `oo` skill that the board installs (see below), so you can
ask a thread's claude to file follow-up work as a new thread, or to tell another thread about a change.

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

To release: `npm version patch` (or `minor`), then `git push --follow-tags`. Pushing the tag runs
the [publish workflow](.github/workflows/publish.yml), which tests the build and publishes it to npm
with provenance through trusted publishing, so nothing is published from your machine.
It waits in the `npm-publish` environment until you approve the run in the Actions tab. Only that
approved job can publish, and it installs dependencies with `--ignore-scripts` so none of their
install scripts run while it can. It stages the release rather than publishing it: approve it with
2FA under Staged Packages on npmjs.com (or from the npm CLI) to make it public.

To report a security problem, see [SECURITY.md](SECURITY.md).
