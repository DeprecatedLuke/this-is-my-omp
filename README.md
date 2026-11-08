# this-is-my-omp

Personal [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) plugins, kept out of the omp core.

| Package | Plugin | What it adds |
|---|---|---|
| `packages/issues` | `omp-issues` | Project-local issue tracker: `issues` tool, `issues://` URLs, in-progress reminders, issue-filing reviewer agent |
| `packages/issues-board` | — | Terminal issue list for the tracker (`omp-board`) |
| `packages/knowledge` | `omp-knowledge` | Project knowledge base: `knowledge://` notes, `# Knowledge` prompt index, `/knowledge save\|build\|update\|compact`, a passive knowledge hint |
| `packages/git-checkpoint` | `omp-git-checkpoint` | Two-stage local WIP checkpoints: `git_checkpoint` tool and `/git-checkpoint` |
| `packages/agents` | `omp-agents` | `solver`, `research`, and `tester` subagents |
| `packages/render` | — | Shared TUI rendering kit used by the plugins above |

## Install

```sh
bun install
omp plugin link "$PWD/packages/issues"
omp plugin link "$PWD/packages/knowledge"
omp plugin link "$PWD/packages/git-checkpoint"
omp plugin link "$PWD/packages/agents"
```

Plugins load from source; there is no build step. Each package README documents its settings (`omp plugin config`).

## Development

The plugins import omp's own modules (`@oh-my-pi/*`). For typechecking and tests, point `.omp-host` at an omp checkout:

```sh
scripts/link-host.sh /path/to/oh-my-pi   # or OMP_HOST=/path/to/oh-my-pi bun run link-host
bun run check   # tsgo over every package
bun run lint    # biome
bun test packages
```
