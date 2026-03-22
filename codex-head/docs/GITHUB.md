# Codex Head GitHub Handoff

This document describes the current GitHub-facing behavior in `codex-head`.

## What Exists Today

`codex-head` currently treats GitHub as a supporting control plane. In
`github.execution_preference = "local_preferred"` mode, that control plane can
stay active even when real execution happens on local workers first.

Implemented now:

- one-shot goal execution through `run-goal`
- repository bootstrap through `configure-github-repo`
- generation of GitHub mirror and dispatch artifacts
- GitHub issue mirror publishing
- GitHub PR mirror publishing for branch/PR-oriented tasks
- opt-in live workflow dispatch through `gh workflow run`
- workflow files for async execution and review callback handoff
- callback ingestion through `complete-from-file`
- explicit callback reconciliation through `sync-github-callback`
- run-aware callback polling through `wait-github-callback`
- one-shot GitHub dispatch plus callback reconciliation through
  `dispatch-and-wait`
- batch reconciliation for running GitHub tasks through
  `reconcile-github-running`
- hybrid local-first execution for GitHub-shaped tasks when
  `github.execution_preference` is set to `local_preferred`

Not implemented yet:

- automatic mirror update/reconcile flows
- background callback polling or automatic reconciliation loop

## Dispatch Artifacts

When a task resolves to GitHub mode, `dispatch-next` writes files under:

`runtime/artifacts/<task-id>/`

Generated files include:

- `github-dispatch.json`
- `github-worker-inputs.json`
- `github-dispatch-receipt.json` when live dispatch is enabled and succeeds
- `github-run-view.json` when a local operator waits on a specific GitHub run
- `github-mirror-receipt.json` when a local operator publishes issue/PR mirrors
- `github-callback.json` when a runner workflow executes and emits a result
- `github-callback-download.json` when a local operator syncs a callback from
  GitHub
- `github-issue.md`
- `github-pr.md` for code-changing work
- `dispatch-outcome.json`
- `routing-decision.json`

The dispatch payload contains:

- `repository`
- `workflow`
- full `task`
- resolved `routing`

`github-worker-inputs.json` is the workflow-facing handoff file. It contains:

- generic worker workflow inputs for `codex-head-worker.yml`
- review workflow inputs for `codex-head-gemini-review.yml`

## Dispatch Modes

Before live GitHub operations, you can validate and persist the target repo
with:

```bash
node dist/src/index.js configure-github-repo OWNER/REPO [dispatch-mode]
```

This validates the repo through `gh repo view` and writes the selected
repository into `config/workers.local.json`.

When you use `run-goal`, `codex-head` can also auto-upgrade the current run to
live `gh_cli` dispatch when:

- the planned task needs GitHub
- a real repository is already configured or passed through `--repo`
- `gh auth status` succeeds
- you do not force `--dispatch-mode artifacts_only`

`codex-head` now supports two GitHub dispatch modes:

- `artifacts_only`: write artifacts and stop there
- `gh_cli`: write artifacts and then trigger the selected workflow through
  `gh workflow run`

Separately, `github.execution_preference` controls where GitHub-shaped tasks
execute:

- `remote_only`: route `requires_github` work straight to GitHub execution
- `local_preferred`: keep GitHub mirrors and dispatch artifacts available, but
  let healthy local workers execute first and only fall through to GitHub when
  the local chain is unavailable

Live dispatch is opt-in and requires:

- `github.dispatch_mode: "gh_cli"`
- `github.repository` resolved to a real repository
- `gh` installed
- `gh auth status` passing for the target host

Both GitHub workflows also honor the repository variable
`CODEX_HEAD_RUNS_ON_JSON`. When unset, they default to `["ubuntu-latest"]`.
For a self-hosted path, set it to JSON such as
`["self-hosted","windows","khoa"]`.

For this repo, there is now a bootstrap helper at
[`../scripts/setup-self-hosted-runner.ps1`](../scripts/setup-self-hosted-runner.ps1).
It can:

- download and verify the Windows x64 GitHub Actions runner
- register it against the target repository
- optionally install and start it as a Windows service
- optionally set `CODEX_HEAD_RUNS_ON_JSON`
- optionally set `REVIEW_API_URL`, `REVIEW_API_KEY`, and `REVIEW_MODEL`

For `run-goal`, that opt-in can be satisfied automatically for the current run
when the conditions above are already true.

`github.repository` now resolves from:

- explicit config
- `GITHUB_REPOSITORY`
- `git remote origin`
- placeholder fallback if none of the above are available

When live dispatch succeeds, `github-dispatch-receipt.json` records the command,
workflow name, repository, CLI path, auth state, captured stdout/stderr, and
the resolved `run` metadata when `codex-head` can identify the workflow run.

## GitHub Mirrors

You can publish the task's issue and PR mirror metadata with:

```bash
node dist/src/index.js publish-github-mirror <task-id>
```

This currently uses authenticated `gh` CLI calls:

- `gh issue create`
- `gh pr create`

Issue mirrors are the primary path and are required to succeed. PR mirrors are
best-effort and only attempted when:

- the task produced `github-pr.md`
- the task signals branch/PR lineage through `artifact_policy.mode === "branch_pr"`
  or `expected_output.kind === "pull_request"`

The resulting issue/PR references are persisted in task state as
`github_mirror`.

