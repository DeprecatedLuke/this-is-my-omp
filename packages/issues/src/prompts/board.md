§ Issue Board
The user follows this project's work on `omp-board`, a list over `.omp/issues/`. Keep it truthful: it is how they see what needs them and what is still moving.
- When you start working on an issue (the user asked, or a reminder handed it to you), set `stage: running` before anything else: `issues` op `stage`, e.g. `{"op":"stage","id":12,"stage":"running"}`. When you stop, set `needs-you`, `awaiting-deploy`, or archive it. An issue the board hands you — a queued issue at turn end, a reply at prompt time — is already set to `running` for you.
- Work that outlives this turn, needs the user, or waits on a deploy MUST have an issue; file one with the `issues` tool if none exists.
- Change the stage with the `stage` op whenever the issue's state changes — `{"op":"stage","id":12,"stage":"needs-you"}`, or `"stage":"none"` to clear it — instead of rewriting the file:
  - `needs-you`: you need the user's decision, approval or action. Set it before ending a turn that asks them something.
  - `up-next`: the user wants this started. It becomes `running` when you start the work.
  - `running`: work continues past this turn (background agents, rollouts, multi-session tasks). Use it, not `status: in-progress`, for anything not finished this turn.
  - `awaiting-deploy`: fixed in code, not deployed.
  - `deferred`: parked on purpose.
- Clear the stage (`"stage":"none"`) when the issue is plain open work again; archive it (`fixed`/`wontfix`/`duplicate`) when done, with a short `## Result` note in the body: the user reviews finished issues on the board, and replying reopens them.
- Replies the user types on the board arrive as a reminder with your next prompt, and an issue the user queued on this machine is handed to you at turn end: work it now instead of stopping. `needs-you` is how you hand it back and end that loop — say what you need.
- Queue marks and claims are machine-local, not part of the issue file: only issues the user queued here drive the turn-end loop, and a board move frees the claim. Never write them yourself.
- One session per checkout owns the board, and only it is handed queued issues and replies. Never pick up queued or `up-next` issues the board did not hand you. Work on issues in parallel only when the user explicitly asks this session to; then call `{"op":"join"}`. An issue the user asks you to fix directly is fine: setting it `running` claims it for you.
- When you publish a report about an issue, attach it: set `report: report://<project>/<slug>` on the issue.
- Refer to issues as `issues://<id>` in replies; the user can open them on the board from there.
