# Codex Head Operations

This is the day-to-day runbook for internal use.

## Prerequisites

- Node.js 22 or newer
- `npm`
- Optional worker binaries, depending on what you want to route:
  - `claude`
  - `codex`
  - `gemini`
  - `antigravity`

## Install And Build

```bash
cd codex-head
npm install
npm run build
```

## Health And Verification

```bash
npm test
npm run smoke
npm run health
```

What each command does:

- `npm test`: full TypeScript build plus the current test suite
- `npm run smoke`: adapter health-focused tests
- `npm run health`: runtime binary detection, adapter readiness, GitHub config,
  GitHub CLI/auth readiness, cooldown-aware local readiness, plus database and
  artifact paths
- the same snapshot now includes `local_stack`, which probes
  `9router -> Antigravity-Manager`, confirms whether the `agm` chat route is
  active, and records that the experimental `agr` responses route should not be
  treated as a native Responses endpoint for `codex-cli`
- when present, that same `local_stack` snapshot also reports optional local
  provider paths such as `pplxapp/*` for Perplexity and `bbxapp/*` for
  BLACKBOXAI
- it also exposes both the Antigravity-only helper command and the full-stack
  helper command, so operator tooling can bootstrap the review path or the
  entire local provider stack without guessing script names

## First Successful Run

The simplest successful first run is now a local analysis or report task.

```bash
cd codex-head
npm install
npm run health
node dist/src/index.js run-goal "Summarize the current orchestration state"
```

Why this path is recommended:

- it covers planning, persistence, queueing, dispatch, and result ingestion in
  one command
- the default config now ships safe local templates for `claude-code`,
  `codex-cli`, and `gemini-cli`
- it exercises the real local adapter execution path
- it still writes task and result artifacts
- it can automatically fall back to the next healthy local worker when the
  first worker fails at runtime
- it does not require GitHub CLI login because the default bootstrap is
  local-only

## CLI Commands

`codex-head` currently exposes the following commands through
[`src/index.ts`](../src/index.ts):

```bash
node dist/src/index.js health
node dist/src/index.js run-goal [--repo OWNER/REPO] [--dispatch-mode gh_cli|artifacts_only] [--timeout-sec N] [--interval-sec N] [--no-mirror] <goal>
node dist/src/index.js configure-github-repo <owner/repo> [dispatch-mode]
node dist/src/index.js plan <goal>
node dist/src/index.js enqueue <task-id>
node dist/src/index.js publish-github-mirror <task-id>
node dist/src/index.js review <task-id> <reviewer> <verdict> [summary]
node dist/src/index.js run-github-payload <payload-json>
node dist/src/index.js sync-github-callback <task-id>
node dist/src/index.js wait-github-callback <task-id> [timeout-sec] [interval-sec]
node dist/src/index.js reconcile-github-running [timeout-sec] [interval-sec] [--brief]
node dist/src/index.js recover-running [timeout-sec] [interval-sec] [--requeue-local] [--brief]
node dist/src/index.js status [task-id] [--brief]
node dist/src/index.js doctor [--brief] [--all-tasks] [--task-window-hours N]
node dist/src/index.js review-workflow-status [--brief]
node dist/src/index.js operator-history [--brief] [--limit N] [--command NAME] [--apply-only] [--dry-run-only]
node dist/src/index.js show-operator-receipt <receipt-path> [--brief]
node dist/src/index.js show-operator-receipt --latest [--command NAME] [--apply-only|--dry-run-only] [--brief]
node dist/src/index.js show-operator-receipt --task-id ID [--command NAME] [--apply-only|--dry-run-only] [--brief]
node dist/src/index.js run-doctor-hint <hint-id> [--apply] [--brief] [--all-tasks] [--task-window-hours N]
node dist/src/index.js run-doctor-hints [--kind KIND] [--limit N] [--apply] [--allow-multi-task-apply] [--brief] [--all-tasks] [--task-window-hours N]
node dist/src/index.js sweep-tasks <cancel|requeue> [--state a,b] [--older-than-hours N] [--goal-contains TEXT] [--worker-target TARGET] [--task-id ID] [--limit N] [--all] [--dry-run] [--brief]
node dist/src/index.js dispatch <task-id>
node dist/src/index.js dispatch-and-wait <task-id> [timeout-sec] [interval-sec]
node dist/src/index.js dispatch-next
node dist/src/index.js clear-penalties [worker-target|all]
node dist/src/index.js complete-from-file <worker-result.json>
```

### Suggested command flow

1. Run `health` to confirm binaries, GitHub readiness, and runtime paths.
2. Run `run-goal` for the normal operator path.
3. Add `--repo OWNER/REPO` when the goal needs GitHub and the repo is not
   already configured or auto-detected.
