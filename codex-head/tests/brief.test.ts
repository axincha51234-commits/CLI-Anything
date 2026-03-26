import test from "node:test";
import assert from "node:assert/strict";

import {
  renderDoctorBrief,
  renderOperatorReceiptBrief,
  renderOperatorHistoryBrief,
  renderOutcomeBrief,
  renderReviewWorkflowStatusBrief,
  renderRunDoctorHintsBrief,
  renderStatusBrief,
  renderSweepBrief
} from "../src/brief";
import type { DoctorReport } from "../src/doctor";
import type { OperatorHistoryResult, OperatorReceiptResult, SweepTasksResult } from "../src/orchestrator";
import { createTaskSpec } from "../src/schema";
import type { TaskStatusSnapshot } from "../src/status";

function createBriefLocalStack(overrides: Partial<DoctorReport["health"]["local_stack"]> = {}): DoctorReport["health"]["local_stack"] {
  return {
    detected: true,
    helper_script_path: "C:/repo/codex-head/scripts/ensure-9router-antigravity-stack.ps1",
    helper_script_available: true,
    helper_bootstrap_command: "powershell -ExecutionPolicy Bypass -File \"C:/repo/codex-head/scripts/ensure-9router-antigravity-stack.ps1\"",
    full_stack_helper_script_path: "C:/repo/codex-head/scripts/ensure-9router-full-stack.ps1",
    full_stack_helper_script_available: true,
    full_stack_bootstrap_command: "powershell -ExecutionPolicy Bypass -File \"C:/repo/codex-head/scripts/ensure-9router-full-stack.ps1\"",
    gui_config_path: "C:/Users/test/.antigravity_tools/gui_config.json",
    gui_config_exists: true,
    recommended_review_path_ready: true,
    antigravity: {
      base_url: "http://127.0.0.1:8045",
      port: 8045,
      reachable: true,
      version: "4.1.21",
      auto_start: true,
      auto_launch: false,
      auth_mode: "all_except_health",
      api_key_configured: true,
      proxy_status_available: true,
      running: true,
      active_accounts: 7
    },
    router9: {
      base_url: "http://127.0.0.1:20128",
      reachable: true,
      version: "0.3.60",
      agm_chat: {
        prefix: "agm",
        api_type: "chat",
        present: true,
        active_connection: true,
        default_model: "agm/gpt-4o-mini",
        upstream_base_url: "http://127.0.0.1:8045/v1"
      },
      agr_responses: {
        prefix: "agr",
        api_type: "responses",
        present: true,
        active_connection: true,
        default_model: "agr/gpt-4o-mini",
        upstream_base_url: "http://127.0.0.1:8045/v1"
      },
      responses_route_suitable_for_codex_cli_local: false
    },
    ...overrides
  };
}

test("renderDoctorBrief summarizes optional Perplexity and BLACKBOX managers", () => {
  const rendered = renderDoctorBrief({
    ok: true,
    generated_at: "2026-03-25T00:00:00.000Z",
    summary: "No blocking issues found across 3 task(s) and 2 enabled worker(s).",
    health: {
      adapters: [],
      readiness: [],
      recent_penalties: [],
      github: {
        enabled: true,
        dispatch_mode: "gh_cli",
        execution_preference: "local_preferred",
        auto_recycle_stale_runner: false,
        repository: "example/repo",
        workflow: "codex-head-worker.yml",
        review_workflow: "codex-head-gemini-review.yml",
        cli_binary: "gh",
        gh_cli_available: true,
        gh_cli_path: "C:/Program Files/GitHub CLI/gh.exe",
        gh_authenticated: true,
        machine_config_path: "C:/repo/codex-head/config/workers.machine.json",
        machine_config_exists: true,
        runs_on_json: "[\"self-hosted\",\"Windows\",\"codex-head\"]",
        runs_on_labels: ["self-hosted", "Windows", "codex-head"],
        self_hosted_targeted: true,
        recycle_script_path: "C:/repo/codex-head/scripts/recycle-self-hosted-runner.ps1",
        recycle_script_available: true,
        matching_runners: [],
        runner_lookup_detail: null
      },
      local_stack: createBriefLocalStack({
        perplexity: {
          manager_base_url: "http://127.0.0.1:20129",
          manager_reachable: true,
          manager_status: "ok",
          manager_model_aliases: ["pplxapp/app-chat"],
          cdp_base_url: "http://127.0.0.1:9233",
          cdp_reachable: true,
          cdp_browser: "Perplexity/1.0",
          runtime_target_available: true,
          pplxapp_chat: {
            prefix: "pplxapp",
            api_type: "chat",
            present: true,
            active_connection: true,
            default_model: "pplxapp/app-chat",
            upstream_base_url: "http://127.0.0.1:20129/v1"
          }
        },
        blackbox: {
          manager_base_url: "http://127.0.0.1:8083",
          manager_reachable: true,
          manager_status: "ok",
          manager_model_aliases: ["bbxapp/app-agent"],
          state_db_path: "C:/Users/test/AppData/Roaming/BLACKBOXAI/User/globalStorage/state.vscdb",
          state_db_exists: true,
          identity_loaded: true,
          user_id_present: true,
          upstream_base_url: "https://oi-vscode-server-985058387028.europe-west1.run.app",
          bbxapp_chat: {
            prefix: "bbxapp",
            api_type: "chat",
            present: true,
            active_connection: true,
            default_model: "bbxapp/app-agent",
            upstream_base_url: "http://127.0.0.1:8083/v1"
          }
        }
      }),
      database_path: "C:/repo/codex-head/runtime/codex-head.sqlite",
      artifacts_dir: "C:/repo/codex-head/runtime/artifacts"
    },
    attention: {
      workers: [],
      github: [],
      integrations: [],
      tasks: []
    },
    task_filter: {
      include_all_task_history: false,
      task_window_hours: 6,
      cutoff_at: "2026-03-24T18:00:00.000Z",
      suppressed_task_findings: 0
    },
    counts: {
      total_tasks: 3,
      task_states: {},
      enabled_workers: 2,
      workers_needing_attention: 0,
      github_findings: 0,
      integration_findings: 0,
      tasks_needing_attention: 0,
      suppressed_task_findings: 0,
      blocking_findings: 0,
      informational_findings: 0
    },
    actions: [],
    command_hints: []
  } satisfies DoctorReport);

  assert.match(rendered, /local-stack: review-ready :: 9router=up :: agm-chat=ready :: antigravity=up :: pplx-manager=up :: pplxapp-chat=ready :: bbx-manager=up :: bbxapp-chat=ready :: accounts=7/i);
});

