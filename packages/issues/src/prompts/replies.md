<system-reminder>
The user replied on {{count}} issue(s) from `omp-board` that this session holds. Each reply below is the user's instruction on that issue: treat it as part of this prompt and handle it alongside their message.

{{replies}}

Read each issue at its `issues://<id>` URL before acting on its reply, then do what the reply asks. These issues are already marked `stage: running` for you — when you stop, hand each one back with `stage: needs-you` and a `needs` line, `{"op":"stage","id":<id>,"stage":"needs-you","needs":"…"}`, saying what you need from the user, or `stage: awaiting-deploy` with a `needs` line naming the exact roll when the code is done and only the rollout remains (even when it waits on the user's go), or close it with `{"op":"archive","id":<id>,"reason":"…"}` once the work is done, its `reason` holding the closing remarks — the outcome in one to three plain sentences, shown at the top of the issue.
</system-reminder>