4. Use `configure-github-repo` when you want to persist that repo into
   `config/workers.local.json` for future runs.
5. Use `plan`, `enqueue`, `dispatch`, and `dispatch-next` only when you want
   manual inspection or deterministic step-by-step control.
6. Use `publish-github-mirror` when you want Codex Head to create or persist
   the task's GitHub issue mirror and optional PR mirror independently of
   `run-goal`.
7. Use `dispatch-and-wait` when a queued GitHub task should be dispatched and
   reconciled in one command without replanning it.
8. Use `run-github-payload` inside GitHub workflows to execute a materialized
   dispatch payload and emit a typed callback artifact.
9. Run `sync-github-callback` after a GitHub workflow finishes when you want
   Codex Head to download the matching callback artifact and ingest it locally.
10. Run `wait-github-callback` when live dispatch resolved a workflow run and you
    want Codex Head to poll that exact run to completion before ingesting the
    callback.
11. Run `reconcile-github-running` when you want to batch-process every
    currently running GitHub task.
12. Run `recover-running` when a previous operator session or CLI process was
    interrupted and tasks are stuck in `running`.
13. Run `review` to submit a reviewer verdict for a task that is already in
    `awaiting_review`.
14. Run `doctor` when you want one read-only triage surface that combines
    worker health, self-hosted GitHub runtime, and task/operator guidance.
15. Run `review-workflow-status` when you want the focused local-vs-remote
    view of the GitHub review workflow shape and whether live `review_profile`
    routing is currently degraded.
16. Run `sweep-tasks` when you want to bulk-cancel stale backlog or requeue a
    filtered set of planned/failed tasks without touching task history.
17. Run `run-doctor-hint` when you want to execute one of `doctor`'s
    structured dry-run sweep suggestions without copying the command by hand.
18. Run `run-doctor-hints` when you want to batch the currently visible doctor
    hints by `kind` or `limit` while staying in dry-run mode by default.
19. Run `operator-history` when you want a read-only audit trail of recent
    sweep and doctor-hint actions under `runtime/artifacts/operator-actions/`.
20. Run `show-operator-receipt` when you want to inspect one specific receipt
    from that history in more detail, either by explicit path or by resolving
    the newest matching receipt for a task/filter.
21. Run `clear-penalties` when a local provider recovered and you want to stop
    honoring remembered cooldowns immediately.
22. Run `complete-from-file` to ingest an external callback artifact such as
    `github-callback.json`.

`status [task-id]` now returns an enriched JSON snapshot. For GitHub queue
problems, look under `operator` for:

- `queue_diagnosis_path`
- `queue_diagnosis`
- `queue_recycle_path`
- `queue_recycle`
- `manual_intervention_required`
- `summary`
- `actions`

The same `operator` block is now also returned by `recover-running` and
`reconcile-github-running`, so operator tooling can consume one shape across
status, recovery, and batch reconciliation.
If you only need the short human-facing triage view, all three commands now
also accept `--brief`.

`doctor` builds on those same snapshots plus `npm run health`-style runtime
inspection. The JSON form keeps the full `health` payload and categorized
attention lists for workers, GitHub/runtime, integrations, and tasks. `doctor --brief`
renders the same report as a short checklist when you only need the operator
summary and next actions.

`review-workflow-status --brief` is the focused companion for one specific
GitHub drift case: it compares the local
`.github/workflows/codex-head-gemini-review.yml` file with the remote workflow
visible through `gh workflow view ... --yaml`, tells you whether each side
supports `review_profile`, shows the current branch plus how that workflow file
relates to `origin/main`, and prints the exact inspect/sync guidance plus any
safe git commands for that workflow.

By default, `doctor` highlights active tasks plus recent failures and suppresses
older failed backlog into summary counts so the operator view stays current.
Use `--all-tasks` to include the full backlog, or `--task-window-hours N` to
change the recency window used for failed-task triage.
It now also emits dry-run `sweep-tasks` command hints for queued backlog and
suppressed failed backlog, so the report can point straight at the next safe
operator command instead of only describing the problem.

`run-doctor-hint` is the safest way to follow those suggestions:

- `run-doctor-hint <hint-id> --brief` keeps the hint in dry-run mode
- `run-doctor-hint <hint-id> --apply --brief` executes the same structured
  sweep payload for real
- it never shells out through the hint's preview string; it reuses the
  structured sweep payload from the current doctor report

`run-doctor-hints` extends that same flow to the whole visible report:

- `run-doctor-hints --brief` dry-runs every current hint in report order
- `run-doctor-hints --kind queued_backlog --limit 2 --brief` dry-runs only the
  first two visible queued backlog hints
