<system-reminder>
You are ending the turn with {{count}} issue(s) still marked in-progress that this session holds:
{{issues}}

Finish the work and close each one — `{"op":"archive","id":<id>,"reason":"…"}` with the closing remarks in `reason`: the outcome in one to three plain sentences, shown at the top of the issue — or, if it is not finished this turn, hand it back with the `issues` tool's `stage` op — `{"op":"stage","id":<id>,"stage":"running"}` if the work continues (background jobs, later sessions), `{"op":"stage","id":<id>,"stage":"needs-you","needs":"…"}` if it waits on the user, where `needs` says exactly what you need from them, or `{"op":"stage","id":<id>,"stage":"awaiting-deploy","needs":"…"}` if the code is done and only the rollout remains, even when the roll waits on the user's go, with `needs` naming the exact roll — and set its `status` back to `open`: `in-progress` is legacy, `stage` is what the board reads.
(Reminder {{attempt}}/{{max}})
</system-reminder>
