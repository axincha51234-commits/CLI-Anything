# Codex Head

`codex-head` is the internal control layer that keeps Codex App as the single
planner, router, and synthesis authority for CLI-Anything's multi-agent
experiments.

## Status

`codex-head` is **internal beta**.

- Use it for team development, orchestration experiments, and contract-driven
  worker integration.
- Do not treat it as production-ready GitHub automation or autonomous release
  infrastructure yet.

## Quick Start

```bash
cd codex-head
npm install
npm run health
node dist/src/index.js run-goal "Summarize the current orchestration state"
node dist/src/index.js run-goal "Review the latest PR in GitHub"
```

The default local templates now run `claude-code`, `codex-cli`, and
`gemini-cli` in safe non-interactive read-only or plan-style modes. They are
meant to produce artifacts, summaries, and patch text, not uncontrolled local
mutation.

The default bootstrap is now local-first. `github.enabled` starts as `false`,
so a fresh clone stays on-machine unless you explicitly enable GitHub routing.

`run-goal` is now the shortest operator path. It plans, saves, enqueues,
publishes mirrors when needed, dispatches the task, and waits for GitHub
callbacks when a live workflow run is available. For GitHub work, it also
auto-promotes the current run to live `gh_cli` dispatch when a real repository
is configured and `gh auth status` is healthy.

When `github.enabled` is `false`, GitHub-shaped goals stay local. Codex Head
keeps PR, issue, workflow, and research-shaped goals on local workers instead
of forcing a GitHub dispatch or a disabled `antigravity` route.

Local-only `summarize`, `report`, and `research` goals now stay typed as
`analysis` work even when the planner prefers `gemini-cli`, so the runtime can
still fall through to `claude-code` when review-specific workers are weak.

When a local worker fails at runtime, Codex Head now tries the next healthy
local fallback in the same dispatch and records the chain in
`runtime/artifacts/<task-id>/execution-attempts.json`.

`npm run health` now also reports cooldown-aware readiness. If a worker
recently hit a quota, auth failure, or timeout, readiness marks it as not
currently local-ready and exposes the matching cooldown reason.

## Docs

- [Docs home](docs/README.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contracts](docs/CONTRACTS.md)
- [Operations](docs/OPERATIONS.md)
- [Adapters](docs/ADAPTERS.md)
- [GitHub handoff](docs/GITHUB.md)

## Current Scope

- Typed planning and routing for `claude-code`, `codex-cli`, `gemini-cli`, and
  `antigravity`
- SQLite-backed task lifecycle and retry state
- CLI support for `health`, `run-goal`, `configure-github-repo`, `plan`, `enqueue`,
  `review`, `status`, `dispatch`, `dispatch-next`, `dispatch-and-wait`, `publish-github-mirror`,
  `run-github-payload`,
  `sync-github-callback`, `wait-github-callback`, `clear-penalties`,
  `reconcile-github-running`, `recover-running`, and `complete-from-file`
- Local artifact generation and GitHub dispatch payload generation
- Opt-in live GitHub workflow dispatch through `gh workflow run`
- Opt-in GitHub issue and PR mirror publishing through `gh`
- GitHub worker workflows that now emit typed callback artifacts
- GitHub workflow run tracking persisted into task state as `github_run`
- GitHub mirror metadata persisted into task state as `github_mirror`
- One-shot GitHub orchestration through `dispatch-and-wait`
- Batch reconciliation for running GitHub tasks through
  `reconcile-github-running`
- One-shot operator automation through `run-goal`
- Auto-detection of `github.repository` from `GITHUB_REPOSITORY` or `git remote origin`
- Review aggregation for required reviewers while tasks are in
  `awaiting_review`
- Automatic local execution fallback to the next healthy worker when the
  first local worker fails at runtime
- Recent local quota, auth, and timeout penalties that temporarily deprioritize
  weak workers on later tasks
- Local-only planning that keeps GitHub-shaped goals on machine when GitHub is
  disabled
- Smoke, contract, routing, retry, and orchestrator tests

## Known Gaps

- Live GitHub workflow dispatch is opt-in and still requires `gh` auth plus a
  real `github.repository` value.
- `run-goal` can auto-upgrade GitHub tasks to live `gh_cli` dispatch for the
  current run, but a real target repo still has to be discoverable or supplied.
- GitHub issue and PR mirror publishing is now supported, but automatic mirror
  updates and richer sync flows are not fully wired.
- The Gemini review workflow now uses real Gemini review logic only when
  `GEMINI_API_KEY` is configured in GitHub Actions.
- GitHub callback reconciliation can now either sync directly from artifacts or
  wait on a resolved workflow run, but it is not background or automatic yet.
- Local worker defaults do not verify upstream CLI authentication in advance,
  so automatic fallback still fails if every candidate worker is unusable at
  runtime.
- `antigravity` is disabled by default behind a feature flag.
- Legacy config files may still use camelCase keys, but the loader now accepts
  both camelCase and snake_case overrides.
- Queue priority is respected by `dispatch-next`, while `dispatch <task-id>` is
  available for deterministic dispatch.
- Production governance, monitoring, and release controls are not complete.