- `run-doctor-hints --kind suppressed_failed_backlog --apply --brief` applies
  the matching backlog sweep for real
- if the preview would mutate more than one task, `--apply` now requires
  `--allow-multi-task-apply` as an explicit batch guard
- it still rebuilds the doctor report first and only executes each hint's
  structured sweep payload
- every `sweep-tasks`, `run-doctor-hint`, and `run-doctor-hints` invocation
  now writes one JSON receipt under `runtime/artifacts/operator-actions/`
  so operator cleanup history is easy to audit later

`operator-history` is the lightweight way to read those receipts back:

- `operator-history --brief` shows the newest 10 receipts
- `operator-history --command run-doctor-hints --brief` narrows to one action
- `operator-history --apply-only --brief` shows only real state-changing runs
- `operator-history --dry-run-only --brief` shows only previews

`show-operator-receipt` complements that history view:

- `show-operator-receipt operator-actions/...json --brief` prints a compact
  summary with selection, hints, and task effects
- `show-operator-receipt --latest --brief` resolves the newest receipt without
  copying the path out of history first
- `show-operator-receipt --task-id TASK_ID --brief` resolves the newest receipt
  that touched that task
- `show-operator-receipt --task-id TASK_ID --command sweep-tasks --brief`
  narrows that lookup to one operator command type
- omitting `--brief` returns the stored JSON receipt verbatim

`status --brief` and `doctor --brief` now surface the newest matching operator
receipt path for a task when one exists, so operators can jump directly into
`show-operator-receipt` without listing history first.
- `status --brief` prints `open-receipt: node dist/src/index.js show-operator-receipt ... --brief`
- `status --brief` also prints `artifacts: ...` plus canonical refs like
  `worker-result: ...`, `attempts: ...`, `output: ...`, and `log: ...` when
  those paths are known
- retained refs from an older attempt are labeled `(... last-attempt ...)`,
  while retry history stays labeled `(... history ...)`
- `status --brief` prints `github-url: ...` when the task has a persisted
  workflow run URL
- `status --brief` hides `operator: no immediate action` when the task already
  has an operator receipt to open, and surfaces that jump as `next-command:`
- `doctor --brief` adds a `receipt-commands:` section for task-level receipt jumps
- `doctor --brief` also adds a `task-links:` section only for the visible task
  rows that already have a receipt, GitHub run URL, or other stronger triage
  signals, so `artifacts=...` and `github=...` pointers stay high-signal
- routine queued/running backlog rows with the same goal and summary may
  collapse into a single `N similar task(s)` line to keep brief mode compact
- `doctor --brief` also adds an `artifact-files:` section only for the higher-
  signal visible task rows when `worker-result.json`,
  `execution-attempts.json`, primary output, or the primary log can be resolved
- when queued backlog command hints are present, `next:` keeps the higher-signal
  actions and omits the redundant generic dispatch reminder
- `doctor --brief`, `operator-history --brief`, and `show-operator-receipt --brief`
  also expose a standardized `next-command:` line for the safest follow-up
  command available
- `doctor --brief` now also prints a `local-stack:` line that summarizes the
  current `9router -> Antigravity-Manager` readiness on the machine
- those artifact refs now include freshness labels so queued/running tasks do
  not present stale output as if it were the current attempt

`sweep-tasks` is intentionally conservative:

- it never deletes task rows from SQLite
- it supports `--dry-run` before making changes
- `cancel` defaults to `planned,queued,failed`
- `requeue` defaults to `failed,planned`
- you must provide a narrowing filter such as `--state`, `--goal-contains`,
  `--worker-target`, `--task-id`, `--older-than-hours`, or explicitly opt into
  broad matching with `--all`

## Runtime Paths

Defaults come from [`src/config.ts`](../src/config.ts):

- SQLite database:
  `codex-head/runtime/codex-head.sqlite`
- Artifact root:
  `codex-head/runtime/artifacts/`
- Methodology references:
  - `cli-anything-plugin/HARNESS.md`
  - `codex-skill/SKILL.md`

Each task gets its own artifact directory:

`codex-head/runtime/artifacts/<task-id>/`

Common files include:

- `task-spec.json`
- `task-input.json`
- `routing-decision.json`
- `execution-attempts.json`
- `worker-result.json`
- `dispatch-outcome.json`
- `github-dispatch.json`
- `github-worker-inputs.json`
- `github-callback.json`
- `github-callback-download.json`
- `github-dispatch-receipt.json`
- `github-run-view.json`
- `github-mirror-receipt.json`
- `github-issue.md`
- `github-pr.md`
- `review-<reviewer>.json`
- `*.stdout.log`
- `*.stderr.log`
- `*.combined.log`

