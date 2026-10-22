# output-orchestrator — plan

A kanban-style TUI (TypeScript + Ink) that organizes Claude Code threads and makes
reviewing their diffs easy. Real `claude` sessions run in tmux windows; the board
manages them. Personal tool for now, WSL2 only.

## Workflow

Columns a thread moves through:

| Column  | Meaning                                                          |
|---------|------------------------------------------------------------------|
| Planned | Idea + plan written. No checkout yet.                            |
| Active  | Being worked by Claude. **One per project** (soft warning).      |
| Polish  | Finishing touches.                                               |
| PR      | PR opened (`gh pr create`).                                      |
| Done    | PR merged. Stays here until archived.                            |
| (Archived) | Hidden.                                                       |

Work happens in **steps**: Claude does a step and stops → I review the diff →
comment / give feedback → when happy, `a` accepts (I commit) → next step.

## Architecture

```
tmux session
├── window "oo-board": the Ink board
├── window "oo-<id>":  claude (one per thread)
└── popups on demand:   delta diffs, vim
```

- Board must run inside tmux (simplest; may relax later).
- Launch: `tmux new-window -n oo-<id> -c <dir> claude`.
- Return to board: `prefix b`, `prefix C-b` or `M-b` (thread windows only), bound by the board at start (`bind b select-window -t oo-board`)
  unless the key is already bound to something else (C-b's default send-prefix is replaced).
- Editors / diffs open in `tmux display-popup -E`, synchronised with `tmux wait-for`.
- Send text into a session: `tmux load-buffer` + `paste-buffer -p` (bracketed paste) + Enter.
- Status (M2): Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `PostToolUse`,
  `Notification`, `Stop`, `SessionEnd`) passed per launch via `claude --settings
  <data>/claude-settings.json` (rewritten at board start). The thread ID reaches the
  hook as `OO_THREAD_ID` (`tmux new-window -e`); `src/hook.ts` appends a line per
  event to `<data>/events.jsonl`, which the board tails. `SessionStart` gives the
  session ID + transcript path, stored on the thread for `claude --resume`.
- Isolation (M3): one git worktree + branch per thread, created on leaving
  Planned (or on first open), at `~/.local/share/output-orchestrator/worktrees/<project>/<id>`,
  on branch `oo/<id>-<title-slug>` from the repo's current branch (recorded as the thread's
  base). claude runs in the worktree, so `--resume` finds its sessions. Removed on
  Done/archive (branch kept; its claude window is closed) unless it has uncommitted changes;
  archiving refuses until they're committed or discarded.
- PRs (M5): moving a card to PR pushes its branch and runs `gh pr create --head <branch>
  --base <base>`, title/body drafted by `claude -p` from the commits and diff, then edited in vim (falls
  back to the thread's title/plan). The PR is
  recorded on the thread; if one already exists it's just pushed again. Uncommitted changes
  block the move. The board polls `gh pr view` every minute and moves merged PRs to Done.
- Import (#7): `i` lists the selected project's recent sessions from
  `~/.claude/projects/<path with non-alphanumerics as ->/<session>.jsonl` (title, first prompt, last
  activity, linked thread). Picking one makes a Planned thread with its session ID, transcript and
  `cwd`; such threads skip worktrees and resume in that `cwd` (they have no branch, so no PR).
  Resuming a session the board hasn't seen this run whose transcript changed in the last 2 minutes
  needs a second ⏎, since it's probably still open elsewhere.
- State: JSON at `~/.local/share/output-orchestrator/state.json`, validated with zod.
- Projects are added by hand: `oo project add <path> [name]`.

## Review (M3/M4)

- `d` — step diff: `git diff HEAD | delta` in a popup.
- `D` — thread diff: `git diff --merge-base <base>` (`<base>...` incl. working tree).
  Both diffs mark new files intent-to-add (`git add -N`) so they show up.
- `c` — comment: the diff (the step's, else the thread's) opens in vim; lines starting `>>`
  under a diff line become `file:line — note` (consecutive `>>` lines join into one note;
  under a file header they're about the file, before any file they're general), batched and
  pasted into the thread's Claude session on save. `:cq` cancels. Needs the claude window open.
- `a` — accept step: `git add -A` + `git commit -v` in a popup (message in git's editor).
- `o` — vim with a quickfix list of the changed hunks (the step's, else the thread's).

## Keys (board)

| Key       | Action                              |
|-----------|-------------------------------------|
| h/l, j/k  | move cursor between columns / cards |
| H/L       | move card to prev/next column       |
| J/K       | reorder card within column          |
| n         | new thread (pick project, type title) |
| e         | thread screen: edit fields, see info |
| Enter     | open / jump to thread's claude      |
| d / D     | step / thread diff (delta popup)    |
| c         | comment on the diff → Claude        |
| a         | accept step (commit)                |
| o         | open changed hunks in vim           |
| i         | import a claude session not started by the board |
| C         | cycle card colour                   |
| p         | cycle project filter                |
| x         | archive                             |
| q         | quit                                |

## Milestones

- **M1** — Board: projects, threads, columns, move/reorder, colours, persisted
  state, launch/jump to a `claude` tmux window, vim for new/edit.
- **M2** — Hook-driven status badges (⚙ working, ⏸ needs you, ✓ stopped), resume after restart.
- **M3** — Worktree per thread, delta diff popups, `a` accept = commit.
- **M4** — Vim comments → feedback pasted into Claude.
- **M5** — `gh pr create`, auto-move to Done on merge, archive cleanup. ← current

## Prerequisites

tmux ≥ 3.3 (popups with titles), git, gh, vim, claude, delta (`sudo apt install git-delta`
or a release .deb). Keep repos on the Linux filesystem, not `/mnt/c`.
