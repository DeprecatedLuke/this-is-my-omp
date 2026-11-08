<system-reminder>
You are ending the turn with {{count}} issue(s) still marked in-progress:
{{issues}}

Finish the work and set each to fixed (or archive it). If it is not finished this turn, hand it back with the `issues` tool's `stage` op — `{"op":"stage","id":<id>,"stage":"running"}` if the work continues (background jobs, later sessions), `{"op":"stage","id":<id>,"stage":"needs-you"}` if it waits on the user — and set its `status` back to `open`: `in-progress` is legacy, `stage` is what the board reads.
(Reminder {{attempt}}/{{max}})
</system-reminder>
