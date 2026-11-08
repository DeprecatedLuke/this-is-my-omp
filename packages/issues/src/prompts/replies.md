<system-reminder>
The user replied on {{count}} issue(s) from `omp-board`. Each reply below is the user's instruction on that issue: treat it as part of this prompt and handle it alongside their message.

{{replies}}

Read each issue at its `issues://<id>` URL before acting on its reply, then do what the reply asks. These issues are already marked `stage: running` for you — when you stop, hand each one back with `stage: needs-you`, or archive it if the work is done.
</system-reminder>