test("renderStatusBrief summarizes one task with operator guidance", () => {
  const task = createTaskSpec({
    task_id: "task-brief-1",
    goal: "Review the latest PR in GitHub",
    repo: "C:/repo",
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    review_profile: "research",
    requires_github: true
  });

  const rendered = renderStatusBrief({
    task,
    artifact_dir_path: "C:/repo/codex-head/runtime/artifacts/task-brief-1",
    artifact_refs: {
      worker_result: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-1/worker-result.json", freshness: "current" },
      execution_attempts: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-1/execution-attempts.json", freshness: "history" },
      dispatch_receipt: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-1/github-dispatch-receipt.json", freshness: "history" },
      primary_output: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-1/worker-output.md", freshness: "current" },
      primary_log: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-1/gemini-cli-local.combined.log", freshness: "current" }
    },
    state: "failed",
    attempts: 1,
    max_attempts: 3,
    next_run_at: 0,
    created_at: 0,
    updated_at: 0,
    started_at: 0,
    finished_at: 0,
    last_error: "GitHub callback download failed",
    result: null,
    routing: {
      worker_target: "gemini-cli",
      mode: "github",
      reason: "test",
      fallback_from: null
    },
    github_run: {
      run_id: 321,
      run_url: "https://github.com/example/repo/actions/runs/321",
      workflow_name: "codex-head-gemini-review.yml",
      status: "queued",
      conclusion: null,
      updated_at: 0
    },
    github_mirror: null,
    reviews: [],
    review_runtime: {
      provider: "openai-compatible",
      credential_source: "review_api",
      transport: "chat_completions",
      model: "pplxapp/app-chat",
      profile: "research"
    },
    review_dispatch: {
      receipt_path: "C:/repo/codex-head/runtime/artifacts/task-brief-1/github-dispatch-receipt.json",
      requested_profile: "research",
      dispatched_profile: null,
      dispatch_mode: "legacy_without_input",
      degraded: true
    },
    operator: {
      queue_diagnosis_path: "C:/artifacts/task-brief-1/github-queue-diagnosis.json",
      queue_diagnosis: null,
      queue_recycle_path: "C:/artifacts/task-brief-1/github-queue-recycle.json",
      queue_recycle: null,
      latest_receipt_path: "operator-actions/2026-03-23T08-09-05.877Z-run-doctor-hint.json",
      latest_receipt_command: "run-doctor-hint",
      latest_receipt_created_at: "2026-03-23T08:09:05.877Z",
      manual_intervention_required: true,
      summary: "Automatic stale-runner recovery was already attempted and manual intervention is now required.",
      actions: [
        "Inspect C:/artifacts/task-brief-1/github-queue-recycle.json and the runner _diag logs before retrying this GitHub task."
      ]
    }
  } satisfies TaskStatusSnapshot);

  assert.match(rendered, /task task-brief-1 \[failed\] Review the latest PR in GitHub/i);
  assert.match(rendered, /worker: gemini-cli via github :: profile=research/i);
  assert.match(rendered, /artifacts: C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-1/i);
  assert.match(rendered, /review-runtime: provider=openai-compatible :: model=pplxapp\/app-chat :: transport=chat_completions :: credential=review_api/i);
  assert.match(rendered, /worker-result: C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-1\/worker-result\.json/i);
  assert.match(rendered, /attempts \(history\): C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-1\/execution-attempts\.json/i);
  assert.match(rendered, /dispatch-receipt \(history\): C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-1\/github-dispatch-receipt\.json/i);
  assert.match(rendered, /output: C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-1\/worker-output\.md/i);
  assert.match(rendered, /log: C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-1\/gemini-cli-local\.combined\.log/i);
  assert.match(rendered, /github-url: https:\/\/github\.com\/example\/repo\/actions\/runs\/321/i);
  assert.match(rendered, /dispatch: requested profile=research -> legacy standard routing/i);
  assert.match(rendered, /operator: Automatic stale-runner recovery was already attempted/i);
  assert.match(rendered, /receipt: operator-actions\/2026-03-23T08-09-05\.877Z-run-doctor-hint\.json \[run-doctor-hint\]/i);
  assert.match(rendered, /next-command: node --disable-warning=ExperimentalWarning dist\/src\/index\.js show-operator-receipt operator-actions\/2026-03-23T08-09-05\.877Z-run-doctor-hint\.json --brief/i);
  assert.match(rendered, /next: Inspect C:\/artifacts\/task-brief-1\/github-queue-recycle\.json/i);
});

test("renderOutcomeBrief summarizes recovery and reconcile style outputs", () => {
  const rendered = renderOutcomeBrief([
    {
      task_id: "task-brief-2",
      status: "error",
      detail: "GitHub run 654 appears stuck in queued state for task task-brief-2",
      outcome: null,
      operator: {
        queue_diagnosis_path: null,
        queue_diagnosis: null,
        queue_recycle_path: null,
        queue_recycle: null,
        latest_receipt_path: null,
        latest_receipt_command: null,
        latest_receipt_created_at: null,
        manual_intervention_required: false,
        summary: "Matching self-hosted runners are all busy.",
        actions: [
          "Wait for a runner slot or free one of the matching self-hosted runners."
        ]
      }
    }
  ], "No entries.");

  assert.match(rendered, /task task-brief-2 \[error\]/i);
  assert.match(rendered, /detail: GitHub run 654 appears stuck in queued state/i);
  assert.match(rendered, /operator: Matching self-hosted runners are all busy\./i);
  assert.match(rendered, /next: Wait for a runner slot or free one of the matching self-hosted runners\./i);
});

test("renderStatusBrief omits the no-action line when only follow-up actions exist", () => {
  const task = createTaskSpec({
    task_id: "task-brief-3",
    goal: "Review the latest PR in GitHub",
    repo: "C:/repo",
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  });

  const rendered = renderStatusBrief({
    task,
    artifact_dir_path: "C:/repo/codex-head/runtime/artifacts/task-brief-3",
    artifact_refs: {
      worker_result: null,
      execution_attempts: null,
      dispatch_receipt: null,
      primary_output: null,
      primary_log: null
    },
    state: "failed",
    attempts: 1,
    max_attempts: 3,
    next_run_at: 0,
    created_at: 0,
    updated_at: 0,
    started_at: 0,
    finished_at: 0,
    last_error: "GitHub callback download failed",
    result: null,
    routing: {
      worker_target: "gemini-cli",
      mode: "github",
      reason: "test",
      fallback_from: null
    },
    github_run: null,
    github_mirror: null,
    reviews: [],
    review_runtime: null,
    review_dispatch: null,
    operator: {
      queue_diagnosis_path: null,
      queue_diagnosis: null,
      queue_recycle_path: null,
      queue_recycle: null,
      latest_receipt_path: null,
      latest_receipt_command: null,
      latest_receipt_created_at: null,
      manual_intervention_required: false,
      summary: null,
      actions: [
        "Set github.repository or dispatch the task again so Codex Head can resolve the workflow run."
      ]
    }
  } satisfies TaskStatusSnapshot);

  assert.doesNotMatch(rendered, /operator: no immediate action/i);
  assert.match(rendered, /next: Set github\.repository or dispatch the task again/i);
});

