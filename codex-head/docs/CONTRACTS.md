# Codex Head Contracts

The source of truth for these contracts is:

- [`../src/contracts.ts`](../src/contracts.ts)
- [`../src/schema.ts`](../src/schema.ts)

## Enumerations

### Worker targets

- `claude-code`
- `codex-cli`
- `gemini-cli`
- `antigravity`

### Task states

- `planned`
- `queued`
- `running`
- `awaiting_review`
- `completed`
- `failed`
- `canceled`

### Output kinds

- `analysis`
- `patch`
- `pull_request`
- `review`
- `report`

### Output formats

- `json`
- `markdown`
- `patch`
- `text`

### Review provider profiles

- `standard`
- `research`
- `code_assist`

### Worker result statuses

- `running`
- `awaiting_review`
- `completed`
- `failed`
- `retryable`

### Review verdicts

- `approved`
- `changes_requested`
- `commented`

### Next actions

- `none`
- `review`
- `dispatch_github`
- `manual`
- `retry`

## TaskSpec

`TaskSpec` is the only task handoff contract from Codex Head to a worker.

| Field | Type | Meaning | Default from `createTaskSpec` |
|---|---|---|---|
| `task_id` | `string` | Stable task identifier | random UUID |
| `goal` | `string` | Human-readable task goal | required |
| `repo` | `string` | Repository or workspace root | required |
| `base_branch` | `string` | Branch used as base context | `main` |
| `work_branch` | `string` | Branch for code-producing work | `codex/<slug>-<id>` |
| `worker_target` | `WorkerTarget` | Requested primary worker | `codex-cli` |
| `allowed_tools` | `string[]` | Worker tool budget metadata | `["read","write","test"]` |
| `input_artifacts` | `string[]` | Upstream artifacts used as input | `[]` |
| `expected_output` | `ExpectedOutput` | Expected kind, format, and code-change flag | `{ kind: "analysis", format: "markdown", code_change: false }` |
| `review_profile` | `ReviewProviderProfile \| null` | Optional provider-strength hint for GitHub review workflows | `null` |
| `budget` | `BudgetSpec` | Budget and retry metadata | `{ max_cost_usd: 5, max_attempts: 3 }` |
| `timeout_sec` | `number` | Local execution timeout | `900` |
| `review_policy` | `ReviewPolicy` | Review routing metadata | `{ required_reviewers: [], require_all: true }` |
| `artifact_policy` | `ArtifactPolicy` | Artifact lineage policy | `patch_artifact` if code change, otherwise `local_artifact`; `require_lineage: true` |
| `priority` | `number` | Queue priority metadata | `50` |
| `requires_github` | `boolean` | Force GitHub-capable routing | `false` |

### Validation rules

- `goal`, `repo`, `task_id`, branch names, and `worker_target` must be
  non-empty.
- `allowed_tools`, `input_artifacts`, and reviewer lists must be string arrays.
- `expected_output.kind` and `expected_output.format` must be valid enum values.
- `review_profile`, when present, must be one of `standard`, `research`, or
  `code_assist`.
- `requires_github` must be explicit boolean data.

### Review policy note

`review_policy` is active behavior in the current internal-beta runtime:

- required reviewers can submit verdicts while the task is in
  `awaiting_review`
- `require_all` controls whether one approval is enough or every listed
  reviewer must approve
- any `changes_requested` verdict from a required reviewer fails the task
- review artifacts are persisted per reviewer

## WorkerResult

`WorkerResult` is the only completion contract from a worker back to Codex Head.

| Field | Type | Meaning |
|---|---|---|
| `task_id` | `string` | Must match the owning task |
| `worker_target` | `WorkerTarget` | Must match the actual routed adapter, or the reviewer during review aggregation |
| `status` | `WorkerResultStatus` | Completion state from the worker |
| `review_verdict` | `ReviewVerdict \| null` | Optional reviewer verdict when the result is acting as a review callback |
| `summary` | `string` | Short execution summary |
| `artifacts` | `string[]` | Paths to generated artifacts |
| `patch_ref` | `string \| null` | Patch or lineage artifact for code-changing work |
| `log_ref` | `string \| null` | Combined log path if available |
| `cost` | `number` | Cost metadata |
| `duration_ms` | `number` | Execution duration |
| `next_action` | `NextAction` | Suggested next step |
| `review_notes` | `string[]` | Review or diagnostic notes |

### Completion rules

