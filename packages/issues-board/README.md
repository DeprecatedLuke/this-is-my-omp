# omp-issues-board

Terminal issue list for the [omp-issues](../issues) tracker. It reads and
writes the `.omp/issues` markdown files of a checkout directly — no server, no
network, nothing to sync — and reloads live while agents file, edit and archive
issues underneath it.

```
 ▌ omp-board · myrepo ~/src/myrepo                                                         3 issues
 Finished 1 · Active 1 · Awaiting deploy 0 · Done 1
────────────────────────────────────────────────────────────────────────────────────────────────────
 ▌ Finished 1 ──────────────────────────────────────────────────────────────────────────────────────
 #130  ◆ Finished · wontfix medium   Drop the legacy CSV export endpoint                     api now

 ▌ Active 1 ────────────────────────────────────────────────────────────────────────────────────────
 #1    ▶ Up next            high     Retry the upload job on transient storage e… report  uploads 3h

 ▌ Done 1 ──────────────────────────────────────────────────────────────────────────────────────────
▌#12   ✓ Done · fixed       critical Keep session tokens out of request logs                auth now
```

**Finished** (archived and not yet looked at) is on top, then **Active** (the rest
of the unarchived issues), then **Awaiting deploy**, then **Done** (archived and
seen); each group lists the most recently updated issue first.

## Install

The board is a standalone command, not an omp plugin:

```sh
bun install                                   # links the workspace packages
ln -s "$PWD/packages/issues-board/bin/omp-board" ~/.local/bin/omp-board
```

`bin/omp-board` resolves its own path through symlinks and runs the TypeScript
entrypoint with Bun, so it works from any directory.

## Usage

```sh
omp-board                 # board for the checkout containing the current directory
omp-board ~/src/myrepo    # board for another checkout
omp-board --issue 211     # open with that issue selected and its detail view showing
```

The start directory is the positional `path`, else the working directory of the
herdr pane the board was launched from, else the current directory. The board
walks up from there to the nearest directory containing `.omp/issues` and exits
with `no .omp/issues found at or above <start>` when there is none.

## Groups

Four groups, top to bottom, each ordered by `updated`, newest first:

| Group | What is in it |
|---|---|
| Finished | archived, and updated after the user last looked at it |
| Active | every issue that is not archived, except those awaiting deploy |
| Awaiting deploy | not archived, `stage: awaiting-deploy` |
| Done | archived, and already seen |