## Local Execution Configuration

The default config now provides safe local execution templates for:

- `claude-code`
- `codex-cli`
- `gemini-cli`

Those defaults use non-interactive read-only or plan-style flags so the worker
returns artifact content instead of mutating the repository directly.

The default `gemini-cli` template now pins `-m gemini-2.5-flash`. In local
testing, that model has been materially more reliable for headless runs than
leaving Gemini on its account-level default or auto-selected premium model.

Local command templates also accept an optional `env` map. `codex-head` merges
those values into the spawned worker environment after template interpolation.

Create `config/workers.local.json` from
[`config/workers.example.json`](../config/workers.example.json) when you want
to override that behavior. Keep machine-only secrets and absolute paths in
`config/workers.machine.json`; the loader merges that file after
`workers.local.json`.

If you override `gemini-cli`, prefer keeping an explicit `-m` value in the
local template so headless runs do not silently drift to a quota-exhausted
default model.

For Antigravity-Manager, the practical local-only pattern is:

- keep the proxy service on `http://127.0.0.1:8045`
- point `codex-cli` at a repo-local `CODEX_HOME` whose `config.toml` uses a
  custom provider with `wire_api = "responses"` and `base_url =
  "http://<reachable-host>:8045/v1"`
- inject `ANTHROPIC_BASE_URL=http://127.0.0.1:8045` for `claude-code`
- point `gemini-cli` at a repo-local home whose `.gemini/settings.json`
  selects `gemini-api-key`, then inject
  `GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8045`
- pass the manager API key through the matching worker env vars instead of
  rewriting your global CLI setup
- if a worker should remain available only for GitHub dispatch on this machine,
  set `command_templates.<worker>.local` to `null` in
  `config/workers.machine.json`; `doctor` treats that as an intentional
  GitHub-only posture

If you also want a local front router in front of Antigravity-Manager, use:

```powershell
pwsh -File .\scripts\ensure-9router-antigravity-stack.ps1
```

That helper:

- starts `antigravity_tools --headless` on `127.0.0.1:8045` when needed
- starts `9router` on `127.0.0.1:20128` when needed
- ensures `agm/*` chat routing to Antigravity-Manager inside `9router`
- ensures an experimental `agr/*` responses route for translator testing
- removes stale duplicate 9router nodes and connections for the managed `agm/*`
  and `agr/*` prefixes
- prints the recommended GitHub review secrets for the self-hosted runner

For GitHub review on the same Windows host, the recommended route is now:

- `REVIEW_API_URL=http://127.0.0.1:20128/v1`
- `REVIEW_API_KEY=local-9router`
- `REVIEW_MODEL=agm/gpt-4o-mini`

Planner-driven review now also carries a `review_profile` so the local provider
stack is used by strength instead of forcing one model for every review:

- `standard` -> `agm/gpt-4o-mini` by default for balanced repository review
  and triage through Antigravity
- `research` -> `pplxapp/app-chat` by default for citation-heavy review,
  current docs, releases, and dependency context through Perplexity
- `code_assist` -> `bbxapp/app-agent` by default for snippet-oriented feedback,
  API usage ideas, and implementation help through BLACKBOXAI

If you need different aliases, set these GitHub Secrets on the control repo:

- `REVIEW_MODEL_STANDARD`
- `REVIEW_MODEL_RESEARCH`
- `REVIEW_MODEL_CODE_ASSIST`

A single generic `REVIEW_MODEL` is still supported, but it now behaves as a
fallback so the profile-specific routing above can keep using the right local
provider by default.

Operationally, the current stack is intended to be used like this:

- `codex-cli` for primary local repo execution, patches, and stable artifacts
- `gemini-cli` for GitHub review orchestration and lightweight review fallback
- `agm/*` for balanced review and general-purpose remote triage
- `pplxapp/*` for release notes, docs, citations, dependency context, and other
  current-information review
- `bbxapp/*` for snippet-heavy review, API usage ideas, and code-assist style
  feedback

`doctor` also validates the remote review workflow shape. If the GitHub default
branch is still serving an older `codex-head-gemini-review.yml` without the
`review_profile` input, `doctor` raises a GitHub warning and live dispatch
automatically retries without that input, which keeps review dispatch working
but falls back to legacy standard routing until the workflow is synced.

That stack has been verified end-to-end through
`codex-head-gemini-review.yml` on the self-hosted runner.

If you also want to add the Perplexity desktop app to the same `9router`, use:

```powershell
pwsh -File .\codex-head\scripts\ensure-9router-perplexity-stack.ps1
```

That helper:

