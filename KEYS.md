# Keys

Press `?` on the board for this list (it comes from `src/keys.ts`, so keep the two in step).

## Board

| Key | |
|---|---|
| `h`/`l` `j`/`k` | move (arrows too) |
| `H`/`L` | move the thread a column |
| `J`/`K` | reorder within its column |
| `⏎` | open (or resume) its claude |
| `w` / `W` | wake it / every thread closed mid-work ("keep going") |
| `n` | new thread |
| `e` | edit the thread |
| `t` | into / out of Local (`oo thread local` from the shell) |
| `F` | straight to Done |
| `x` | archive |
| `C` | cycle its colour |
| `p` / `esc` | filter by project / clear it |
| `i` | import a thread started outside oo |
| `P` | projects (their hooks and wake prompt) |
| `?` | all keys |
| `q` | quit |

The mouse works too: click a card to select it, double-click to open it, scroll to move.

## Reviewing

| Key | |
|---|---|
| `d` / `D` | step / whole thread diff |
| `s` / `M-d` | claude with a shell / live diff beside it |
| `c` | comment on the diff in vim |
| `o` | changed hunks as a vim quickfix list |
| `b` | open the PR in your browser |

## In a diff

| Key | |
|---|---|
| `n`/`N` | next / previous file or hunk |
| `a` | in `d`: approve the step. Beside claude: commit everything uncommitted (claude drafts the message, you edit it and add comments for claude in the commit form; esc cancels) |
| `t` | beside claude: switch between the uncommitted and whole-thread diffs |
| `r` | beside claude: refresh |
| `q` | close |
| `>> note` | in `c`: a comment on the diff line above it |
| `:cq` | in `c`: send nothing |

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
