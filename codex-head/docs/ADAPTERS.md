# Codex Head Adapters

This document explains the current worker adapters and routing behavior.

## Worker Summary

| Worker | Primary role | Local | GitHub | Edit code | Review | Run tests | Feature flag |
|---|---|---:|---:|---:|---:|---:|---|
| `claude-code` | implementation specialist | yes | no | yes | yes | yes | none |
| `codex-cli` | synthesis, analysis, and local review | yes | no | yes | yes | yes | none |
| `gemini-cli` | GitHub-native review and analysis fallback | yes | yes | yes | yes | no | none |
| `antigravity` | research and exploration | yes | no | no | yes | no | `antigravity` |

Capability values come from the adapter definitions in
[`../src/adapter-registry/adapters/`](../src/adapter-registry/adapters/).

## Adapter Details

### `claude-code`

- Best fit for implementation, patch generation, and code-heavy tasks.
- Capability model allows local execution only.
- The planner chooses it for goals such as implement, build, fix, refactor,
  refine, edit, or write code.
- The repo now ships a safe default local template that runs Claude in
  non-interactive plan mode and expects artifact text back.

### `codex-cli`

- Best fit for synthesis, local review, reporting, and general analysis.
- Local execution only.
- This is also a default local reviewer and fallback target when `claude-code`
  produces a patch.
- The repo now ships a safe default local template that runs `codex exec` in
  read-only mode and expects artifact text back.

### `gemini-cli`

- Best fit for GitHub review, PR, issue, workflow, and triage flows.
- Supports both local and GitHub routing in the capability model.
- The planner chooses it for GitHub, PR, issue, workflow, or triage language.
- The repo now ships a safe default local template that runs Gemini in
  headless plan mode and expects artifact text back.
- The review workflow now builds a real diff review on GitHub when
  `GEMINI_API_KEY` is configured, and otherwise falls back to a safe commented
  callback artifact.

### `antigravity`

- Intended for research and exploration tasks.
- Gated behind the `antigravity` feature flag.
- Disabled by default in `src/config.ts`.
- When the feature flag stays disabled, research-shaped goals now fall back to
  local review/analysis workers instead of planning directly to `antigravity`.
- No code-edit or test-running capability is documented in the adapter model.

## Routing Behavior

The router in [`../src/router/index.ts`](../src/router/index.ts):

- tries the requested `worker_target` first
- checks whether the adapter is registered
- checks feature-flag state
- checks GitHub support when `requires_github` is `true`
- otherwise checks local health through binary discovery
- falls back by `expected_output.kind` when needed
- temporarily deprioritizes workers that recently hit local quota, auth, or
  timeout failures

When a fallback happens, the task record stores the resolved routing and the
worker result must report the actual adapter that executed the task.

When a local worker fails during runtime, Codex Head now retries the same
dispatch with the next healthy local fallback for that output kind. The full
ordered chain is written to `execution-attempts.json` in the task artifact
directory.

When a worker recently hit quota, auth, or timeout failures, `health` exposes a
cooldown for that worker and the router pushes it behind healthier local
candidates. The worker is still left as a last resort if no better candidate is
available.

Fallback groups:

- `analysis` -> `codex-cli`, `gemini-cli`, `antigravity`, `claude-code`
- `patch` -> `claude-code`, `codex-cli`
- `pull_request` -> `gemini-cli`, `codex-cli`
- `review` -> `codex-cli`, `gemini-cli`, `claude-code`
- `report` -> `codex-cli`, `gemini-cli`, `antigravity`

When `github.enabled` is `false`, local-only routing changes the order for the
most common non-code tasks:

- `analysis` -> `gemini-cli`, `codex-cli`, `claude-code`, `antigravity`
- `patch` -> `claude-code`, `gemini-cli`, `codex-cli`
- `review` -> `gemini-cli`, `codex-cli`, `claude-code`
- `report` -> `gemini-cli`, `codex-cli`, `antigravity`

This local-only bias exists because `gemini-cli` can serve as a stable local
reviewer and analyzer without forcing GitHub workflows, while `codex-cli`
remains in the same local reviewer pool for code-change tasks.

## Important Internal-Beta Caveats

- Adapter health checks only prove that a binary exists.
- Readiness also proves that a local template exists, but it still does not
  prove the upstream CLI is authenticated.
- The `readiness` section of `npm run health` is the operational signal to use
  when deciding whether a worker is actually runnable.
- Cooldown-aware readiness now marks recently penalized workers as not
  `local_ready` until their short-term penalty expires.
- `gemini-cli` is the only built-in GitHub-capable adapter.
- `antigravity` is intentionally disabled by default.

## Required Binaries

- `claude-code` -> `claude`
- `codex-cli` -> `codex`
- `gemini-cli` -> `gemini`
- `antigravity` -> `antigravity`

## Concurrency Metadata

Current adapter metadata declares:

- `claude-code` max concurrency: `2`
- `codex-cli` max concurrency: `2`
- `gemini-cli` max concurrency: `3`
- `antigravity` max concurrency: `1`

These values are metadata for routing and planning. They are not currently
enforced by a dedicated scheduler.
