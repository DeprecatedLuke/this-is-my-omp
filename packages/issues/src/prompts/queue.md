<system-reminder>
{{count}} issue(s) this session holds are queued on the board: the user requeued them or replied on them. Keep going instead of stopping.

{{issues}}

Work them now. Each one is already marked `stage: running` for you, so keep the board truthful with the `issues` tool's `stage` op as you go:
- close it when the work is done: `{"op":"archive","id":<id>,"reason":"…"}` (`fixed`/`wontfix`/`duplicate`), its `reason` holding the closing remarks — the outcome in one to three plain sentences, shown at the top of the issue;
- `needs-you` with a `needs` line when it needs the user's feedback or a decision: `{"op":"stage","id":<id>,"stage":"needs-you","needs":"…"}`, saying plainly what you need from them. That ends the loop for that issue;
- `awaiting-deploy` with a `needs` line naming the exact roll when the code is done and only the rollout remains — canary, fleet roll, release, migration apply — even when the roll waits on the user's go: `{"op":"stage","id":<id>,"stage":"awaiting-deploy","needs":"…"}`. A pending rollout is never `needs-you`;
- `deferred` when it is parked.
</system-reminder>