- starts Perplexity with `--remote-debugging-port=9233` when needed
- starts the local Perplexity runtime manager on `127.0.0.1:20129`
- ensures `pplxapp/*` chat routing to the runtime manager inside `9router`
- removes stale duplicate 9router nodes and connections for the managed
  `pplxapp/*` route
- normalizes trailing citation markers in live probe completions and waits for
  the runtime manager plus CDP target to settle after restart
- verifies the route with a live `chat/completions` probe that uses
  `app-health`, not the main `app-chat` session

The runtime-manager path is intentionally conservative:

- it exposes `GET /health`, `GET /v1/models`, `GET /sessions`,
  `POST /session/reset`, and `POST /v1/chat/completions`
- it does not support streaming
- it serializes requests because it executes authenticated runtime `SSE ask`
  calls inside the Perplexity app session
- it persists session state in
  `codex-head/runtime/perplexity-manager-sessions.json`
- it reuses one stable Perplexity thread per session key instead of spawning a
  fresh thread for every request
- `app-chat` is the main reusable session and `app-health` is reserved for
  isolated health/bootstrap probes
- old Perplexity History rows created before this change remain in the app,
  but new manager traffic should now stay within one reusable `chat` thread
  plus one reusable `health` thread
- it no longer types, clicks, or waits on rendered answer blocks in the UI

If you also want to add a no-UI BLACKBOXAI account-manager path to the same
`9router`, use:

```powershell
pwsh -File .\codex-head\scripts\ensure-9router-blackbox-stack.ps1
```

That helper:

- starts the local BLACKBOXAI account manager on `127.0.0.1:8083`
- reads the local BLACKBOXAI identity from `state.vscdb`
- ensures `bbxapp/*` chat routing to that account manager inside `9router`
- removes stale duplicate 9router nodes and connections for the managed
  `bbxapp/*` route
- verifies the route with a live `chat/completions` probe

The BLACKBOXAI account-manager path is intentionally conservative:

- it exposes `GET /health`, `GET /v1/models`, and `POST /v1/chat/completions`
- it does not support streaming
- it keeps the local identity discovery on the operator machine
- it proxies directly to the BLACKBOX backend instead of driving the desktop UI

If you want to warm the entire local stack in one operator command, use:

```powershell
pwsh -File .\codex-head\scripts\ensure-9router-full-stack.ps1
```

That helper:

- runs the Antigravity, Perplexity, and BLACKBOX bootstrap helpers in order
- keeps `9router` warm while those routes are seeded
- returns a compact JSON summary for `agm`, `pplxapp`, and `bbxapp`
- inherits the duplicate-route cleanup behavior from the managed helpers

For WSL-backed `codex-cli`, `127.0.0.1` may still resolve inside Linux instead
of the Windows host. In that case, use the Windows-side WSL vEthernet address
that is reachable from Linux, for example `172.31.64.1`, and make sure Windows
Firewall allows inbound TCP `8045` for the running `antigravity_tools.exe`
process from the WSL subnet.

The config loader expects snake_case keys:

- `feature_flags`
- `command_templates`
- `github.review_workflow`
- `github.dispatch_mode`
- `github.cli_binary`

It also accepts the older camelCase aliases:

- `featureFlags`
- `commandTemplates`

Use `CODEX_HEAD_CONFIG` if you want to point to a different config file:

```bash
set CODEX_HEAD_CONFIG=C:\path\to\workers.local.json
```

GitHub is disabled by default. To enable live workflow dispatch, set:

- `github.enabled` to `true`
- `github.repository` to a real `OWNER/REPO`
- `github.dispatch_mode` to `gh_cli`
- `github.cli_binary` if `gh` is not on the default path
- `github.execution_preference` to:
  - `remote_only` if GitHub-shaped tasks must execute on GitHub
  - `local_preferred` if GitHub should stay as mirror/control plane while
    execution prefers local workers and only falls back to GitHub when local
    execution is unavailable

`github.repository` is resolved in this order:

- explicit config override
- `GITHUB_REPOSITORY` from the environment
- `git remote get-url origin` when it parses to GitHub
- fallback placeholder `OWNER/REPO`

`github.review_workflow` is optional. When set, review tasks use that workflow
instead of the generic worker workflow.

In `local_preferred` mode, `run-goal` can still publish GitHub mirrors for a
GitHub-shaped task, but `dispatch-next` first exhausts the healthy local worker
chain. If that local chain fails, routing can still fall through into GitHub
workflow dispatch for the same task.

To validate a repo with `gh` and write the override automatically:

```bash
node dist/src/index.js configure-github-repo OWNER/REPO [dispatch-mode]
```

This command:

