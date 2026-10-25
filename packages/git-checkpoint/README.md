# omp-git-checkpoint

omp plugin: two-stage local WIP checkpoint commits across every git repo in the workspace.

`git_checkpoint` lists the repos with uncommitted changes, then commits only the repos the caller names — each with a model-generated message. Nothing leaves the machine: no push, no rebase, no amend.

## Surfaces

| Surface                   | Usage                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| `git_checkpoint` tool     | Discoverable tool, so also mounted as `xd://git_checkpoint`.           |
| `/git-checkpoint [repo…]` | Operator path: commit every dirty repo, or just the named ones.         |
| System prompt             | Main agent only: when and how to checkpoint (see `prompts/system.md`).  |

`omp git checkpoint` no longer exists; this plugin replaces it.

### Two stages

1. **List** — omit `repos` (or pass `[]`). Nothing is committed; the reply names each dirty repo with its changed-file count.
2. **Commit** — pass `repos: ["<name>", …]` with names copied verbatim from the listing (a path resolving to a repo root also works). One unknown name aborts the whole call and commits nothing.

Committing a repo stages **all** of its dirty files, including edits an earlier session left uncommitted; that is by design and the tool never stashes or reverts them.

Repos are enumerated from the nearest enclosing git repo plus the unlinked nested repos beneath it. Nested repos are excluded from a parent's status and staging, so a dirty child never marks its parent dirty and is never committed as an embedded gitlink.

## Install

```sh
bun install
omp plugin link packages/git-checkpoint
```

## Layout

| Path                      | Contents                                                             |
| ------------------------- | -------------------------------------------------------------------- |
| `src/checkpoint.ts`       | Repo enumeration, selection, per-repo commit, text formatting.        |
| `src/tool.ts`             | `git_checkpoint` tool definition and the two-stage flow.              |
| `src/command.ts`          | `/git-checkpoint` handler.                                            |
| `src/render.ts`           | Call/result rendering on `@this-is-my-omp/render`.                    |
| `src/index.ts`            | Plugin entry: tool, command, system-prompt section.                   |
| `prompts/git-checkpoint.md` | Model-facing tool description.                                      |
| `prompts/system.md`       | Checkpoint policy appended to the main agent's system prompt.         |
| `test/`                   | Contract tests against real temp git repos, plus rendering tests.     |

## Rendering

`renderCall` shows the stage badge (`list` / `commit`) and the repos named. `renderResult` renders a framed card:

- **list** — one row per dirty repo with its changed-file count; expanded rows name the files.
- **commit** — one row per repo with status badge, short sha, changed-file count, and commit subject (full message when expanded); failures show their error in the error color, and the card footer counts commits, skips, and failures.
- **unmatched** — error card naming the unknown repos plus the repos that could have been named.

## Development

```sh
bun run check                 # tsgo over the workspace
bun test packages/git-checkpoint
```
