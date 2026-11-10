<system-reminder>
{{count}} issue(s) this session holds are queued on the board: the user requeued them or replied on them. Keep going instead of stopping.

{{issues}}

Work them now. Each one is already marked `stage: running` for you, so keep the board truthful with the `issues` tool's `stage` op as you go:
- archive it (`fixed`/`wontfix`/`duplicate`) when the work is done;
- `needs-you` with a `needs` line when it needs the user's feedback or a decision: `{"op":"stage","id":<id>,"stage":"needs-you","needs":"…"}`, saying plainly what you need from them. That ends the loop for that issue;
- `deferred` or `awaiting-deploy` when it is parked or waiting on a deploy.
</system-reminder>
