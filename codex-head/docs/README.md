# Codex Head Docs

This folder is the internal documentation home for `codex-head`.

## Status

`codex-head` is **internal beta**.

It is ready for:

- local team development
- contract and adapter integration work
- orchestration experiments
- task planning, queueing, and callback testing

It is not ready for:

- unattended production GitHub automation
- fully autonomous release workflows
- production governance, budget control, or incident response

## What Works Now

- Typed `TaskSpec` planning from natural-language goals
- One-shot goal execution through `run-goal`
- `configure-github-repo` bootstrap for validating and writing the target
  GitHub repository override
- Worker routing across `claude-code`, `codex-cli`, `gemini-cli`, and
  `antigravity`
- SQLite-backed task lifecycle:
  `planned -> queued -> running -> awaiting_review -> completed|failed|canceled`
- Artifact generation for task specs, routing decisions, logs, patches, and
  GitHub dispatch payloads
- Opt-in live GitHub workflow dispatch through `gh workflow run`
- Opt-in GitHub issue mirror and PR mirror publishing through `gh`
- GitHub worker workflows now produce typed callback artifacts
- Callback ingestion through `complete-from-file`
- Callback download and ingestion through `sync-github-callback`
- Callback wait, download, and ingestion through `wait-github-callback`
- Persisted `github_run` tracking for live workflow-dispatched tasks
- Persisted `github_mirror` tracking for published issue and PR mirrors
- One-shot GitHub dispatch plus callback reconciliation through
  `dispatch-and-wait`
- Batch reconciliation for running GitHub tasks through
  `reconcile-github-running`
- Recovery for interrupted `running` tasks through `recover-running`
- Auto-detection of `github.repository` from runtime environment or git remote
- Review aggregation through `review` or callback ingestion while a task is in
  `awaiting_review`
- Deterministic dispatch of a specific queued task
- Automatic local execution fallback when the first healthy worker fails during
  runtime execution
- Cooldown-aware local readiness that temporarily deprioritizes workers after
  recent quota, auth, or timeout failures
- Safe default local execution templates for `claude-code`, `codex-cli`, and
  `gemini-cli`
- Test coverage for contracts, routing, retry behavior, state transitions,
  smoke health checks, and GitHub payload generation

## Intentionally Incomplete

- GitHub mirror publishing is implemented, but automatic mirror updates and
  richer GitHub-side synchronization are not
- `codex-head-worker.yml` still depends on runner-side worker binaries and local
  templates to execute meaningfully
- `codex-head-gemini-review.yml` falls back to a safe commented callback when
  Gemini auth is not configured or the Gemini action fails
- `health` still cannot prove that upstream worker CLIs are authenticated
- `antigravity` is disabled by default through a feature flag

## First Successful Run

The recommended first successful run is now `run-goal`.

```bash
cd codex-head
npm install
npm run health
node dist/src/index.js run-goal "Summarize the current orchestration state"
node dist/src/index.js run-goal "Review the latest PR in GitHub"
```

After `run-goal`, inspect `runtime/artifacts/<task-id>/` for the local core
files:

- `execution-attempts.json`
- `task-input.json`
- `worker-result.json`
- `dispatch-outcome.json`
- `routing-decision.json`

GitHub-routed tasks also add:

- `github-dispatch.json`
- `github-worker-inputs.json`
- `github-issue.md`

## Local Execution Note

The default config in [`src/config.ts`](../src/config.ts) now ships safe local
templates for `claude-code`, `codex-cli`, and `gemini-cli`. Those defaults run
the CLIs in non-interactive read-only or plan-style modes and expect them to
return artifact content, not mutate the repository directly.

The default bootstrap is local-only. `github.enabled` now starts as `false`,
and GitHub becomes an explicit opt-in path instead of the default control flow.

When `github.enabled` is set to `false`, planner-generated PR, issue, workflow,
or GitHub review goals remain local and route through local workers instead of
requiring a remote workflow. Research goals also stay off `antigravity` unless
that feature flag is explicitly enabled.

Use [`config/workers.example.json`](../config/workers.example.json) when you
want to override those defaults for a different local execution policy.

The config loader accepts both the current snake_case top-level keys and the
older camelCase variants for backward compatibility.

## Document Map

- [Architecture](ARCHITECTURE.md): system model, task flow, queue states, and
  lineage rules
- [Contracts](CONTRACTS.md): current TypeScript interfaces and defaults
- [Operations](OPERATIONS.md): install, run, inspect, and troubleshoot
- [Adapters](ADAPTERS.md): worker roles, capabilities, fallbacks, and flags
- [GitHub handoff](GITHUB.md): workflow behavior, payloads, and callback files

## Known Gaps To Production

- No fully wired GitHub API control plane for mirror updates, PR review events,
  or background workflow callbacks
- A real target `OWNER/REPO` still has to be chosen for live end-to-end use
- Real model review on GitHub-hosted runners requires one of:
  `REVIEW_API_URL` + `REVIEW_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`;
  without any of them, the review workflow can still run but only emits a
  fallback callback
- Callback reconciliation from GitHub artifacts into SQLite can be polled
  on-demand, but it is not automatic or background-polled
- `run-goal` can self-heal across local workers, but it still cannot recover if
  every candidate CLI is installed yet unusable at runtime
- `antigravity` is disabled by default
- Production monitoring, rollout controls, and release governance are not built
  yet