The worker and review workflows now set:

- `run-name: codex-head task <task-id>`

That gives `codex-head` a stable handle for resolving the matching workflow run
through `gh run list` when `gh workflow run` output does not include a run URL.

## Callback Reconciliation

Once a remote workflow finishes, you can reconcile the callback locally with:

```bash
node dist/src/index.js sync-github-callback <task-id>
```

This uses `gh run download` with the task-scoped artifact names:

- `codex-head-worker-callback-<task-id>`
- `codex-head-github-callback-<task-id>`

The downloaded callback is stored under the task artifact directory and then
ingested through the existing `complete-from-file` path.

When live dispatch has already resolved a `run_id`, or when you want Codex Head
to poll for completion first, use:

```bash
node dist/src/index.js wait-github-callback <task-id> [timeout-sec] [interval-sec]
```

This command:

- loads the task's persisted `github_run` state, or resolves it again by task
  id and workflow name
- polls `gh run view <run-id>` until the run status becomes `completed`
- stores the latest run state back into SQLite
- downloads callback artifacts from that exact run with
  `gh run download <run-id>`
- ingests the downloaded `github-callback.json`

To dispatch and wait in one command:

```bash
node dist/src/index.js dispatch-and-wait <task-id> [timeout-sec] [interval-sec]
```

This is the shortest operator path for a queued GitHub task when you want
Codex Head to own both dispatch and reconciliation.

To batch-reconcile every running GitHub task:

```bash
node dist/src/index.js reconcile-github-running [timeout-sec] [interval-sec]
```

This loops over persisted tasks with:

- `state: "running"`
- `routing.mode: "github"`

and attempts the same wait-download-ingest flow per task.

## `codex-head-worker.yml`

File:
[`../../.github/workflows/codex-head-worker.yml`](../../.github/workflows/codex-head-worker.yml)

Current behavior:

- accepts `task_id`
- optionally accepts `payload_path`
- optionally accepts `payload_json`
- checks out the repo
- installs and builds `codex-head`
- materializes the payload into `runtime/worker-dispatch.json`
- executes `node dist/src/index.js run-github-payload`
- writes `runtime/artifacts/<task-id>/github-callback.json`
- uploads the callback artifact
- prefers inline `payload_json` when provided
- falls back to `payload_path` if the file exists in the runner checkout
- fails fast when neither transport is available

This is now a real typed execution path. It still depends on the runner having
the requested worker binary and a usable local template for that worker. When
those are missing, it still emits a valid `failed` callback artifact instead of
leaving the task hanging.

## `codex-head-gemini-review.yml`

File:
[`../../.github/workflows/codex-head-gemini-review.yml`](../../.github/workflows/codex-head-gemini-review.yml)

Current behavior:

- accepts workflow-dispatch inputs for task metadata, target repository, base
  branch, work branch, output, and prior status
- checks out the repo and installs `codex-head`
- builds a real branch diff between `base_branch` and `work_branch`
- runs remote review through one of:
  `REVIEW_API_URL` + `REVIEW_API_KEY` for an OpenAI-compatible endpoint,
  `OPENAI_API_KEY` for direct OpenAI usage, or `GEMINI_API_KEY` for Gemini
- writes `runtime/artifacts/<task-id>/github-callback.json`
- uploads that callback as a workflow artifact

These remote credentials are only for the GitHub runner. They do not reuse
local CLI login state or a local Antigravity-Manager proxy running on your
machine unless you deliberately expose that proxy with a runner-reachable URL.

This workflow is the current review-specific handoff path for GitHub review
work in `codex-head`.

When `github.review_workflow` is configured and a task's
`expected_output.kind === "review"`, `codex-head` selects this workflow for
live dispatch instead of the generic worker workflow.

## Callback JSON Expectations

The workflow currently writes a `WorkerResult`-shaped artifact with:

- `worker_target: "gemini-cli"`
- `status: "completed"`
- `review_verdict: "commented"`
- `artifacts` containing the callback file path
- `next_action: "review"`
- `review_notes` containing workflow context

If Gemini auth is missing or the Gemini action fails, the workflow still writes
`status: "completed"` with `review_verdict: "commented"` and an explanatory
fallback summary.

You can ingest it locally with:

```bash
node dist/src/index.js complete-from-file runtime/artifacts/<task-id>/github-callback.json
```

## Placeholder Vs Live Behavior

Implemented behavior:

- dispatch payload generation
- GitHub issue mirror publishing
- GitHub PR mirror publishing for branch/PR-oriented tasks
- opt-in live `gh workflow run` dispatch
- run-name-based workflow resolution into persisted `github_run` task state
- workflow files present in repo
- generic worker payload execution on the runner
- structured Gemini diff review when GitHub secrets are configured
- callback file generation
- callback artifact download and local ingestion through `gh`
- on-demand callback polling against the exact workflow run
- local callback ingestion
- routing persisted on the running task before callback completion

Placeholder behavior:

- automatic mirror refresh or deduplicated update flows
- automatic promotion from callback artifact to a live GitHub API review event

## Production Gaps

- No authenticated GitHub API orchestration beyond the current `gh`-backed
  mirror publishing and workflow dispatch
- No background callback reconciler or polling loop
- No production-grade secrets, governance, budget, or audit controls