test("renderStatusBrief omits the no-action line when a receipt is available", () => {
  const task = createTaskSpec({
    task_id: "task-brief-4",
    goal: "Summarize the current orchestration state",
    repo: "C:/repo",
    worker_target: "gemini-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  });

  const rendered = renderStatusBrief({
    task,
    artifact_dir_path: "C:/repo/codex-head/runtime/artifacts/task-brief-4",
    artifact_refs: {
      worker_result: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-4/worker-result.json", freshness: "last_attempt" },
      execution_attempts: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-4/execution-attempts.json", freshness: "history" },
      dispatch_receipt: null,
      primary_output: null,
      primary_log: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-4/gemini-cli-local.combined.log", freshness: "last_attempt" }
    },
    state: "queued",
    attempts: 1,
    max_attempts: 3,
    next_run_at: 0,
    created_at: 0,
    updated_at: 0,
    started_at: 0,
    finished_at: 0,
    last_error: null,
    result: null,
    routing: {
      worker_target: "gemini-cli",
      mode: "local",
      reason: "test",
      fallback_from: null
    },
    github_run: null,
    github_mirror: null,
    reviews: [],
    review_runtime: null,
    review_dispatch: null,
    operator: {
      queue_diagnosis_path: null,
      queue_diagnosis: null,
      queue_recycle_path: null,
      queue_recycle: null,
      latest_receipt_path: "operator-actions/2026-03-23T08-09-05.877Z-run-doctor-hint.json",
      latest_receipt_command: "run-doctor-hint",
      latest_receipt_created_at: "2026-03-23T08:09:05.877Z",
      manual_intervention_required: false,
      summary: null,
      actions: []
    }
  } satisfies TaskStatusSnapshot);

  assert.doesNotMatch(rendered, /operator: no immediate action/i);
  assert.match(rendered, /receipt: operator-actions\/2026-03-23T08-09-05\.877Z-run-doctor-hint\.json \[run-doctor-hint\]/i);
  assert.match(rendered, /next-command: node --disable-warning=ExperimentalWarning dist\/src\/index\.js show-operator-receipt operator-actions\/2026-03-23T08-09-05\.877Z-run-doctor-hint\.json --brief/i);
});

test("renderStatusBrief omits the no-action line for clean completed tasks", () => {
  const task = createTaskSpec({
    task_id: "task-brief-5",
    goal: "Summarize the current orchestration state",
    repo: "C:/repo",
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  });

  const rendered = renderStatusBrief({
    task,
    artifact_dir_path: "C:/repo/codex-head/runtime/artifacts/task-brief-5",
    artifact_refs: {
      worker_result: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-5/worker-result.json", freshness: "current" },
      execution_attempts: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-5/execution-attempts.json", freshness: "history" },
      dispatch_receipt: null,
      primary_output: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-5/worker-output.md", freshness: "current" },
      primary_log: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-5/codex-cli-local.combined.log", freshness: "current" }
    },
    state: "completed",
    attempts: 1,
    max_attempts: 3,
    next_run_at: 0,
    created_at: 0,
    updated_at: 0,
    started_at: 0,
    finished_at: 0,
    last_error: null,
    result: null,
    routing: {
      worker_target: "codex-cli",
      mode: "local",
      reason: "test",
      fallback_from: null
    },
    github_run: null,
    github_mirror: null,
    reviews: [],
    review_runtime: null,
    review_dispatch: null,
    operator: {
      queue_diagnosis_path: null,
      queue_diagnosis: null,
      queue_recycle_path: null,
      queue_recycle: null,
      latest_receipt_path: null,
      latest_receipt_command: null,
      latest_receipt_created_at: null,
      manual_intervention_required: false,
      summary: null,
      actions: []
    }
  } satisfies TaskStatusSnapshot);

  assert.doesNotMatch(rendered, /operator: no immediate action/i);
  assert.match(rendered, /worker-result: C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-5\/worker-result\.json/i);
});

test("renderOutcomeBrief handles empty batches", () => {
  assert.equal(renderOutcomeBrief([], "No reconcile targets."), "No reconcile targets.");
});

test("renderDoctorBrief summarizes operator findings and next actions", () => {
  const report: DoctorReport = {
    ok: false,
    generated_at: new Date().toISOString(),
    summary: "Found 3 blocking item(s) across 1 worker, 1 GitHub, 1 task.",
    task_filter: {
      include_all_task_history: false,
      task_window_hours: 6,
      cutoff_at: "2026-03-23T00:00:00.000Z",
      suppressed_task_findings: 2
    },
    counts: {
      total_tasks: 2,
      task_states: {
        failed: 1,
        running: 1
      },
      enabled_workers: 3,
      workers_needing_attention: 1,
      github_findings: 1,
      integration_findings: 1,
      tasks_needing_attention: 2,
      suppressed_task_findings: 2,
      blocking_findings: 3,
      informational_findings: 1
    },
    health: {
      adapters: [],
      readiness: [],
      recent_penalties: [],
      github: {
        enabled: true,
        dispatch_mode: "gh_cli",
        execution_preference: "local_preferred",
        auto_recycle_stale_runner: true,
        repository: "example/repo",
        workflow: "codex-head-worker.yml",
        review_workflow: "codex-head-gemini-review.yml",
        cli_binary: "gh",
        gh_cli_available: true,
        gh_cli_path: "gh",
        gh_authenticated: false,
        machine_config_path: "C:/repo/codex-head/config/workers.machine.json",
        machine_config_exists: true,
        runs_on_json: "[\"self-hosted\",\"Windows\",\"codex-head\"]",
        runs_on_labels: ["self-hosted", "Windows", "codex-head"],
        self_hosted_targeted: true,
        recycle_script_path: "C:/repo/codex-head/scripts/recycle-self-hosted-runner.ps1",
        recycle_script_available: true,
        matching_runners: [],
        runner_lookup_detail: null
      },
      local_stack: createBriefLocalStack({
        recommended_review_path_ready: false,
        router9: {
          base_url: "http://127.0.0.1:20128",
          reachable: false,
          version: null,
          agm_chat: {
            prefix: "agm",
            api_type: "chat",
            present: false,
            active_connection: null,
            default_model: null,
            upstream_base_url: null
          },
          agr_responses: {
            prefix: "agr",
            api_type: "responses",
            present: false,
            active_connection: null,
            default_model: null,
            upstream_base_url: null
          },
          responses_route_suitable_for_codex_cli_local: false
        }
      }),
      database_path: "C:/repo/codex-head/runtime/codex-head.sqlite",
      artifacts_dir: "C:/repo/codex-head/runtime/artifacts"
    },
    attention: {
      workers: [
        {
          worker_target: "claude-code",
          severity: "error",
          summary: "Worker claude-code health check failed: Timed out while checking auth",
          actions: ["Inspect the claude-code health command and local runtime."]
        }
      ],
      github: [
        {
          severity: "error",
          summary: "GitHub dispatch is enabled but gh is not authenticated on this machine.",
          actions: ["Run gh auth login on the machine that dispatches or reconciles GitHub workflows."]
        }
      ],
      integrations: [
        {
          integration: "local_review_stack",
          severity: "error",
          summary: "9router is not reachable at http://127.0.0.1:20128.",
          actions: ["Run powershell -ExecutionPolicy Bypass -File \"C:/repo/codex-head/scripts/ensure-9router-antigravity-stack.ps1\" to start or repair the local review stack."]
        }
      ],
      tasks: [
        {
          task_id: "task-brief-doctor",
          state: "failed",
          goal: "Review the latest PR in GitHub",
          worker_target: "gemini-cli",
          review_profile: "research",
          review_dispatch_degraded: true,
          routing_mode: "github",
          artifact_dir_path: "C:/repo/codex-head/runtime/artifacts/task-brief-doctor",
          artifact_refs: {
            worker_result: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-doctor/worker-result.json", freshness: "current" },
            execution_attempts: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-doctor/execution-attempts.json", freshness: "history" },
            dispatch_receipt: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-doctor/github-dispatch-receipt.json", freshness: "history" },
            primary_output: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-doctor/worker-output.md", freshness: "current" },
            primary_log: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-doctor/gemini-cli-local.combined.log", freshness: "current" }
          },
          github_run_url: "https://github.com/example/repo/actions/runs/321",
          severity: "error",
          summary: "Automatic stale-runner recovery was already attempted and manual intervention is now required.",
          actions: ["Inspect C:/repo/codex-head/runtime/artifacts/task-brief-doctor/github-queue-recycle.json and retry."],
          has_operator_actions: true,
          operator_receipt_path: "operator-actions/2026-03-23T08-09-05.877Z-run-doctor-hint.json",
          operator_receipt_command: "run-doctor-hint",
          operator_receipt_created_at: "2026-03-23T08:09:05.877Z",
          manual_intervention_required: true
        }
      ]
    },
    actions: [
      "Inspect the claude-code health command and local runtime.",
      "Run gh auth login on the machine that dispatches or reconciles GitHub workflows.",
      "Inspect C:/repo/codex-head/runtime/artifacts/task-brief-doctor/github-queue-recycle.json and retry."
    ],
    command_hints: [
      {
        id: "suppressed-failed-backlog",
        kind: "suppressed_failed_backlog",
        reason: "Inspect older failed tasks hidden by the current doctor window before canceling them in bulk.",
        command: "node --disable-warning=ExperimentalWarning dist/src/index.js sweep-tasks cancel --state failed --older-than-hours 6 --dry-run --brief",
        sweep: {
          action: "cancel",
          states: ["failed"],
          older_than_hours: 6
        }
      }
    ]
  };

  const rendered = renderDoctorBrief(report);
  assert.match(rendered, /^doctor: needs attention/im);
  assert.match(rendered, /history: hidden 2 older task finding\(s\) outside the 6h window/i);
  assert.match(rendered, /local-stack: review-path-incomplete :: 9router=down :: agm-chat=missing :: antigravity=up :: accounts=7/i);
  assert.match(rendered, /workers:\n- claude-code \[error\] Worker claude-code health check failed/i);
  assert.match(rendered, /github:\n- \[error\] GitHub dispatch is enabled but gh is not authenticated/i);
  assert.match(rendered, /integrations:\n- \[error\] 9router is not reachable at http:\/\/127\.0\.0\.1:20128\./i);
  assert.match(rendered, /tasks:\n- task-brief-doctor \[failed\/error\] Review the latest PR in GitHub :: profile=research :: dispatch=legacy-standard/i);
  assert.match(rendered, /receipt=operator-actions\/2026-03-23T08-09-05\.877Z-run-doctor-hint\.json \[run-doctor-hint\]/i);
  assert.match(rendered, /receipt-commands:\n- task-brief-doctor :: node --disable-warning=ExperimentalWarning dist\/src\/index\.js show-operator-receipt operator-actions\/2026-03-23T08-09-05\.877Z-run-doctor-hint\.json --brief/i);
  assert.match(rendered, /next-command: node --disable-warning=ExperimentalWarning dist\/src\/index\.js sweep-tasks cancel --state failed --older-than-hours 6 --dry-run --brief/i);
  assert.match(rendered, /task-links:\n- task-brief-doctor :: artifacts=C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-doctor :: github=https:\/\/github\.com\/example\/repo\/actions\/runs\/321/i);
  assert.match(rendered, /artifact-files:\n- task-brief-doctor :: result=C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-doctor\/worker-result\.json :: attempts\(history\)=C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-doctor\/execution-attempts\.json :: dispatch-receipt\(history\)=C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-doctor\/github-dispatch-receipt\.json :: output=C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-doctor\/worker-output\.md :: log=C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-doctor\/gemini-cli-local\.combined\.log/i);
  assert.match(rendered, /next:\n- Inspect the claude-code health command and local runtime\./i);
  assert.match(rendered, /commands:\n- \[suppressed-failed-backlog\] node --disable-warning=ExperimentalWarning dist\/src\/index\.js sweep-tasks cancel --state failed --older-than-hours 6 --dry-run --brief/i);
});

test("renderDoctorBrief keeps receipt commands aligned with visible task rows", () => {
  const tasks: DoctorReport["attention"]["tasks"] = Array.from({ length: 9 }, (_, index) => ({
    task_id: `task-brief-visible-${index + 1}`,
    state: "queued",
    goal: index < 2 ? `Queued task ${index + 1}` : "Queued task backlog",
    worker_target: "codex-cli",
    review_dispatch_degraded: false,
    routing_mode: "local",
    artifact_dir_path: `C:/repo/codex-head/runtime/artifacts/task-brief-visible-${index + 1}`,
    artifact_refs: {
      worker_result: index < 2
        ? { path: `C:/repo/codex-head/runtime/artifacts/task-brief-visible-${index + 1}/worker-result.json`, freshness: "last_attempt" }
        : null,
      execution_attempts: index < 2
        ? { path: `C:/repo/codex-head/runtime/artifacts/task-brief-visible-${index + 1}/execution-attempts.json`, freshness: "history" }
        : null,
      dispatch_receipt: null,
      primary_output: null,
      primary_log: index < 2
        ? { path: `C:/repo/codex-head/runtime/artifacts/task-brief-visible-${index + 1}/codex-cli-local.combined.log`, freshness: "last_attempt" }
        : null
    },
    github_run_url: null,
    severity: "warning",
    summary: "Task is queued and waiting for dispatch.",
    actions: ["Dispatch the queued task when the workspace and workers are ready."],
    has_operator_actions: false,
    operator_receipt_path: index < 2
      ? `operator-actions/2026-03-23T08-09-0${index}.000Z-run-doctor-hint.json`
      : null,
    operator_receipt_command: index < 2 ? "run-doctor-hint" : null,
    operator_receipt_created_at: index < 2 ? `2026-03-23T08:09:0${index}.000Z` : null,
    manual_intervention_required: false
  }));
  const report: DoctorReport = {
    ok: false,
    generated_at: new Date().toISOString(),
    summary: "Found blocking items.",
    task_filter: {
      include_all_task_history: false,
      task_window_hours: 6,
      cutoff_at: "2026-03-23T00:00:00.000Z",
      suppressed_task_findings: 0
    },
    counts: {
      total_tasks: 9,
      task_states: { queued: 9 },
      enabled_workers: 1,
      workers_needing_attention: 0,
      github_findings: 0,
      integration_findings: 0,
      tasks_needing_attention: 9,
      suppressed_task_findings: 0,
      blocking_findings: 9,
      informational_findings: 0
    },
    health: {
      adapters: [],
      readiness: [],
      recent_penalties: [],
      github: {
        enabled: false,
        dispatch_mode: "gh_cli",
        execution_preference: "local_preferred",
        auto_recycle_stale_runner: false,
        repository: "example/repo",
        workflow: "codex-head-worker.yml",
        review_workflow: "codex-head-gemini-review.yml",
        cli_binary: "gh",
        gh_cli_available: true,
        gh_cli_path: "gh",
        gh_authenticated: true,
        machine_config_path: null,
        machine_config_exists: false,
        runs_on_json: null,
        runs_on_labels: [],
        self_hosted_targeted: false,
        recycle_script_path: null,
        recycle_script_available: false,
        matching_runners: [],
        runner_lookup_detail: null
      },
      local_stack: createBriefLocalStack(),
      database_path: "C:/repo/codex-head/runtime/codex-head.sqlite",
      artifacts_dir: "C:/repo/codex-head/runtime/artifacts"
    },
    attention: {
      workers: [],
      github: [],
      integrations: [],
      tasks
    },
    actions: ["Dispatch the queued task when the workspace and workers are ready."],
    command_hints: [
      {
        id: "queued-backlog-1",
        kind: "queued_backlog",
        reason: "Inspect queued task task-brief-visible-1 before canceling it from the backlog.",
        command: "node --disable-warning=ExperimentalWarning dist/src/index.js sweep-tasks cancel --task-id task-brief-visible-1 --dry-run --brief",
        sweep: {
          action: "cancel",
          task_ids: ["task-brief-visible-1"]
        }
      },
      {
        id: "queued-backlog-2",
        kind: "queued_backlog",
        reason: "Inspect queued task task-brief-visible-2 before canceling it from the backlog.",
        command: "node --disable-warning=ExperimentalWarning dist/src/index.js sweep-tasks cancel --task-id task-brief-visible-2 --dry-run --brief",
        sweep: {
          action: "cancel",
          task_ids: ["task-brief-visible-2"]
        }
      },
      {
        id: "queued-backlog-3",
        kind: "queued_backlog",
        reason: "Inspect queued task task-brief-visible-3 before canceling it from the backlog.",
        command: "node --disable-warning=ExperimentalWarning dist/src/index.js sweep-tasks cancel --task-id task-brief-visible-3 --dry-run --brief",
        sweep: {
          action: "cancel",
          task_ids: ["task-brief-visible-3"]
        }
      }
    ]
  };

  const rendered = renderDoctorBrief(report);
  assert.match(rendered, /local-stack: review-ready :: 9router=up :: agm-chat=ready :: antigravity=up :: accounts=7/i);
  assert.match(rendered, /tasks:\n- task-brief-visible-1/i);
  assert.match(rendered, /- 6 similar task\(s\) \[queued\/warning\] Queued task backlog :: Task is queued and waiting for dispatch\. :: examples=task-brief-visible-3, task-brief-visible-4, task-brief-visible-5, \+3 more/i);
  assert.doesNotMatch(rendered, /tasks:[\s\S]*task-brief-visible-3 \[queued\/warning\]/i);
  assert.doesNotMatch(rendered, /task-brief-visible-9/i);
  assert.match(rendered, /receipt-commands:\n- task-brief-visible-1 :: node --disable-warning=ExperimentalWarning dist\/src\/index\.js show-operator-receipt operator-actions\/2026-03-23T08-09-00\.000Z-run-doctor-hint\.json --brief/i);
  assert.match(rendered, /task-links:\n- task-brief-visible-1 :: artifacts=C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-visible-1/i);
  assert.doesNotMatch(rendered, /\n- task-brief-visible-3 :: artifacts=/i);
  assert.doesNotMatch(rendered, /receipt-commands:[\s\S]*task-brief-visible-9/i);
  assert.doesNotMatch(rendered, /^artifact-files:/im);
  assert.match(rendered, /commands:[\s\S]*\[queued-backlog-3\] node --disable-warning=ExperimentalWarning dist\/src\/index\.js sweep-tasks cancel --task-id task-brief-visible-3 --dry-run --brief :: representative of 6 similar queued\/warning task\(s\)/i);
  assert.doesNotMatch(rendered, /next:[\s\S]*Dispatch the queued task when the workspace and workers are ready\./i);
});

test("renderDoctorBrief prioritizes review workflow inspection when live profile routing is degraded", () => {
  const report: DoctorReport = {
    ok: false,
    generated_at: "2026-03-25T01:00:00.000Z",
    summary: "Found 1 blocking item across 1 GitHub finding.",
    task_filter: {
      include_all_task_history: false,
      task_window_hours: 6,
      cutoff_at: "2026-03-24T19:00:00.000Z",
      suppressed_task_findings: 0
    },
    counts: {
      total_tasks: 0,
      task_states: {},
      enabled_workers: 0,
      workers_needing_attention: 0,
      github_findings: 1,
      integration_findings: 0,
      tasks_needing_attention: 0,
      suppressed_task_findings: 0,
      blocking_findings: 1,
      informational_findings: 0
    },
    health: {
      adapters: [],
      readiness: [],
      recent_penalties: [],
      github: {
        enabled: true,
        dispatch_mode: "gh_cli",
        execution_preference: "local_preferred",
        auto_recycle_stale_runner: false,
        repository: "example/repo",
        workflow: "codex-head-worker.yml",
        review_workflow: "codex-head-gemini-review.yml",
        review_workflow_supports_review_profile: false,
        review_workflow_input_check_detail: "Remote review workflow codex-head-gemini-review.yml does not declare workflow_dispatch input review_profile.",
        cli_binary: "gh",
        gh_cli_available: true,
        gh_cli_path: "gh",
        gh_authenticated: true,
        machine_config_path: null,
        machine_config_exists: false,
        runs_on_json: null,
        runs_on_labels: [],
        self_hosted_targeted: false,
        recycle_script_path: null,
        recycle_script_available: false,
        matching_runners: [],
        runner_lookup_detail: null
      },
      local_stack: createBriefLocalStack(),
      database_path: "C:/repo/codex-head/runtime/codex-head.sqlite",
      artifacts_dir: "C:/repo/codex-head/runtime/artifacts"
    },
    attention: {
      workers: [],
      github: [
        {
          severity: "warning",
          summary: "Remote review workflow codex-head-gemini-review.yml is missing the review_profile workflow_dispatch input, so live review dispatch will fall back to legacy standard routing.",
          actions: [
            "Push or sync .github/workflows/codex-head-gemini-review.yml to the GitHub default branch so review_profile is accepted during workflow_dispatch and research/code-assist routing works live."
          ]
        }
      ],
      integrations: [],
      tasks: []
    },
    actions: [
      "Push or sync .github/workflows/codex-head-gemini-review.yml to the GitHub default branch so review_profile is accepted during workflow_dispatch and research/code-assist routing works live."
    ],
    command_hints: [
      {
        id: "suppressed-failed-backlog",
        kind: "suppressed_failed_backlog",
        reason: "Inspect older failed tasks hidden by the current doctor window before canceling them in bulk.",
        command: "node --disable-warning=ExperimentalWarning dist/src/index.js sweep-tasks cancel --state failed --older-than-hours 6 --dry-run --brief",
        sweep: {
          action: "cancel",
          states: ["failed"],
          older_than_hours: 6
        }
      }
    ]
  };

  const rendered = renderDoctorBrief(report);
  assert.match(rendered, /github:\n- \[warning\] Remote review workflow codex-head-gemini-review\.yml is missing the review_profile workflow_dispatch input/i);
  assert.match(rendered, /next-command: node --disable-warning=ExperimentalWarning dist\/src\/index\.js review-workflow-status --brief/i);
  assert.match(rendered, /next:\n- Push or sync \.github\/workflows\/codex-head-gemini-review\.yml to the GitHub default branch/i);
  assert.match(rendered, /commands:\n- \[suppressed-failed-backlog\] node --disable-warning=ExperimentalWarning dist\/src\/index\.js sweep-tasks cancel --state failed --older-than-hours 6 --dry-run --brief/i);
});

test("renderDoctorBrief omits cleanup commands when the report is otherwise healthy", () => {
  const report: DoctorReport = {
    ok: true,
    generated_at: new Date().toISOString(),
    summary: "No blocking issues found across 53 task(s) and 2 enabled worker(s).",
    task_filter: {
      include_all_task_history: false,
      task_window_hours: 6,
      cutoff_at: "2026-03-23T00:00:00.000Z",
      suppressed_task_findings: 10
    },
    counts: {
      total_tasks: 53,
      task_states: { completed: 40, canceled: 13 },
      enabled_workers: 2,
      workers_needing_attention: 0,
      github_findings: 0,
      integration_findings: 0,
      tasks_needing_attention: 0,
      suppressed_task_findings: 10,
      blocking_findings: 0,
      informational_findings: 0
    },
    health: {
      adapters: [],
      readiness: [],
      recent_penalties: [],
      github: {
        enabled: true,
        dispatch_mode: "gh_cli",
        execution_preference: "local_preferred",
        auto_recycle_stale_runner: false,
        repository: "example/repo",
        workflow: "codex-head-worker.yml",
        review_workflow: "codex-head-gemini-review.yml",
        cli_binary: "gh",
        gh_cli_available: true,
        gh_cli_path: "gh",
        gh_authenticated: true,
        machine_config_path: null,
        machine_config_exists: false,
        runs_on_json: null,
        runs_on_labels: [],
        self_hosted_targeted: false,
        recycle_script_path: null,
        recycle_script_available: false,
        matching_runners: [],
        runner_lookup_detail: null
      },
      local_stack: createBriefLocalStack(),
      database_path: "C:/repo/codex-head/runtime/codex-head.sqlite",
      artifacts_dir: "C:/repo/codex-head/runtime/artifacts"
    },
    attention: {
      workers: [],
      github: [],
      integrations: [],
      tasks: []
    },
    actions: [],
    command_hints: [
      {
        id: "suppressed-failed-backlog",
        kind: "suppressed_failed_backlog",
        reason: "Inspect older failed tasks hidden by the current doctor window before canceling them in bulk.",
        command: "node --disable-warning=ExperimentalWarning dist/src/index.js sweep-tasks cancel --state failed --older-than-hours 6 --dry-run --brief",
        sweep: {
          action: "cancel",
          states: ["failed"],
          older_than_hours: 6
        }
      }
    ]
  };

  const rendered = renderDoctorBrief(report);
  assert.match(rendered, /^doctor: healthy/im);
  assert.match(rendered, /local-stack: review-ready :: 9router=up :: agm-chat=ready :: antigravity=up :: accounts=7/i);
  assert.match(rendered, /history: hidden 10 older task finding\(s\) outside the 6h window/i);
  assert.doesNotMatch(rendered, /^next-command:/im);
  assert.doesNotMatch(rendered, /^commands:/im);
});

test("renderReviewWorkflowStatusBrief summarizes local and remote workflow drift", () => {
  const rendered = renderReviewWorkflowStatusBrief({
    repository: "example/repo",
    workflow: "codex-head-gemini-review.yml",
    local_workflow_path: "C:/repo/.github/workflows/codex-head-gemini-review.yml",
    git_branch: "main",
    git_tracking_status: "in sync with origin/main",
    local_git_file_status: "modified",
    local_vs_origin_status: "uncommitted local changes only; HEAD still matches origin/main",
    local_supports_review_profile: true,
    local_declared_inputs: [
      "task_id",
      "target_repository",
      "base_branch",
      "work_branch",
      "execution_target",
      "review_profile",
      "review_policy",
      "expected_output",
      "prior_result_status"
    ],
    remote_supports_review_profile: false,
    remote_declared_inputs: [
      "task_id",
      "target_repository",
      "base_branch",
      "work_branch",
      "execution_target",
      "review_policy",
      "expected_output",
      "prior_result_status"
    ],
    missing_on_remote: ["review_profile"],
    remote_check_detail: "Remote review workflow codex-head-gemini-review.yml does not declare workflow_dispatch input review_profile.",
    inspect_command: "gh workflow view codex-head-gemini-review.yml --yaml",
    sync_action: "Commit and push .github/workflows/codex-head-gemini-review.yml from main so review_profile is accepted during workflow_dispatch and research/code-assist routing works live.",
    sync_commands: [
      "git add .github/workflows/codex-head-gemini-review.yml",
      "git commit --only .github/workflows/codex-head-gemini-review.yml -m \"Update codex-head-gemini-review.yml workflow_dispatch inputs\"",
      "git push origin main"
    ]
  });

  assert.match(rendered, /^review-workflow: codex-head-gemini-review\.yml/im);
  assert.match(rendered, /^repository: example\/repo/im);
  assert.match(rendered, /^local: supports review_profile :: C:\/repo\/\.github\/workflows\/codex-head-gemini-review\.yml/im);
  assert.match(rendered, /^git-branch: main/im);
  assert.match(rendered, /^git-tracking: in sync with origin\/main/im);
  assert.match(rendered, /^git-file-status: modified/im);
  assert.match(rendered, /^git-origin-status: uncommitted local changes only; HEAD still matches origin\/main/im);
  assert.match(rendered, /local-inputs: task_id, target_repository, base_branch, work_branch, execution_target, review_profile/i);
  assert.match(rendered, /^remote: legacy workflow without review_profile/im);
  assert.match(rendered, /remote-inputs: task_id, target_repository, base_branch, work_branch, execution_target, review_policy/i);
  assert.match(rendered, /missing-on-remote: review_profile/i);
  assert.match(rendered, /^inspect-command: gh workflow view codex-head-gemini-review\.yml --yaml/im);
  assert.match(rendered, /^next: Commit and push \.github\/workflows\/codex-head-gemini-review\.yml from main/im);
  assert.match(rendered, /^sync-commands:/im);
  assert.match(rendered, /- git add \.github\/workflows\/codex-head-gemini-review\.yml/i);
  assert.match(rendered, /- git commit --only \.github\/workflows\/codex-head-gemini-review\.yml -m "Update codex-head-gemini-review\.yml workflow_dispatch inputs"/i);
  assert.match(rendered, /- git push origin main/i);
});

test("renderSweepBrief summarizes bulk task actions", () => {
  const rendered = renderSweepBrief({
    action: "cancel",
    dry_run: true,
    receipt_path: "operator-actions/2026-03-23T12-00-00.000Z-sweep-tasks.json",
    filters: {
      states: ["queued", "failed"],
      older_than_hours: 6,
      goal_contains: "summarize",
      worker_target: null,
      task_ids: [],
      limit: 10
    },
    matched: 2,
    changed: 2,
    tasks: [
      {
        task_id: "task-sweep-1",
        goal: "Summarize the current orchestration state",
        worker_target: "codex-cli",
        previous_state: "queued",
        next_state: "canceled",
        changed: true,
        reason: "Would cancel the selected task."
      },
      {
        task_id: "task-sweep-2",
        goal: "Summarize the current orchestration state",
        worker_target: "gemini-cli",
        previous_state: "failed",
        next_state: "canceled",
        changed: true,
        reason: "Would cancel the selected task."
      }
    ]
  } satisfies SweepTasksResult);

  assert.match(rendered, /^sweep: cancel \(dry-run\)$/im);
  assert.match(rendered, /summary: matched 2, actionable 2/i);
  assert.match(rendered, /tasks:\n- task-sweep-1 \[queued -> canceled\]/i);
  assert.match(rendered, /receipt: operator-actions\/2026-03-23T12-00-00\.000Z-sweep-tasks\.json/i);
});

test("renderRunDoctorHintsBrief summarizes batch doctor hint execution", () => {
  const rendered = renderRunDoctorHintsBrief({
    report: {
      ok: false,
      generated_at: new Date().toISOString(),
      summary: "Found blocking items.",
      task_filter: {
        include_all_task_history: false,
        task_window_hours: 6,
        cutoff_at: "2026-03-23T00:00:00.000Z",
        suppressed_task_findings: 1
      },
      counts: {
        total_tasks: 3,
        task_states: { queued: 2, failed: 1 },
        enabled_workers: 2,
        workers_needing_attention: 0,
        github_findings: 0,
        integration_findings: 0,
        tasks_needing_attention: 3,
        suppressed_task_findings: 1,
        blocking_findings: 2,
        informational_findings: 1
      },
      health: {
        adapters: [],
        readiness: [],
        recent_penalties: [],
        github: {
          enabled: false,
          dispatch_mode: "gh_cli",
          execution_preference: "local_preferred",
          auto_recycle_stale_runner: false,
          repository: "example/repo",
          workflow: "codex-head-worker.yml",
          review_workflow: "codex-head-gemini-review.yml",
          cli_binary: "gh",
          gh_cli_available: true,
          gh_cli_path: "gh",
          gh_authenticated: true,
          machine_config_path: null,
          machine_config_exists: false,
          runs_on_json: null,
          runs_on_labels: [],
          self_hosted_targeted: false,
          recycle_script_path: null,
          recycle_script_available: false,
          matching_runners: [],
          runner_lookup_detail: null
        },
        local_stack: createBriefLocalStack(),
        database_path: "C:/repo/codex-head/runtime/codex-head.sqlite",
        artifacts_dir: "C:/repo/codex-head/runtime/artifacts"
      },
      attention: {
        workers: [],
        github: [],
        integrations: [],
        tasks: []
      },
      actions: [],
      command_hints: []
    },
    kind: "queued_backlog",
    limit: 2,
    apply: false,
    allow_multi_task_apply: false,
    confirm_token: "abc123def456",
    total_matched: 2,
    total_actionable: 2,
    preview: [
      {
        hint: {
          id: "queued-backlog-1",
          kind: "queued_backlog",
          reason: "Inspect queued task task-1 before canceling it from the backlog.",
          command: "node --disable-warning=ExperimentalWarning dist/src/index.js sweep-tasks cancel --task-id task-1 --dry-run --brief",
          sweep: {
            action: "cancel",
            task_ids: ["task-1"]
          }
        },
        result: {
          action: "cancel",
          dry_run: true,
          receipt_path: null,
          filters: {
            states: ["planned", "queued", "failed"],
            older_than_hours: null,
            goal_contains: null,
            worker_target: null,
            task_ids: ["task-1"],
            limit: null
          },
          matched: 1,
          changed: 1,
          tasks: []
        }
      },
      {
        hint: {
          id: "queued-backlog-2",
          kind: "queued_backlog",
          reason: "Inspect queued task task-2 before canceling it from the backlog.",
          command: "node --disable-warning=ExperimentalWarning dist/src/index.js sweep-tasks cancel --task-id task-2 --dry-run --brief",
          sweep: {
            action: "cancel",
            task_ids: ["task-2"]
          }
        },
        result: {
          action: "cancel",
          dry_run: true,
          receipt_path: null,
          filters: {
            states: ["planned", "queued", "failed"],
            older_than_hours: null,
            goal_contains: null,
            worker_target: null,
            task_ids: ["task-2"],
            limit: null
          },
          matched: 1,
          changed: 1,
          tasks: []
        }
      }
    ],
    receipt_path: "operator-actions/2026-03-23T12-05-00.000Z-run-doctor-hints.json",
    results: [
      {
        hint: {
          id: "queued-backlog-1",
          kind: "queued_backlog",
          reason: "Inspect queued task task-1 before canceling it from the backlog.",
          command: "node --disable-warning=ExperimentalWarning dist/src/index.js sweep-tasks cancel --task-id task-1 --dry-run --brief",
          sweep: {
            action: "cancel",
            task_ids: ["task-1"]
          }
        },
        result: {
          action: "cancel",
          dry_run: true,
          receipt_path: null,
          filters: {
            states: ["planned", "queued", "failed"],
            older_than_hours: null,
            goal_contains: null,
            worker_target: null,
            task_ids: ["task-1"],
            limit: null
          },
          matched: 1,
          changed: 1,
          tasks: []
        }
      },
      {
        hint: {
          id: "queued-backlog-2",
          kind: "queued_backlog",
          reason: "Inspect queued task task-2 before canceling it from the backlog.",
          command: "node --disable-warning=ExperimentalWarning dist/src/index.js sweep-tasks cancel --task-id task-2 --dry-run --brief",
          sweep: {
            action: "cancel",
            task_ids: ["task-2"]
          }
        },
        result: {
          action: "cancel",
          dry_run: true,
          receipt_path: null,
          filters: {
            states: ["planned", "queued", "failed"],
            older_than_hours: null,
            goal_contains: null,
            worker_target: null,
            task_ids: ["task-2"],
            limit: null
          },
          matched: 1,
          changed: 1,
          tasks: []
        }
      }
    ]
  });

  assert.match(rendered, /^doctor-hints: 2 selected \(dry-run\)$/im);
  assert.match(rendered, /summary: matched 2, actionable 2/i);
  assert.match(rendered, /confirm-token: abc123def456/i);
  assert.match(rendered, /kind: queued_backlog/i);
  assert.match(rendered, /limit: 2/i);
  assert.match(rendered, /next: rerun with --apply --allow-multi-task-apply --confirm-token abc123def456/i);
  assert.match(rendered, /hints:\n- queued-backlog-1 \[queued_backlog\]/i);
  assert.match(rendered, /receipt: operator-actions\/2026-03-23T12-05-00\.000Z-run-doctor-hints\.json/i);
});

test("renderOperatorHistoryBrief summarizes recent operator receipts", () => {
  const rendered = renderOperatorHistoryBrief({
    filters: {
      command: "run-doctor-hints",
      apply_only: false,
      dry_run_only: true,
      limit: 5
    },
    scanned: 8,
    returned: 2,
    receipts: [
      {
        receipt_path: "operator-actions/2026-03-23T08-09-05.875Z-run-doctor-hints.json",
        receipt: {
          schema_version: 1,
          command: "run-doctor-hints",
          created_at: "2026-03-23T08:09:05.875Z",
          dry_run: true,
          apply: false,
          selection: {},
          summary: {
            matched: 2,
            actionable: 2,
            changed: 0
          }
        }
      },
      {
        receipt_path: "operator-actions/2026-03-23T08-08-00.000Z-run-doctor-hints.json",
        receipt: {
          schema_version: 1,
          command: "run-doctor-hints",
          created_at: "2026-03-23T08:08:00.000Z",
          dry_run: true,
          apply: false,
          selection: {},
          summary: {
            matched: 1,
            actionable: 1,
            changed: 0
          }
        }
      }
    ]
  } satisfies OperatorHistoryResult);

  assert.match(rendered, /^operator-history: 2 receipt\(s\)$/im);
  assert.match(rendered, /scanned: 8/i);
  assert.match(rendered, /command: run-doctor-hints/i);
  assert.match(rendered, /mode: dry-run-only/i);
  assert.match(rendered, /limit: 5/i);
  assert.match(rendered, /receipts:\n- 2026-03-23T08:09:05.875Z run-doctor-hints dry-run matched=2 actionable=2 changed=0 receipt=operator-actions/i);
  assert.match(rendered, /next-command: node --disable-warning=ExperimentalWarning dist\/src\/index\.js show-operator-receipt operator-actions\/2026-03-23T08-09-05\.875Z-run-doctor-hints\.json --brief/i);
});

test("renderOperatorReceiptBrief summarizes one operator receipt", () => {
  const rendered = renderOperatorReceiptBrief({
    receipt_path: "operator-actions/2026-03-23T08-09-05.875Z-run-doctor-hints.json",
    receipt: {
      schema_version: 1,
      command: "run-doctor-hints",
      created_at: "2026-03-23T08:09:05.875Z",
      dry_run: true,
      apply: false,
      selection: {
        kind: "queued_backlog",
        limit: 2,
        confirm_token: "abc123def456"
      },
      summary: {
        matched: 2,
        actionable: 2,
        changed: 0
      },
      hints: [
        {
          id: "queued-backlog-1",
          kind: "queued_backlog",
          reason: "Inspect queued task task-1 before canceling it from the backlog.",
          matched: 1,
          actionable: 1,
          changed: 0
        }
      ],
      tasks: [
        {
          task_id: "task-1",
          goal: "Summarize the current orchestration state",
          worker_target: "codex-cli",
          previous_state: "queued",
          next_state: "canceled",
          changed: true,
          reason: "Would cancel the selected task."
        }
      ]
    },
    lookup: {
      mode: "task_id",
      task_id: "task-1",
      filters: {
        command: "run-doctor-hints",
        apply_only: false,
        dry_run_only: true
      }
    }
  } satisfies OperatorReceiptResult);

  assert.match(rendered, /^receipt: operator-actions\/2026-03-23T08-09-05.875Z-run-doctor-hints\.json$/im);
  assert.match(rendered, /command: run-doctor-hints/i);
  assert.match(rendered, /mode: dry-run/i);
  assert.match(rendered, /summary: matched 2, actionable 2, changed 0/i);
  assert.match(rendered, /lookup: latest receipt for task task-1/i);
  assert.match(rendered, /lookup-filters: command=run-doctor-hints, mode=dry-run-only/i);
  assert.match(rendered, /next-command: node --disable-warning=ExperimentalWarning dist\/src\/index\.js status task-1 --brief/i);
  assert.match(rendered, /selection:\n- kind=queued_backlog/i);
  assert.match(rendered, /hints:\n- queued-backlog-1 \[queued_backlog\]/i);
  assert.match(rendered, /tasks:\n- task-1 \[queued -> canceled\]/i);
});

test("renderOperatorReceiptBrief points bulk latest receipts back to doctor", () => {
  const rendered = renderOperatorReceiptBrief({
    receipt_path: "operator-actions/2026-03-23T09-00-00.000Z-sweep-tasks.json",
    receipt: {
      schema_version: 1,
      command: "sweep-tasks",
      created_at: "2026-03-23T09:00:00.000Z",
      dry_run: true,
      apply: false,
      selection: {
        task_ids: ["task-a", "task-b"]
      },
      summary: {
        matched: 2,
        actionable: 2,
        changed: 0
      },
      tasks: [
        {
          task_id: "task-a",
          goal: "Summarize the orchestration state",
          worker_target: "codex-cli",
          previous_state: "queued",
          next_state: "canceled",
          changed: true,
          reason: "Would cancel the selected task."
        },
        {
          task_id: "task-b",
          goal: "Review the latest PR in GitHub",
          worker_target: "gemini-cli",
          previous_state: "failed",
          next_state: "canceled",
          changed: true,
          reason: "Would cancel the selected task."
        }
      ]
    },
    lookup: {
      mode: "latest",
      task_id: null,
      filters: {
        command: null,
        apply_only: false,
        dry_run_only: false
      }
    }
  } satisfies OperatorReceiptResult);

  assert.match(rendered, /^receipt: operator-actions\/2026-03-23T09-00-00\.000Z-sweep-tasks\.json$/im);
  assert.match(rendered, /next-command: node --disable-warning=ExperimentalWarning dist\/src\/index\.js doctor --brief/i);
});
