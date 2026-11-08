# omp-issues

Project-local issue tracker for [omp](https://github.com/can1357/oh-my-pi), packaged as an
omp plugin. Issues are plain markdown under `<cwd>/.omp/issues/`, so the tracker
survives uninstalling the plugin and diffing trivially in review.

This plugin was extracted from omp core: the `issues` tool, the `issues://` URL
scheme, the end-of-turn in-progress reminder, the `§ Filed Issues` subagent
section, the `§ Issue Board` main-agent section, and the issue-filing `reviewer`
agent all live here now.

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
| `add` | `category`, `title`, `body` | `severity`, `status`, `report`, `location[]`, `extra` | Allocates the next global id, writes `.omp/issues/<category>/<id>-<slug>.md`. |
| `archive` | `id` | `reason`, `status` (default `fixed`) | Moves the file to `.omp/issues/.archive/<category>/`. |
| `unarchive` | `id` | `status` (default `open`) | Restores the file to its category. |
| `stage` | `id`, `stage` | — | Sets the issue's board column (`needs-you`, `up-next`, `running`, `awaiting-deploy`, `deferred`) or clears it with `none`; no read and no rewrite. |
| `list` | — | `category`, `archived`, `severity`, `status`, `stage`, `query`, `limit` | Markdown listing; `details.listing` feeds the TUI. |

Ids are global across categories and stable across archive cycles. Bodies and
metadata are **edited** by rewriting the issue through its `issues://<id>.md`
URL with the `write` tool: a `title` change re-derives the slug, a `category`
change moves the file, and a terminal `status` (`fixed`/`wontfix`/`duplicate`)
archives it. The rewrite is validated, so a malformed edit is rejected instead
of corrupting the metadata layer.

### `stage`

An optional `stage` key gives an active issue its state on the `omp-board`
list. Set it with the `stage` op — `{"op":"stage","id":12,"stage":"running"}`,
`{"op":"stage","id":12,"stage":"none"}` to clear it — or by rewriting the issue
through `issues://<id>.md` (or via `add`'s `extra`); a value outside the set is
rejected like an out-of-enum `status`/`severity`.

| Stage | Meaning |
| --- | --- |
| `needs-you` | Blocked on a human decision or action. |
| `up-next` | The user wants it started next. |
| `running` | Work in flight across sessions; prefer it over `in-progress` for long-running work. |
| `awaiting-deploy` | Fixed in code, not deployed. |
| `deferred` | Parked on purpose. |

Omit it for plain open work. Moving an issue to Done clears the key, and an
archived issue never shows a stage.

The plugin sets `running` itself when it hands a held issue back to its session —
a requeued issue at turn end, a reply at prompt time — so the board shows Running
the moment the work resumes, and the agent only has to hand it back (`needs-you`)
or archive it. A hand-off writes only when the issue is active and not already
`running`, so a later turn end leaves the file untouched.

### `report`

An optional `report` key attaches the write-up an issue came from: either a
`report://<project>/<slug>` handle or an absolute `http(s)://` URL. Set it with
`add`'s `report` param or by rewriting `issues://<id>.md`; anything else (`ftp://x`,
`report://nope`) is rejected like an out-of-enum `status`/`severity`. Every other
lifecycle path — board moves, archive, unarchive, metadata edits — preserves it.

While `enabled`, the main agent gets a static `§ Issue Board` system-prompt
section (`src/prompts/board.md`): file an issue for work that outlives the turn,
needs the user or waits on a deploy, set `stage: running` with the `stage` op
before starting anything, use `running` rather than `in-progress` for unfinished
work, and cite issues as `issues://<id>`. The in-progress reminder points the
same way: an issue not finished this turn goes back to `open` with `stage:
running` or `needs-you`. It only covers issues this session holds, so no session
is told to finish another session's work.

### An issue follows the session you gave it to

No session takes an issue on its own. An issue becomes a session's work when the
user asks that session to work on it: the agent sets `stage: running` with the
`stage` op, which claims the issue (`claims/<id>`, holding the session id). From
then on the issue follows that session — the user's board replies and requeues
for it are delivered to that session and to no other, at its next prompt or at
turn end while it is working. A queued, `up-next` or replied-to issue that no
session holds is delivered to nobody: the board shows the reply waiting, and
nothing is claimed on a session's behalf.

- **The heartbeat** is `sessions/<sessionId>`, an empty file whose mtime is
  refreshed every 30 s while the session lives. A session is live while its
  heartbeat is younger than `PRESENCE_STALE_MS` (120 s).
- **Stale takeover.** A claim naming a session that is no longer live is stale:
  the next claimer renames it to a dot-name (only one rename can win), checks it
  still names the dead session, and links its own onto the name. A crashed
  session therefore costs that issue at most two minutes, not a restart — and a
  prompted session takes the issue over. A claim whose session never registered a
  heartbeat is respected while the claim itself is younger than the window, so a
  session that writes its presence and its claim in that order cannot lose the
  claim in between.
- **`stage: running`** claims the issue for the calling session when it is free or
  stale. If another live session holds it, the stage is still set and the result
  appends `#<id> is held by another live session (<id>); two sessions on one issue
  will conflict, so tell the user.`
- **Releasing.** Archiving an issue — the `archive` op, a `stage` move onto a
  terminal status, or the board's Done — frees its claim, because the work is
  over. `session_shutdown` drops the session's presence and claims, so the next
  prompted session can take its issues immediately.

### Replies

A reply typed on the board is parked in the **local inbox**, never in the
git-tracked issue:

```
~/.omp/agent/issues-inbox/<checkout-slug>-<sha256(root)[:12]>/
  replies/<id>/<epochMs>-<rand>.txt   one pending reply per file
  queued/<id>                         empty: the user queued this issue here
  claims/<id>                         the omp session id that works this issue
  sessions/<sessionId>                empty; mtime is the session's heartbeat
  seen/<id>, seen/.watermark          what the user already looked at
```

Pending replies, queue marks and claims are per machine and per checkout, and are
never committed — so a commit cannot ship a session id or a half-delivered reply,
and a cloned repo's text cannot drive an agent. The git side only records that the
user wants the issue worked: the issue moves to Up next — or keeps its stage when
it is already `running`, and an archived issue reopens as `open` + `up-next`.

Nothing wakes an idle session, so delivery happens at the next prompt of the
session holding the issue, or at its turn end while it is working. A reply to an
issue no session holds stays pending — the board says so — until the user prompts
a session to take that issue. The claim is what routes it (`claim` is an exclusive
`link`, so exactly one session holds an issue), and each reply is taken with an
atomic `rename` — a reply another session took already yields nothing. The plugin
adds an `<system-reminder>` custom message (`src/prompts/replies.md`, custom type
`omp-issues/replies`) listing the taken texts with their `issues://<id>` and title,
then appends each one to the issue body under `## Replies` as
`### User reply · <time>`. That history is the only trace a reply leaves in git.

### The turn-end queue

At the end of a main-agent turn, issues **this session holds** that have pending
replies or a local queue mark are the queue. If anything is queued the plugin
returns `{ continue: true, additionalContext }` with a reminder
(`src/prompts/queue.md`) instead of letting the turn settle silently, and the agent
works the issues and keeps their stages truthful: `running` while in flight,
archived when done, and `needs-you` when it needs the user back — that is the
loop-breaker.

A committed `stage: up-next` alone does not queue anything: only the local queue
mark counts, so a cloned repo's stage cannot drive the user's agents. A mark
survives while its issue is active and either `up-next` or `running` — the
hand-off marks it `running`, so the work stays in flight — and is pruned once the
agent moves it to `needs-you`, `awaiting-deploy`, `deferred`, or no stage at all,
archives it, or the issue is gone. The hand-off writes `running` once; after that
the stage is already `running`, so later turn ends write nothing.

Only a held issue is queued: an issue no session holds, or one whose claiming
session is gone, is in no session's queue until a session is prompted to take it.
A board move keeps the claim (only moving to Done frees it), so a requeue or a
reply goes back to the session that holds the issue, and `session_shutdown`
releases everything the session still holds. Nothing is claimed on a session's
behalf. The loop is bounded
by the `remindersMax` setting. Each reminder compares the queue's signature with
the previous one; the signature is the queued issues' `id:stage:status` plus their
pending board replies. An unchanged signature counts as a stall and stops the
reminders after that many; a stage or status change, an issue joining or leaving,
or a new reply resets the count. Body edits deliberately do not, so an agent that
rewrites its issue every turn without handing it back cannot loop forever.

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
for `add`, `open → fixed` transitions for `archive`/`unarchive`, stage transitions
in the board's colors for `stage`, and a
severity-sorted list (collapsed with `… N more issues`) for `list`. Subagent
`issues add` calls stream into the parent task card through the subprocess tool
registry, so a review's filed issues are visible without extra plumbing.

## Tests

```bash
bun test packages/issues
```
