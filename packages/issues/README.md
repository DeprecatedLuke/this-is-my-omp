# omp-issues

Project-local issue tracker for [omp](https://github.com/can1357/oh-my-pi), packaged as an
omp plugin. Issues are plain markdown under `<cwd>/.omp/issues/`, so the tracker
survives uninstalling the plugin and diffing trivially in review.

This plugin was extracted from omp core: the `issues` tool, the `issues://` URL
scheme, the end-of-turn in-progress reminder, the `§ Filed Issues` subagent
section, and the issue-filing `reviewer` agent all live here now.

## Install

```bash
omp plugin link /path/to/this-is-my-omp/packages/issues
```

The plugin declares one extension entry (`./src/index.ts`) and one agent
definition (`./agents/reviewer.md`). Linking is enough — restart omp, then check
`/plugins` for `omp-issues`.

## Settings

`package.json#omp.settings` declares these; set them with `omp plugin config set`
(or in the runtime config under the `omp-issues` key). Defaults match the core
settings this feature replaced.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Register and honor the `issues` tool at all. |
| `reminders` | `true` | Remind the main agent before it ends a turn while issues are still `in-progress` (never while background jobs are pending). |
| `remindersMax` | `3` | Maximum reminders per prompt; a new prompt restores the allowance. |

## The `issues` tool

Registered as a discoverable extension tool, so the host mounts it as the
`xd://issues` device; an agent opts in with `issues` in its `tools:` list.

| Op | Required | Optional | Effect |
| --- | --- | --- | --- |
| `add` | `category`, `title`, `body` | `severity`, `status`, `location[]`, `extra` | Allocates the next global id, writes `.omp/issues/<category>/<id>-<slug>.md`. |
| `archive` | `id` | `reason`, `status` (default `fixed`) | Moves the file to `.omp/issues/.archive/<category>/`. |
| `unarchive` | `id` | `status` (default `open`) | Restores the file to its category. |
| `list` | — | `category`, `archived`, `severity`, `status`, `query`, `limit` | Markdown listing; `details.listing` feeds the TUI. |

Ids are global across categories and stable across archive cycles. Bodies and
metadata are **edited** by rewriting the issue through its `issues://<id>.md`
URL with the `write` tool: a `title` change re-derives the slug, a `category`
change moves the file, and a terminal `status` (`fixed`/`wontfix`/`duplicate`)
archives it. The rewrite is validated, so a malformed edit is rejected instead
of corrupting the metadata layer.

## `issues://` URLs

Registered on the host's process-global router once per process, and advertised
in the system prompt's internal-URL list.

| URL | Meaning |
| --- | --- |
| `issues://` | Active issues, grouped by category |
| `issues://archive` | Archived issues |
| `issues://?q=<text>` | Keyword filter across title, body, and frontmatter |
| `issues://<id>.md` | One issue, readable **and** writable |

## Rendering

`renderCall` and `renderResult` are driven entirely by `details` from the shared
`@this-is-my-omp/render` kit: op badge and subject on the call row, a framed
card with id, severity/status badges, category, location, and the `issues://` URL
for `add`, `open → fixed` transitions for `archive`/`unarchive`, and a
severity-sorted list (collapsed with `… N more issues`) for `list`. Subagent
`issues add` calls stream into the parent task card through the subprocess tool
registry, so a review's filed issues are visible without extra plumbing.

## Tests

```bash
bun test packages/issues
```
