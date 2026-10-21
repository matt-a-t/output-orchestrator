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

## Use

```bash
oo project add ~/code/my-repo [name]
tmux new -A -s oo oo
```

Keys are listed at the bottom of the board. `n` / `e` open `$EDITOR` (default vim)
in a tmux popup; Enter opens or jumps to the thread's `claude` window.

State lives in `~/.local/share/output-orchestrator/state.json`.
