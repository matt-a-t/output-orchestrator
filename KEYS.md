# Keys

Press `?` on the board for this list. The thread keys on it come from their bindings in `src/board/*.ts`
(`help` on each), the rest from `src/keys.ts`; `src/keys.test.ts` checks the Board and Reviewing
tables here list every bound key, so keep the two in step.

## Board

| Key | |
|---|---|
| `h`/`l` `j`/`k` | move (arrows too) |
| `H`/`L` | move the thread a column (`H` on a Planned one shelves it in IDEAS, `L` brings it back; `H` brings an archived one back to Done) |
| `J`/`K` | reorder within its column, among the threads of its priority |
| `⏎` | open (or resume) its claude |
| `w` / `W` | wake it / every thread closed mid-work ("keep going") |
| `u` | rebase on origin/main, or the branch it builds on (pushes a PR; conflicts go to claude) |
| `n` | new thread (the form below) |
| `N` | import a thread started outside oo |
| `e` | edit the thread |
| `t` | every todo on the thread, when there are more than the details box shows (`j`/`k` or the wheel scroll, `g`/`G` top / bottom) |
| `o` | into / out of Local (`oo thread local` from the shell) |
| `B` | blocked by another thread: move to it and `⏎` (again unpicks it, `⏎` on the thread itself clears them all, `esc` cancels; `oo thread block` from the shell) |
| `F` | straight to Done |
| `x` | archive (an IDEAS one too) |
| `!` | cycle its priority: normal → high (`▲`, top of its column) → low (`▽`, bottom); `oo thread priority` from the shell |
| `p` | filter by project |
| `/` | search the id, title, plan, ticket, branch and PR as you type; `⏎` keeps it, `esc` drops it |
| `esc` | clear the search, then the project filter |
| `I` | show / hide an IDEAS column before Planned (its cards take only `L`, `x`, `e`, `b`, `J`/`K` and `!`) |
| `A` | show / hide an ARCHIVED column after Done (archived cards take only `H`, `e`, `b`, `J`/`K` and `!`) |
| `r` | run one of the project's commands (dev server, tests, migrations…) in a new terminal window (see below) |
| `P` | projects (their hooks, commands, wake prompt and when idle claudes close) |
| `?` | all keys |
| `q` | quit, leaving thread windows open |
| `Q` | quit, closing every thread window (claude resumes next time) and stopping every run (`r`) |

The mouse works too: click a card to select it, double-click to open it, scroll to move.

## Running commands

`r` lists the commands set for the highlighted thread's project in the projects screen (`P`),
with how each is going for that thread. They run in its worktree (the project checkout in Local,
or for a thread with no worktree yet).

| Key | |
|---|---|
| `j`/`k` `↑`/`↓` | move |
| `⏎` / `1`–`9` | run it in a new terminal window, or again if it's finished; on one that's running, open another window on it |
| `R` | restart it; windows already on it stay open and see it start over |
| `X` | stop it, closing its windows |
| `esc` / `q` / `r` | close |

## Reviewing

| Key | |
|---|---|
| `d` / `D` | step / whole thread diff (`d` with no changes: mark the step done) |
| `s` | claude with a shell beside it |
| `c` | comment on the diff in vim |
| `v` | view the PR: description, checks, reviews and its diff (`m` merges it) |
| `R` | PRs waiting for your review, across projects (`j`/`k` move, `⏎` or `v` views one, `b` opens it in your browser, `r` refreshes, `R`/`q`/`esc` close) |
| `b` | open the PR in your browser |

## In a diff

`d`, `D` and `v` open the diff viewer: tab 1 is claude's last response (in `v`, the PR's
description, checks and reviews), tab 2 the changed files, tab 3 the diff a file at a time.