- `task_id` must match the owning task.
- `worker_target` must match the actual routed adapter target.
- Code-changing tasks with required lineage must include `patch_ref`.
- `retryable` results are re-queued until `budget.max_attempts` is exhausted.

Important distinction:

- `TaskSpec.worker_target` is the requested primary target from planning.
- `WorkerResult.worker_target` is the adapter that actually executed after
  routing and fallback.

During review aggregation:

- `worker_target` identifies the reviewer that submitted the verdict
- `review_verdict` carries the approval, rejection, or comment-only outcome
- reviewer results are accepted only while the task is in `awaiting_review` and
  the reviewer appears in `review_policy.required_reviewers`

## AdapterCapability

`AdapterCapability` describes what a worker can do:

- `worker_target`
- `supports_local`
- `supports_github`
- `can_edit_code`
- `can_review`
- `can_run_tests`
- `max_concurrency`
- `required_binaries`
- `feature_flag`

This is the routing and policy surface. It is not the same thing as runtime
configuration.

## RoutingDecision

`RoutingDecision` records what the router actually chose:

- `worker_target`: the adapter that will execute
- `mode`: `local` or `github`
- `reason`: why the router chose it
- `fallback_from`: original requested target when the router had to fall back

## GitHubRunState

`GitHubRunState` is the persisted pointer to a live-dispatched workflow run:

- `run_id`
- `run_url`
- `workflow_name`
- `status`
- `conclusion`
- `updated_at`

This is populated when `gh workflow run` output includes a run URL or when
Codex Head can resolve the run through `gh run list`.

## GitHubMirrorState

`GitHubMirrorState` is the persisted pointer to published GitHub metadata:

- `issue`
- `pull_request`
- `issue_error`
- `pull_request_error`
- `updated_at`

Each published target reference contains:

- `number`
- `url`
- `title`

This is populated by `publish-github-mirror` and lets Codex Head remember the
created GitHub issue mirror and optional PR mirror for a task.

## TaskRecord

`TaskRecord` is the persisted queue view of a task:

- current `task`
- persisted `state`
- `attempts` and `max_attempts`
- `next_run_at`
- timestamps for creation, update, start, and finish
- `last_error`
- latest `result`
- latest `routing`
- latest `github_run`
- latest `github_mirror`
- accumulated `reviews`

`routing` is persisted as soon as dispatch begins so the running record shows
the actual resolved adapter even before completion.

`github_run` is persisted for live-dispatched GitHub tasks once Codex Head can
resolve a workflow run id. It is then reused by `sync-github-callback` and
`wait-github-callback` for deterministic callback reconciliation.

`github_mirror` is persisted when Codex Head publishes issue/PR metadata
through GitHub. It is reused to avoid losing published references across later
task operations.

Local runtime fallback attempts are not stored as a separate TypeScript
contract yet, but the execution audit is still materialized as
`execution-attempts.json` inside the task artifact directory.

Each `TaskReview` contains:

- `reviewer`
- `verdict`
- `summary`
- `review_notes`
- `artifacts`
- `source_status`
- `reviewed_at`

## Runtime Health Output

`health` returns two operational views:

- `adapters`: raw binary health per registered adapter
- `readiness`: whether an adapter is actually runnable for local or GitHub work

Each readiness entry includes:

- `worker_target`
- `healthy`
- `feature_enabled`
- `supports_local`
- `supports_github`
- `has_local_template`
- `local_ready`
- `github_ready`
- `github_worker_ready`
- `github_review_ready`
- `cooldown_until`
- `cooldown_reason`

`health` also returns `recent_penalties`, which is the current local penalty
summary Codex Head uses to deprioritize workers after recent quota, auth, or
timeout failures.

## TaskRuntimeContext

Local adapters receive a runtime object with:

- `task_file`
- `task_goal`
- `task_prompt`
- `artifact_dir`
- `github_payload`

`task_prompt` is the standardized subordinate-worker prompt that the default
local templates interpolate into `claude`, `codex`, and `gemini` CLI calls.

## State Transition Rules

The allowed queue transitions are enforced in the SQLite store:

- `planned` -> `queued`, `canceled`
- `queued` -> `running`, `canceled`
- `running` -> `queued`, `awaiting_review`, `completed`, `failed`, `canceled`
- `awaiting_review` -> `completed`, `failed`, `canceled`
- `failed` -> `queued`, `canceled`
- `completed` and `canceled` are terminal
