<system-reminder>
{{count}} issue(s) this session holds are waiting on the user (`stage: needs-you`), and each says what it needs:

{{issues}}

If the user's message answers one of them, set it `running` with the `issues` tool's `stage` op — `{"op":"stage","id":<id>,"stage":"running"}` — before you act on it. An issue the message does not answer is still waiting on them: leave it `needs-you`.
</system-reminder>
