# omp-agents

omp plugin shipping four extra delegated agents, three of which used to be embedded in the host
package. They are plain `agents/*.md` files — the plugin has no extension entry point,
no tools, no commands, no settings; the host discovers `agents/` from every enabled
OMP extension package root.

| Agent      | Purpose                                                                 | Tools                | Model        |
| ---------- | ----------------------------------------------------------------------- | -------------------- | ------------ |
| `solver`   | Open-ended problem solving from the web plus reasoning; no repo access.  | `web_search`, `browser` | `pi/solver`  |
| `advanced` | `task` worker that stays on the `@slow` role through its edits (prewalk off), for work where the writing itself needs reasoning; plan-then-specified edits stay on `task`. | all (host default) | `@slow` |
| `tester`   | Authoritative test writer: defends real contracts, refuses plumbing tests. | read/grep/glob/bash/edit/write/lsp/ast_grep/ast_edit | `pi/task` |
| `designer` | UI/visual design: layout, hierarchy, theming, polish; screenshots and iterates. | all (host default) | `pi/designer` |

`solver` and `tester` run with `thinking-level: high`. `solver` is web-only by
design: it never receives `read`, `write`, `edit`, `bash`, `grep`, `find`, or `lsp`,
so a delegated question reasoning about the caller's repository is out of contract.
`advanced` sets `prewalk: false`: it stays on its model for the whole run (a per-agent `/agents` override can still re-arm it).

## Install

```bash
omp plugin link /path/to/this-is-my-omp/packages/agents
```

Verify in the `/agents` picker or the `task` tool's agent roster: `advanced`, `solver`,
`tester`, and `designer` appear as user-scope agents (source `user`, file path under
`.../packages/agents/agents/`). Unlinking the plugin removes them from the roster
again — nothing about them remains in the host package. `omp agents unpack` writes
only the host's embedded agents to disk, so these four are not part of it.

## Model roles

The `model:` frontmatter uses role selectors — the legacy `pi/<role>` spelling or `@<role>`
(`advanced`) — which the host resolves through `modelRoles.<role>` (an unassigned role
falls back through the host's role priority chain):

```yaml
modelRoles:
  solver: anthropic/claude-opus-4-6:high
  slow: anthropic/claude-opus-4-6:high
  task: anthropic/claude-sonnet-4-6
```

Roles are defined by the host, not by this plugin — nothing here needs to be
registered for them to work.

## Dependency: `ultrasolve`

The host's `ultrasolve` magic keyword escalates a difficult turn to `agent: "solver"`
via the `task` tool. That escalation only resolves while this plugin is linked; without
it, the keyword's escalation target does not exist and the `task` call fails to
resolve its agent. Keep the plugin installed if you rely on `ultrasolve`.

## Tests

```bash
bun test packages/agents
```

The suite drives the host's real `discoverAgents()` with this package directory as an
explicit extension root and asserts the four agents are published from
`agents/`, keep their model/thinking frontmatter, keep `solver` web-only, and keep `advanced` on `@slow` without prewalk.
