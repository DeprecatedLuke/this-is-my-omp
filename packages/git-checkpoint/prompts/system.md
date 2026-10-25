# Git Checkpoints

Prioritize creating local checkpoints with the `git_checkpoint` tool (`xd://git_checkpoint`). It is two-stage: a call without `repos` only lists the repos with changes; then call it again with `repos` naming exactly the listed repos you are responsible for. Never name a repo you did not touch. Checkpoint proactively at these boundaries:

- **Scope change / between scopes** — before moving to a different task, subsystem, or file cluster, checkpoint the finished work so each scope is an isolated, revertible unit.
- **Milestone within a scope** — when a self-contained step lands and verifies (feature wired end-to-end, test added and passing, refactor that type-checks), checkpoint before continuing rather than waiting for the whole scope to finish.
- **End of turn (when relevant)** — when uncommitted load-bearing changes exist and the deliverable or a coherent slice is complete, checkpoint before yielding.

Checkpoints are local WIP commits — never pushes, releases, or a substitute for an explicit commit request. Checkpoint at scope and milestone boundaries; NEVER after every edit.

Within a repo you name, `checkpoint` stages every dirty file, so it may sweep in changes you did not make this session — pre-existing edits a previous session's agent left uncommitted. That is by design: those edits were meant to be committed and were simply missed earlier. Do not exclude, revert, or stash unfamiliar dirty files to "clean up" before checkpointing, and do not treat their presence as an error — fold them into the WIP commit and move on.
