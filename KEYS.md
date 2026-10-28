# Keys

Press `?` on the board for this list (it comes from `src/keys.ts`, so keep the two in step).

## Board

| Key | |
|---|---|
| `h`/`l` `j`/`k` | move (arrows too) |
| `H`/`L` | move the thread a column (`H` brings an archived one back to Done) |
| `J`/`K` | reorder within its column |
| `⏎` | open (or resume) its claude |
| `w` / `W` | wake it / every thread closed mid-work ("keep going") |
| `u` | rebase on origin/main, or the branch it builds on (pushes a PR; conflicts go to claude) |
| `n` | new thread (the form below) |
| `e` | edit the thread |
| `t` | into / out of Local (`oo thread local` from the shell) |
| `B` | blocked by another thread: move to it and `⏎` (again unpicks it, `⏎` on the thread itself clears them all, `esc` cancels; `oo thread block` from the shell) |
| `F` | straight to Done |
| `x` | archive |
| `C` | cycle its colour |
| `p` | filter by project |
| `/` | search the id, title, plan, ticket, branch and PR as you type; `⏎` keeps it, `esc` drops it |
| `esc` | clear the search, then the project filter |
| `A` | show / hide an ARCHIVED column after Done (archived cards take only `H`, `e`, `b`, `J`/`K` and `C`) |
| `i` | import a thread started outside oo |
| `P` | projects (their hooks and wake prompt) |
| `?` | all keys |
| `q` | quit, leaving thread windows open |
| `Q` | quit and close every thread window (claude resumes next time) |

The mouse works too: click a card to select it, double-click to open it, scroll to move.

## Reviewing

| Key | |
|---|---|
| `d` / `D` | step / whole thread diff (`d` with no changes: mark the step done) |
| `s` / `M-d` | claude with a shell / live diff beside it |
| `c` | comment on the diff in vim |
| `o` | changed hunks as a vim quickfix list |
| `v` | view the PR: description, checks, reviews and its diff (`m` merges it) |
| `R` | PRs waiting for your review, across projects (`⏎` views one) |
| `b` | open the PR in your browser |

## In a diff

| Key | |
|---|---|
| `n`/`N` | next / previous file or hunk |
| `a` | in `d`: approve the step. Beside claude: commit everything uncommitted (claude drafts the message, you edit it and add comments for claude in the commit form; esc cancels). `a` again while claude writes takes its message as it is |
| `t` | beside claude: switch between the uncommitted and whole-thread diffs |
| `r` | beside claude: refresh |
| `m` | in `v`, your PR: merge it (with a confirm that says what's in the way, if anything) |
| `a` / `x` / `c` | in `v`, someone else's PR: approve (with a confirm) / request changes / comment (in vim on the diff: the main comment above it, `>>` notes become line comments) |
| `o` | in `v`: open the PR in your browser |
| `S` | set up delta's header styles (`oo delta` from the shell), then back to the diff |
| `q` | close |
| `>> note` | in `c`, or `x`/`c` in `v`: a comment on the diff line above it |
| `:cq` | in `c`: send nothing (in `v`: back to the PR) |

## In a form

The new thread (`n`), thread (`e`), project (`P`) and commit forms. Text fields are only typed into
once you start editing one, vim-style, so letters are keys until then.

| Key | |
|---|---|
| `j`/`k` `↑`/`↓` `tab` | move between fields (`shift-tab` back too) |
| `h`/`l` `←`/`→` | on a choice field: change it (project, colour, …). On the new thread's ticket: pick one of your recent tickets |
| `i` / `I` | edit a text field, cursor at the end / at the start |
| `dd` | clear it and edit |
| `⏎` | on a text field: edit it. While editing, or on a choice: save the field and go on to editing the next one (on the last field, just stop editing). On the thread's plan: open `$EDITOR` |
| `a` / `shift-⏎` | submit: create the thread (starting its claude on the initial prompt if there is one), save, or commit. `a` only while not editing; `shift-⏎` only where the terminal sends it apart from `⏎` |
| `q` / `esc` | cancel the form. While editing, `esc` stops editing, keeping the text, and `q` is just typed |
| `←`/`→` `ctrl-a`/`ctrl-e` | while editing: move the cursor / to the start or end |
| `ctrl-u` / `ctrl-w` | while editing: delete back to the start / back over a word |

## In a thread's window

tmux keys with no prefix. They only apply in thread windows, so elsewhere the key still
reaches the program, and a key you've bound yourself is left alone.

| Key | |
|---|---|
| `M-h` / `M-l` | claude / the pane beside it |
| `M-j` / `M-k` | next / previous thread window |
| `M-s` / `M-d` | shell / live diff beside claude (like `s` / `M-d` on the board) |
| `M-u` | scroll up: tmux copy mode, with your `mode-keys` (`q` leaves) |
| `M-z` | zoom the pane |
| `M-q` / `M-b` | back to the board |
| `prefix b` | back to the board, from anywhere |

`M-v` (claude's image paste) and `M-[` (the start of arrow keys' escape codes) are left alone.

## Claude

`/vim` in claude turns on vim editing in its prompt (`esc` for normal mode, `i` back to
insert). It's a global claude setting, also under Editor mode in `/config`, so oo doesn't set it.
