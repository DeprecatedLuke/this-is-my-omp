§ Issue Board
The user follows this project's work on `omp-board`, a list over `.omp/issues/`. Keep it truthful: it is how they see what needs them and what is still moving.
- When you start working on an issue the user asked you to work on, set `stage: running` before anything else: `issues` op `stage`, e.g. `{"op":"stage","id":12,"stage":"running"}`. When you stop, set `needs-you`, `awaiting-deploy`, or archive it. An issue this session already holds — one the user asked for here — is already `running`.
- Work that outlives this turn, needs the user, or waits on a deploy MUST have an issue; file one with the `issues` tool if none exists. Starting on it now? File and claim in one call: `add` with `"stage":"running"`, rather than `add` then `stage`.
- When the user replies to a `needs-you` issue here in chat — answering the question it asked — set it `running` first (`{"op":"stage","id":12,"stage":"running"}`), then do the work: their message is what unblocked it, and the board should say so.
- Change the stage with the `stage` op whenever the issue's state changes — `{"op":"stage","id":12,"stage":"awaiting-deploy"}`, or `"stage":"none"` to clear it — instead of rewriting the file:
  - `needs-you`: you need the user's decision, approval or action. It takes `needs`: exactly what you need from them, in one or two plain sentences — `{"op":"stage","id":12,"stage":"needs-you","needs":"Pick the storage layout: one table per tenant, or a shared table with a tenant column?"}`. That text is shown at the top of the issue on the board, so it is how the user knows what they are being asked. Set it before ending a turn that asks them something.
  - `up-next`: the user wants this started. It becomes `running` when you start the work.
  - `running`: work continues past this turn (background agents, rollouts, multi-session tasks). Use it, not `status: in-progress`, for anything not finished this turn.
  - `awaiting-deploy`: fixed in code, not deployed.
  - `deferred`: parked on purpose.
- Clear the stage (`"stage":"none"`) when the issue is plain open work again; archive it (`fixed`/`wontfix`/`duplicate`) when done, with a short `## Result` note in the body: the user reviews finished issues on the board, and replying reopens them.
- Never pick up an issue on your own. Work on one only when the user asks you to, and then set it `running` first: that claims it for this session. Setting `needs-you` claims it too, so the user's answer comes back to the session that asked. A queued issue, an `up-next` one, or a board reply is not an instruction to start — the user tells this session what to work on.
- From then on the issue follows this session: the user's board replies and requeues for it arrive as a reminder with your next prompt, or at turn end while you are working — work them now instead of stopping. `needs-you` is how you hand it back and end that loop — say what you need in its `needs` text.
- If the `stage` op says another live session holds the issue, tell the user instead of working on it: two sessions on one issue conflict.
- Queue marks and claims are machine-local, not part of the issue file: only issues the user queued here drive the turn-end loop. An issue you hold stays yours when the user moves or replies to it on the board, until it is Done. Never write them yourself.
- When you publish a report about an issue, attach it: set `report: report://<project>/<slug>` on the issue.
- Refer to issues as `issues://<id>` in replies; the user can open them on the board from there.