- validates GitHub CLI auth
- verifies repository access through `gh repo view`
- writes the chosen repository into `config/workers.local.json`
- defaults `dispatch_mode` to `gh_cli` unless you pass `artifacts_only`

`run-goal` can also auto-upgrade a GitHub-capable run to live `gh_cli`
dispatch for that execution when:

- a real `github.repository` is already present or passed through `--repo`
- `gh auth status` succeeds
- you did not explicitly force `--dispatch-mode artifacts_only`

When `github.enabled` is `false`, planner-generated GitHub, PR, issue,
workflow, and research goals stay local. In that mode,
`run-goal "Review the latest PR in GitHub"` becomes a local review task
instead of a remote Actions dispatch, and `research` goals avoid the disabled
`antigravity` worker unless you explicitly enable that feature flag.

In the same local-only mode, `summarize`, `report`, and similar non-code goals
stay typed as `analysis` instead of `review`, so the fallback chain can still
reach `claude-code` when `gemini-cli` or `codex-cli` are temporarily cooled
down.

The older `codex-head.config.example.json` file has been removed. Use
[`config/workers.example.json`](../config/workers.example.json) as the only
maintained example config.

Supported template variables are interpolated by
[`src/adapter-registry/commandPolicy.ts`](../src/adapter-registry/commandPolicy.ts):

- `{{task_file}}`
- `{{task_goal}}`
- `{{task_prompt}}`
- `{{artifact_dir}}`
- `{{github_payload}}`

The same variables are available inside `command_templates.<worker>.<mode>.env`
values.

If you point `codex-cli` at a proxy-backed provider through Codex CLI config
overrides, the endpoint must expose the OpenAI Responses API at
`/v1/responses`. Codex CLI no longer supports `wire_api = "chat"`, so a local
gateway that only offers `/v1/chat/completions` can still look healthy at the
models endpoint while every real execution fails at runtime.

`9router` is already useful for the GitHub review workflow because that
workflow falls back from `/v1/responses` to `/v1/chat/completions`.
However, under the current Antigravity-backed setup, `9router` still returns
completion-shaped payloads on its `/v1/responses` route, so it should not yet
replace a native Responses-compatible endpoint for `codex-cli` local execution.

For the GitHub review workflow, the easiest no-public-endpoint path is now a
self-hosted runner on the same Windows machine. Use
[`../scripts/setup-self-hosted-runner.ps1`](../scripts/setup-self-hosted-runner.ps1)
to register the runner, set `CODEX_HEAD_RUNS_ON_JSON`, and optionally wire
`REVIEW_API_URL` plus `REVIEW_API_KEY` straight to a local
Antigravity-Manager instance such as `http://127.0.0.1:8045/v1`.
If `config/workers.machine.json` exists beside that bootstrap script, the same
setup now exports `CODEX_HEAD_MACHINE_CONFIG` for the runner user so GitHub
worker executions can reuse machine-local worker overrides even though the
checkout under `_work` is cleaned on every run.
That review workflow now tries `/v1/responses` first and falls back to
`/v1/chat/completions`, so proxies that expose either shape can be used.
If the downloaded Windows runner package omits `svc.cmd`, the bootstrap helper
now completes registration and installs a per-user scheduled-task fallback by
default. That keeps the runner coming back after logon even when the upstream
runner package ships no native service wrapper.
The same helper now also sets
`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` for the current user so the
self-hosted runner opts into the newer JavaScript action runtime.
If you need to recycle that runner later, use
[`../scripts/recycle-self-hosted-runner.ps1`](../scripts/recycle-self-hosted-runner.ps1)
to stop the listener, wait for the stale broker session to clear, and then
bring the runner back online without triggering an avoidable session conflict.

## Common Failure Cases

Run `npm run health` first when GitHub dispatches stall. The health snapshot now
includes:

- the resolved `CODEX_HEAD_RUNS_ON_JSON` label array
- matching self-hosted runner records and their `online` / `busy` state
- whether `workers.machine.json` is visible through the current machine overlay
- the usual local worker readiness and cooldown state

If a GitHub run stays `queued` against a self-hosted label set for too long,
`codex-head` now writes `github-queue-diagnosis.json` into the task artifact
directory and raises a more specific error when it looks like no matching
runner is available or a stale broker session is blocking pickup.
The same diagnosis file is now referenced by `wait-github-callback`,
`sync-github-callback`, and `recover-running` when callback ingestion fails
while the run is still queued.
If you want `codex-head` to attempt a controlled runner bounce automatically for
the stale-broker-session case, opt in with:

```json
{
  "github": {
    "auto_recycle_stale_runner": true
  }
}
```

