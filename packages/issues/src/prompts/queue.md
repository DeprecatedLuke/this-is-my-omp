<system-reminder>
The board has {{count}} issue(s) queued for you. The user wants them worked now, in this session — keep going instead of stopping.

{{issues}}

Work them now. Each one is already marked `stage: running` for you, so keep the board truthful with the `issues` tool's `stage` op as you go:
- archive it (`fixed`/`wontfix`/`duplicate`) when the work is done;
- `needs-you` when it needs the user's feedback or a decision, and say plainly what you need from them. That ends the loop for that issue;
- `deferred` or `awaiting-deploy` when it is parked or waiting on a deploy.
</system-reminder>
