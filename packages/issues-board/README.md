# omp-issues-board

Terminal issue list for the [omp-issues](../issues) tracker. It reads and
writes the `.omp/issues` markdown files of a checkout directly — no server, no
network, nothing to sync — and reloads live while agents file, edit and archive
issues underneath it.

```
 ▌ omp-board · myrepo ~/src/myrepo                                                         3 issues
 Finished 1 · Active 1 · Done 1
────────────────────────────────────────────────────────────────────────────────────────────────────
 ▌ Finished 1 ──────────────────────────────────────────────────────────────────────────────────────
 #130  ◆ Finished · wontfix medium   Drop the legacy CSV export endpoint                     api now

 ▌ Active 1 ────────────────────────────────────────────────────────────────────────────────────────
 #1    ▶ Up next            high     Retry the upload job on transient storage e… report  uploads 3h

 ▌ Done 1 ──────────────────────────────────────────────────────────────────────────────────────────
▌#12   ✓ Done · fixed       critical Keep session tokens out of request logs                auth now
```

**Finished** (archived and not yet looked at, newest first) is on top, then
**Active** (every issue that is not archived, oldest first, so work that has
waited longest leads), then **Done** (archived and seen, newest first).

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

Three groups, top to bottom, ordered by `updated`:

| Group | What is in it | Order |
|---|---|---|
| Finished | archived, and updated after the user last looked at it | newest first |
| Active | every issue that is not archived, whatever its stage | oldest first |
| Done | archived, and already seen | newest first |

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
body untouched. It also frees any claim on the issue, and queues the issue for
this machine's agents only when the target is **Up next**; see
[Replies](#replies).

## Keys

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | previous / next issue |
| page keys | jump a page |
| `g` `G` | first / last issue |
| `1`–`7` | set the state (Needs you … Done) |
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
(debounced 150 ms) and keeps the selection on the same issue, so an agent filing,
editing or taking an issue shows up without a restart. A failed write (a file
archived underneath the board, say) reports in the footer instead of ending the
session.

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

A queued reply waits until the next prompt (or turn end) of an omp main session
in that checkout. That session takes the file atomically — a rename, so two
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
Changing an issue's state frees its claim, which is how a claim left behind by a
dead session goes away.

At the end of a turn an agent loops on the issues queued for this machine until
it moves them on; `needs-you` (feedback required) breaks the loop.

## Reports

An issue with a `report:` frontmatter value shows a `report` badge, and the
detail view shows the link. `report://<project>/<slug>` resolves to
`<url>/r/<project>/<slug>`, where `url` is the `url` setting of the
`agent-reports` plugin (`omp plugin config set agent-reports url https://…`).
Without a configured url the raw value is shown.

The detail view renders it as an OSC 8 hyperlink, so ctrl+click in herdr opens
the report in the real browser. The board never spawns a browser itself.

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
