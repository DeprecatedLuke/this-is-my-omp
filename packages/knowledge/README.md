# omp-knowledge

omp plugin: a project knowledge base under `.omp/knowledge`, addressed through `knowledge://`, indexed in the system prompt, nudged at turn end, and maintained by `/knowledge`.

Extracted from the omp core, where the note store, `knowledge://` scheme, prompt index, passes, background distiller, and `omp build-knowledge` lived. `/knowledge build --sessions` replaces the dropped CLI command; the background distiller became a passive knowledge hint.

## Install

```sh
omp plugin link "$PWD/packages/knowledge"   # from the repo root
```

The plugin registers the `knowledge://` scheme once per process, appends the `# Knowledge` section to every session's prompt, registers `/knowledge`, and reminds the agent at turn end.

## Notes

Root: `<cwd>/.omp/knowledge`. One file per subject:

```
.omp/knowledge/<category>/<topic>.md
---
description: retrieval tags, comma separated
---

# Title

- durable fact …
```

`description` is the only frontmatter field the plugin maintains. `loadKnowledgeSummaries` derives tag-style descriptions from a note's body when they are missing or sentence-shaped, and writes the normalized frontmatter back while building the prompt index — the index is only useful when it lists the tags a future agent would search for. Reads without a selector start after the frontmatter; `:1` or `:raw` show it.

## `knowledge://`

| URL | Result |
| --- | --- |
| `knowledge://` | listing of every note with its description |
| `knowledge://<category>` | listing of one category |
| `knowledge://<category>/<topic>.md` | the note: `read`, `write`, and in-place `edit` |

`write` normalizes frontmatter and rejects empty content; `edit`/`ast_edit` patch the located note in place; a symlink that leaves the knowledge root is rejected. The scheme is also advertised in the `# Internal URLs` prompt list.

## Commands

```
/knowledge save                     distill this session into notes, then commit them
/knowledge build [focus]            explore the repo in an isolated worktree and author notes
/knowledge update [focus]           verify every note against the repo and fix what is stale
/knowledge compact [goal]           prune duplicates and outdated notes, or pursue a goal
/knowledge build --sessions [--last 30d] [--force] [--model <role|provider/model>]
```

- `save` seeds a headless agent with the session's converted messages and the live system prompt, grants `read`/`write`/`edit`/`grep`/`glob`, and commits only `.omp/knowledge` (`chore(knowledge): update .omp/knowledge`).
- `build`/`update`/`compact` run in an isolated worktree through the host's native-patch machinery, so their edits arrive as a reviewable `patch://` capture that auto-applies to a clean repo and stays pending on a dirty one.
- `build --sessions` is the old `omp build-knowledge` exporter: it walks saved sessions inside the `--last` window (`30d`, `72h`, `2w`, `all`), skips sessions its state file (`<sessions dir>/knowledge-exports.json`) already covered unless `--force`, and distills each into the notes.
- `--model` overrides the model for any subcommand; without it, `save` uses the current session model, and `build --sessions` tries the `task`, `smol`, `default`, then `slow` roles.

Passes run as headless `Agent` loops (the extension API cannot spawn a task subprocess, and `ctx.runEphemeralTurn` cannot call tools). A pass never enters the conversation: its completion arrives as a `knowledge-pass` transcript card that the plugin strips from provider requests, so only the operator sees it, plus `/knowledge` notifications and a footer status line while it runs.

## Knowledge hint

The plugin never distills by itself. When a main-agent turn fully settles (`agent_end` with no continuation, no subagent, no pending background work, no `/knowledge` pass in flight), it totals the non-cached provider work (`input + output + cacheWrite`; cache reads and `totalTokens` excluded) since its last watermark. Once that reaches the threshold, it appends a `knowledge-auto-update` entry holding `{ throughEntryId }` at the latest message and queues a hidden `knowledge-reminder` system reminder with `deliverAs: "nextTurn"`: it rides along with the next prompt and never forces a turn of its own, so it cannot collide with other plugins' `session_stop` continuations.

- The watermark advances when the hint is queued, so a given stretch of work is offered once; another threshold's worth of work re-arms it.
- The entry id is the pre-reminder watermark, so sessions carried over from the background distiller do not re-fire for work it already covered.
- The threshold only controls when the agent is nudged; whether anything is written — via `knowledge://<category>/<topic>.md` or `/knowledge save` — stays the agent's decision.

## Settings

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `reminderThresholdTokens` | number | `100000` | Non-cached provider tokens between knowledge hints; `0` disables them |

Set plugin settings with `omp plugin config` (global or project scope); the reader returns only configured values, so every default lives in `src/settings.ts`.

## Layout

| File | Role |
| --- | --- |
| `src/index.ts` | extension entry: scheme install, prompt section, `/knowledge`, reminder wiring, card publication |
| `src/runner.ts` | pass orchestration (`save`, `update`, `compact`, `build`) |
| `src/agent-pass.ts` | headless agent loop that edits notes and commits |
| `src/passes.ts` | isolated native-patch pass |
| `src/reminder.ts` | watermark source collection, reminder decision and text |
| `src/exporter.ts` | `--sessions` backfill (state file, `--last` window)` |
| `src/protocol.ts` | `knowledge://` handler |
| `src/knowledge-index.ts` | note paths, descriptions, summaries, fingerprint |
| `src/prompt.ts` | `# Knowledge` section |
| `src/render.ts` | `knowledge-pass` card |
| `src/command-args.ts` | `/knowledge` grammar and completions |
| `src/commit.ts` | commits only the knowledge subtree |
| `agents/knowledge.md` | bundled `knowledge` subagent for the task tool |

## Development

```sh
cd this-is-my-omp
bun run check              # tsgo over every package
bun test packages/knowledge
bun x biome check packages/knowledge
```