An archived issue counts as unseen when its `updated` is later than both the
inbox watermark (when this machine's inbox was created) and the stamp the user
last opened it with. Opening a Finished issue's detail view records that stamp,
so the issue moves to Done — the tracker's "you have dealt with this" marker.

Done shows archived issues updated within the last 7 days; `a` switches it to
every archived issue.

A row is one line: `#id`, the state chip, severity, title, then the badges, the
category and the age of `updated`. On a narrow terminal the category goes first,
then the age, so the title keeps its room.

## States

The chip is the issue's state: **Needs you**, **Up next**, **Open**,
**Running**, **Awaiting deploy**, **Deferred**, or — for an archived issue —
**Finished** / **Done** with its resolution (`fixed`, `wontfix`, `duplicate`).

An active issue's state comes from its frontmatter:

| Issue | State |
|---|---|
| `stage: needs-you` / `up-next` / `running` / `awaiting-deploy` / `deferred` | that state |
| `status: in-progress` | Running |
| anything else active | Open |

`1`–`7` set the state of the selected issue:

| Key | Written |
|---|---|
| `1` Needs you | `stage: needs-you` |
| `2` Up next | `stage: up-next` |
| `3` Open | clears `stage`, `status: open` |
| `4` Running | `stage: running` |
| `5` Awaiting deploy | `stage: awaiting-deploy` |
| `6` Deferred | `stage: deferred` |
| `7` Done | clears `stage`, `status:` fixed, wontfix or duplicate (the prompt picks one) |

Setting an archived issue to any active state also writes `status: open`, so it
returns to the active side of the tracker. The board never writes
`status: in-progress` (that status drives omp's end-of-turn reminders); use
`stage: running` to mark work in flight.

Every state change bumps `updated` and keeps every other frontmatter key and the
body untouched. The issue stays with the omp session that holds it (only Done
frees the claim), so a requeue or a later reply goes back to that session, and the
footer says which one. The issue is queued for this machine's agents only when
the target is **Up next**; see [Replies](#replies).

## Keys

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | previous / next issue |
| page keys | jump a page |
| `g` `G` | first / last issue |
| `1`–`7` | set the state; the list footer names each key's state in its colour |
| `enter` | open the issue's detail view (fields, report link, markdown body) |
| `r` | reply to the issue (list or detail view) |
| `esc` | clear the filter, cancel a reply, or leave the detail view |
| `e` | edit the issue file in nvim |
| `/` | filter by substring over title, category and body |
| `a` | toggle Done between the last 7 days and every archived issue |
| `q` / `ctrl+c` | quit |

In the detail view `↑` `↓` / `j` `k` / page keys scroll, `g` / `G` jump to the
top and bottom, `esc` goes back and `e` edits the file.

The board reloads itself whenever `.omp/issues` or the issues inbox changes
(debounced 150 ms), so an agent filing, editing or taking an issue shows up
without a restart. The cursor stays on the issue it is on while other rows move;
when that issue moves itself — a state change, a reply, opening a Finished issue
— the cursor stays at its row and lands on whatever takes that slot. A failed
write (a file archived underneath the board, say) reports in the footer instead
of ending the session.

## Replies

`r` on a row (or in the detail view) opens a one-line prompt labelled with the
issue id. `enter` queues the text, `esc` cancels without writing anything.

Replies, queue marks and claims are machine-local: they live in the user's
issues inbox, never in the git-tracked issue files, so a commit cannot pick up a
half-delivered reply or a session id.

```
~/.omp/agent/issues-inbox/<repo>-<hash>/
  replies/<id>/<epochMs>-<rand>.txt   one pending reply per file
  queued/<id>                         the user queued this issue on this machine
  claims/<id>                         the omp session that owns the issue
  seen/<id>, seen/.watermark          what the user has already looked at
```

`<repo>-<hash>` is the checkout's directory name plus the first 12 hex digits of
the sha256 of its real path, so two checkouts never share state.

A queued reply waits until the next prompt (or turn end) of the omp main session
holding that issue. That session takes the file atomically — a rename, so two
sessions can never deliver the same reply — receives the text as a system
reminder, and the delivered text is appended to the issue body under
`## Replies` / `### User reply · <time>`, which *is* committed. Replying also
moves the issue back to **Up next** (unarchiving it if needed): the user wants
the work started next.

An agent only works through issues the user queued on this machine, so a cloned
repo's `stage: up-next` cannot drive your agents.

Rows with a pending reply show a `reply` badge, and the detail view lists each
pending reply with the time it was queued. An issue claimed by an omp session
shows `⧗` plus the first six characters of the session id (the detail view shows
the whole id); claims are atomic, so two sessions cannot take the same issue.

### An issue follows the session you gave it to

Nothing takes an issue on its own. An issue becomes a session's work when the user
asks that session to work on it, and the agent then sets it `running`, which
claims it. From then on a reply or a state change goes to that session, and to no
other: the footer says `stays with session xxxxxx` or `reply queued for session
xxxxxx`. An issue no session holds waits — the footer says `reply waits until a
session takes the issue` — until the user prompts a session to take it. A claim
left behind by a dead session (no heartbeat for two minutes) is free for the next
prompted session to take over.

At the end of a turn an agent loops on the issues it holds that are queued for
this machine until it moves them on; `needs-you` (feedback required) breaks the
loop.

## Reports

An issue with a `report:` frontmatter value shows a `report` badge, and the
detail view shows the link. `report://<project>/<slug>` resolves to
`<url>/r/<project>/<slug>`, where `url` is the `url` setting of the
`agent-reports` plugin (`omp plugin config set agent-reports url https://…`).
Without a configured url the raw value is shown.

The detail view renders it as an OSC 8 hyperlink, so ctrl+click in herdr opens
the report in the real browser. The board never spawns a browser itself.

## API

`omp-board api <verb> [args] --root <path>` is the same board as JSON, for front
ends that draw it themselves (the Tern block) instead of running the TUI in a
pane. `--root` is any path inside the checkout: the checkout is found by walking
up to the nearest `.omp/issues`, exactly as the TUI does.

One verb per process. stdout is exactly one JSON object and the exit status is
`0`; any failure is exit `1` with `{"error": "<message>"}`.

```sh
omp-board api snapshot --root ~/src/myrepo
omp-board api snapshot --filter deploy --all-done --root ~/src/myrepo
omp-board api detail 12 --root ~/src/myrepo
omp-board api seen 12 --root ~/src/myrepo
omp-board api move 12 up-next --root ~/src/myrepo
omp-board api move 12 done --status fixed --root ~/src/myrepo
printf 'please check the staging log\n' | omp-board api reply 12 --root ~/src/myrepo
omp-board api wait --since <fingerprint> --timeout-ms 25000 --root ~/src/myrepo
```

| Verb | What it does |
|---|---|
| `snapshot [--filter TEXT] [--all-done]` | the whole board: groups, rows, counts, states |
| `wait --since FP [--timeout-ms N]` | block until the board changes, then the full snapshot |
| `detail ID` | one issue: its row, frontmatter, pending replies and body |
| `seen ID` | record that the user looked at the issue as of its `updated` |
| `move ID STATE [--status fixed\|wontfix\|duplicate]` | the `1`–`7` keys; Done needs a terminal status |
| `reply ID` | queue the text on stdin as the user's reply |

A row is what the list draws:

```json
{"id":12,"title":"…","category":"runtime","severity":"high","group":"active",
 "state":"up-next","label":"Up next","glyph":"▶","status":"open","stage":"up-next",
 "archived":false,"updated":"2026-11-08T09:12:00.000Z","age":"3h","replies":0,
 "claim":"01a1ac","report":"https://reports.example.com/r/myrepo/board-api",
 "file":"/home/me/src/myrepo/.omp/issues/runtime/12-board-api.md"}
```

`group` is the list group the issue is in (`finished`, `active`, `deploy`,
`done`), `state`/`label`/`glyph` are the chip, `claim` is the first six
characters of the live session holding it (the detail view has the whole id in
`claimFull`), and `report` is resolved through the `agent-reports` url like the
TUI's link. `counts` and the rows are after `--filter`, like the TUI header, and
`groups` lists non-empty groups only.

`snapshot` and `wait` carry a `fingerprint` over everything that can change the
board: every issue file's path, mtime and size (archived included), the inbox's
replies, queue marks, claims and seen stamps, and which claims are still live —
a claim goes stale on the clock alone, with no write to watch. `wait` returns the
moment that hash moves off `--since` (filesystem events, plus a re-check every
5 s), and `{"unchanged": true, "fingerprint": "…"}` at the timeout. It is
independent of `--filter`, so one waiter can serve a board with a filter.

`detail` does not mark the issue seen; `seen` is its own verb, which is how a
front end moves a Finished issue to Done. `move` and `reply` return the same
footer text the TUI shows (`#12 → Up next · stays with session aaaaaa`,
`#12 reply queued for session aaaaaa`), and a move to the state an issue is
already in writes nothing, exactly like the keypress.

## Tern

The board also ships as a [Tern](https://tern.sh) plugin (`tern/`, id `omp-board`),
so it can be drawn with Tern's own tables, badges and markdown instead of running
the TUI in a pane. The block is a client of [`omp-board api`](#api): every action
goes through the same TypeScript code as the terminal board, so the two cannot
drift apart.

Link the plugin once — it needs `bun`, which `bin/omp-board` finds on `PATH`:

```sh
tern plugin link /path/to/this-is-my-omp/packages/issues-board/tern
```

Then **Open issues board** in the command palette (`ctrl+alt+i` by default; Tern
drops a chord its preset already binds, so `ctrl+shift+i` — the inbox — and
`ctrl+shift+b` — a browser block — are not used, and a keymap entry can bind
`plugin.omp-board.open` to whatever you like). The block opens beside the focused
pane for that pane's checkout, and `ctrl+click` on an `issues://<id>` link in any
pane opens it on that issue's detail view.

The block keeps the terminal board's behaviour: the same groups in the same order,
the same state keys, the same footer texts, the same cursor rule (the cursor stays
on its issue while other rows move, and keeps its row when the issue moves itself),
and it reloads live through `omp-board api wait`.

| Key | Action |
|---|---|
| `j` `k` / `↑` `↓` | previous / next issue |
| page keys, `g` `G` | jump a page, first / last issue |
| `enter` / `i` / double-click | open the detail view (a Finished issue is marked seen) |
| `r` | reply to the issue; `enter` sends, `esc` cancels |
| `e` | open the issue file in Tern |
| `/` | filter by substring over title, category and body; `enter` keeps it, `esc` clears it |
| `a` | toggle Done between the last 7 days and every archived issue |
| `1`–`7` | set the state; `7` asks for `f` fixed, `w` wontfix or `d` duplicate |
| `esc` | clear the filter, cancel a prompt, or leave the detail view |

Right-clicking a row offers the same states, Done with each resolution, Reply,
Open file and — when the issue has one — Open report. The dock names the last
action's result in the API's own words, and the legend under the keys spells out
`1 Needs you · 2 Up next · …` in each state's colour.

## herdr

The board ships a herdr plugin (`herdr-plugin.toml`, id `omp.issues-board`,
herdr 0.7.4 or newer, Linux or macOS), so it can live in its own pane next to the
agents that file the issues.

Link the checkout once:

```sh
herdr plugin link /path/to/this-is-my-omp/packages/issues-board
herdr plugin action list --plugin omp.issues-board
```

Bind the action (the plugin does not install keybindings):

```toml
# ~/.config/herdr/config.toml
[[keys.command]]
key = "prefix+i"
type = "plugin_action"
command = "omp.issues-board.open-board"
description = "open issues board"
```

`herdr server reload-config` applies it. The board opens as a split pane and
keeps running there; without a keybinding the same pane opens with
`herdr plugin pane open --plugin omp.issues-board --entrypoint board`.

herdr runs plugin commands with the plugin directory as their working directory,
so the board takes its repository from the pane it was opened from
(`HERDR_PLUGIN_CONTEXT_JSON`: the focused pane's cwd, then the worktree checkout,
then the workspace cwd). Opening it from a pane in `~/src/myrepo` shows that
repository's tracker.

Ctrl+click an `issues://<id>` link in omp's output to open the board as a popup
on that issue. The plugin's `[[link_handlers]]` entry routes the click; the
`open-issue` action passes the id to the popup as `OMP_BOARD_FOCUS_ISSUE`. It
needs herdr's mouse capture (on by default) and an OSC 8 hyperlink, which omp's
markdown renderer emits for `issues://` URLs; herdr only auto-detects
`http(s)://` in plain text, so a bare `issues://239` printed by a shell is not
clickable.