Set that in `config/workers.machine.json` on the Windows runner host. The
automatic recycle path only runs for the specific "runner looks online and idle
but the job is still queued" case, and it writes `github-queue-recycle.json`
beside the diagnosis artifact.
If the run is still queued after that automatic recycle succeeds, later wait or
sync failures now escalate explicitly to "manual intervention required" and
point back to the recycle receipt.

### `missing_binary`

- Cause: `npm run health` can find no installed binary for the worker.
- Fix: install the CLI binary or disable that worker in config.

### Healthy binary but local execution still fails

- Cause: `health` proves binary presence and template availability, but it does
  not prove the upstream CLI is authenticated or otherwise ready to serve.
- Current behavior: `codex-head` now tries the next healthy local fallback
  worker before failing the task.
- Fix: verify the workers' own login states, then inspect
  `execution-attempts.json` and the combined task logs for the exact failure
  text if every candidate fails.

### `codex-cli` works directly but not through a local proxy

- Cause: the proxy only exposes `/v1/chat/completions`, while Codex CLI now
  expects the OpenAI Responses API at `/v1/responses` and may also probe the
  websocket transport on that path first.
- Symptom: task logs show repeated reconnect attempts to `/v1/responses`,
  transport errors, or a final `stream disconnected before completion`.
- Fix: use a Responses-compatible proxy, or keep `codex-cli` on direct auth
  until your local gateway speaks `/v1/responses`.

### Windows `codex` resolves to WSL, but the switcher manages Windows auth

- Cause: the visible `codex` command is a Windows wrapper that forwards into
  `wsl.exe`, while your account switcher only updates `C:\\Users\\<you>\\.codex`.
- Symptom: `codex-head` detects `codex-cli`, but real runs still use the wrong
  profile or keep hitting the direct account usage limit.
- Fix: override `command_templates.codex-cli.local` to call `wsl.exe`
  directly and add:
  - `WSLENV=CODEX_HOME/p`
  - `CODEX_HOME=C:\\Users\\<you>\\.codex`
- Reason: the `/p` flag in `WSLENV` converts the Windows path into a Linux
  mount path before WSL launches `codex`, so the child process reads the same
  auth directory as the Windows-side switcher.

### Worker is healthy but temporarily cooled down

- Cause: a recent local run hit a provider quota, auth failure, or timeout.
- Current behavior: `health` marks that worker as not `local_ready`,
  surfaces `cooldown_until` plus `cooldown_reason`, and the router
  deprioritizes it for later tasks.
- Fix: inspect the cooldown reason, wait for the reset window, or switch to a
  different local provider.

To manually clear remembered cooldowns after you fix the provider:

```bash
node dist/src/index.js clear-penalties all
node dist/src/index.js clear-penalties gemini-cli
```

### Local-only mode still chooses a weak worker first

- Cause: older plans or manual task specs may still point at a worker that is
  currently less stable on your machine.
- Current behavior: when GitHub is disabled, planner and fallback order now
  keep those tasks local, avoid disabled `antigravity`, and deprioritize
  recently penalized workers before retrying them.
- Fix: rerun the goal through `run-goal` so the current local-only planner and
  router can choose a better worker chain.

### `No local command template is configured`

- Cause: the adapter config explicitly removed or overrode the default local
  template.
- Fix: restore the default template or add a custom local template in
  `workers.local.json`.

### `No GitHub-capable adapter is available`

- Cause: a task requires GitHub, but no healthy adapter supports GitHub mode.
- Fix: make sure `gemini-cli` is enabled and healthy, and keep `github.enabled`
  set to `true`.

### GitHub-shaped tasks always dispatch remotely even though local workers are healthy

- Cause: `github.execution_preference` is still `remote_only`.
- Fix: set `github.execution_preference` to `local_preferred` so GitHub stays
  available for mirrors and remote fallback, but local workers get first claim
  on execution.

### Generic worker workflow returns a typed `failed` callback

- Cause: the GitHub runner executed `run-github-payload`, but the requested
  worker binary or its local template was unavailable in the runner
  environment.
- Fix: install the needed worker binary on the runner and provide a usable
  `command_templates.<worker>.local` config for GitHub execution.

### `GitHub live dispatch requires gh authentication`

- Cause: `github.dispatch_mode` is set to `gh_cli`, but `gh auth status` is not
  authenticated.
- Fix: run `gh auth login` before dispatching live GitHub tasks.

### `GitHub live dispatch requires github.repository to be configured`

- Cause: `github.dispatch_mode` is set to `gh_cli`, but config still uses the
  placeholder `OWNER/REPO`.
- Fix: set `github.repository` to the real target repository.

### `Retry budget exhausted`

- Cause: a worker kept returning `retryable` after reaching
  `budget.max_attempts`.