| Key | |
|---|---|
| `h`/`l` `←`/`→` `1` `2` `3` | change tab |
| `j`/`k` `↑`/`↓` | scroll (in the files tab: move between files) |
| `ctrl-d`/`ctrl-u` `ctrl-f`/`ctrl-b` `space` | half / whole page down / up (PageDown / PageUp too) |
| `g` / `G` | top / bottom (first / last file; Home / End too) |
| `⏎` | in the files tab: open that file's diff |
| `]`/`[` `J`/`K` | next / previous file |
| `n`/`N` `}`/`{` | next / previous hunk, on into the next / previous file |
| `+`/`-` | more / less context (`=` works as `+`) around the changes: 3, 10, 25 lines, then the whole file (in `v`, fetches the PR first) |
| `/` | search every file (case-insensitive). `n`/`N` then go to the next / previous match until `esc` ends the search |
| `a` | in `d`: approve the step |
| `m` | in `v`, your PR: merge it (with a confirm that says what's in the way, if anything) |
| `a` / `x` / `c` | in `v`, someone else's PR: approve (with a confirm) / request changes / comment (in vim on the diff: the main comment above it, `>>` notes become line comments) |
| `b` | in `v`: open the PR in your browser |
| `S` | set up delta's header styles (`oo delta` from the shell), then back to where you were |
| `q` / `esc` | close (`esc` ends a search first). `d`, `D` or `v`, the key that opened it, closes it too |
| `>> note` | in `c`, or `x`/`c` in `v`: a comment on the diff line above it |
| `:cq` | in `c`: send nothing (in `v`: back to the PR) |

The mouse wheel scrolls too.

## In a form

The new thread (`n`), thread (`e`), project (`P`) and commit forms. Text fields are only typed into
once you start editing one, vim-style, so letters are keys until then.

| Key | |
|---|---|
| `j`/`k` `↑`/`↓` `tab` | move between fields (`shift-tab` back too) |
| `h`/`l` `←`/`→` `space` | on a choice field: change it (project, colour, priority, …; `space` goes forward). On the new thread's ticket: pick one of your recent tickets |
| `i` / `I` | edit a text field, cursor at the end / at the start |
| `dd` | clear it and edit |
| `⏎` | on a text field: edit it. While editing, or on a choice: save the field and go on to editing the next one (on the last field, just stop editing). On the thread's plan: open `$EDITOR` |
| `a` / `shift-⏎` | submit: create the thread (starting its claude on the initial prompt if there is one), save, or commit. `a` only while not editing; `shift-⏎` from any field, editing or not, where the terminal sends it apart from `⏎` (inside tmux it usually doesn't without extended-keys, so use `a`) |
| `q` / `esc` | cancel the form. While editing, `esc` stops editing, keeping the text, and `q` is just typed |
| `←`/`→` `ctrl-a`/`ctrl-e` | while editing: move the cursor / to the start or end |
| `ctrl-u` / `ctrl-w` | while editing: delete back to the start / back over a word |

## On the projects screen

`P` on the board. Editing a project opens the form above.

| Key | |
|---|---|
| `j`/`k` `↑`/`↓` | move |
| `e` / `⏎` | edit the project |
| `n` | add a project |
| `x` | remove it (`y` to confirm) |
| `q` / `esc` / `P` | back to the board |

## In a thread's window

tmux keys with no prefix. They only apply in thread windows, so elsewhere the key still
reaches the program, and a key you've bound yourself is left alone.

| Key | |
|---|---|
| `M-h` / `M-l` | claude / the pane beside it |
| `M-j` / `M-k` | next / previous thread window |
| `M-s` | shell beside claude (like `s` on the board) |
| `M-u` | scroll up: tmux copy mode, with your `mode-keys` (`q` leaves) |
| `M-z` | zoom the pane |
| `M-q` | back to the board |
| `prefix b` | back to the board, from anywhere (a run's session too) |

`M-v` (claude's image paste), `M-b` (back a word in claude's prompt and the shell) and `M-[` (the start of
arrow keys' escape codes) are left alone.

## Claude

`/vim` in claude turns on vim editing in its prompt (`esc` for normal mode, `i` back to
insert). It's a global claude setting, also under Editor mode in `/config`, so oo doesn't set it.