- Fix: inspect the combined log artifact, increase retry budget if justified, or
  correct the underlying worker or template issue.

### `table tasks has no column named state`

- Cause: an older internal-beta SQLite file is still present in `runtime/` from
  a previous schema version.
- Current behavior: the task store automatically renames the incompatible
  `tasks` table to `tasks_legacy_<timestamp>` and recreates the current schema.
- Manual cleanup is only needed if you want to remove the archived legacy table.

### Node SQLite experimental warning

- Cause: the project uses `node:sqlite`.
- Impact: this is expected in the current internal-beta runtime.

## Review Aggregation

To record a manual reviewer verdict for an awaiting-review task:

```bash
node dist/src/index.js review <task-id> codex-cli approved "Local review approved"
```

Valid reviewers are the worker targets:

- `claude-code`
- `codex-cli`
- `gemini-cli`
- `antigravity`

Valid verdicts are:

- `approved`
- `changes_requested`
- `commented`

Review submission only works when:

- the task is already in `awaiting_review`
- the reviewer is listed in `review_policy.required_reviewers`

`review` writes `review-<reviewer>.json` into the task artifact directory and
either keeps the task in `awaiting_review`, completes it, or fails it depending
on the aggregate review state.

## GitHub Mirror Publishing

To publish the task's GitHub mirror metadata:

```bash
node dist/src/index.js publish-github-mirror <task-id>
```

This command:

- ensures `github-issue.md` and `github-pr.md` artifacts exist for the task
- creates a GitHub issue mirror through `gh issue create`
- optionally creates a draft PR mirror through `gh pr create` when the task is
  branch/PR oriented
- stores the result in `github-mirror-receipt.json`
- persists the created issue/PR references into the task's `github_mirror`
  state

PR mirror creation is best-effort. It only runs when the task indicates
branch/PR lineage, and it can still fail if the remote branch does not exist in
the target repository yet.

## Callback Ingestion

To download a matching workflow artifact from GitHub and ingest it directly:

```bash
node dist/src/index.js sync-github-callback <task-id>
```

This command:

- uses `gh run download` against the configured `github.repository`
- prefers the persisted `github_run.run_id` when one is known
- looks for `codex-head-worker-callback-<task-id>` or
  `codex-head-github-callback-<task-id>`
- downloads the artifact into the task runtime directory
- locates `github-callback.json`
- feeds that callback through the normal `complete-from-file` path

It is the recommended operator path once live GitHub workflows are enabled.

To wait for the resolved workflow run, then download and ingest its callback:

```bash
node dist/src/index.js wait-github-callback <task-id> [timeout-sec] [interval-sec]
```

This command:

- resolves or reuses the task's persisted `github_run`
- polls `gh run view <run-id>` until the run completes
- records the latest run status in the task store
- downloads callback artifacts from that exact run
- ingests the resulting `github-callback.json`

Use this when you want deterministic reconciliation for a live-dispatched
workflow run instead of a best-effort artifact sync.

To dispatch a queued GitHub task and wait for its callback in one command:

```bash
node dist/src/index.js dispatch-and-wait <task-id> [timeout-sec] [interval-sec]
```

This command:

- dispatches the specific queued task
- returns immediately for local work
- waits on the resolved GitHub workflow run for GitHub-routed work
- downloads and ingests the callback when the run completes

To batch-reconcile all currently running GitHub tasks:

```bash
node dist/src/index.js reconcile-github-running [timeout-sec] [interval-sec]
```

This command:

- lists tasks in state `running`
- filters to tasks whose persisted routing mode is `github`
- waits and ingests callbacks task-by-task
- returns a per-task summary with either `reconciled` or `error`
- includes the same `operator` guidance block used by `status` and
  `recover-running`
- supports `--brief` for a short plain-text reconcile summary

To recover tasks left behind in `running` state after an interrupted local
session:

```bash
node dist/src/index.js recover-running [timeout-sec] [interval-sec] [--requeue-local]
```

This command:

- reconciles GitHub-routed tasks the same way as `reconcile-github-running`
- marks interrupted local tasks as `failed` by default
- optionally requeues interrupted local tasks when `--requeue-local` is set
- returns the same `operator` guidance block used by `status`, including
  queue-artifact summaries and recommended follow-up actions when recovery fails
- supports `--brief` for a short plain-text recovery summary
- writes `recovery-result.json` for each recovered local task

## Direct Callback Ingestion

To ingest a saved worker callback:

```bash
node dist/src/index.js complete-from-file runtime/artifacts/<task-id>/github-callback.json
```

This validates the callback as a `WorkerResult`, enforces task lineage rules,
updates the stored task record, and also participates in review aggregation
when the callback comes from a required reviewer.
