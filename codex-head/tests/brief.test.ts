import test from "node:test";
import assert from "node:assert/strict";

import {
  renderDoctorBrief,
  renderOperatorReceiptBrief,
  renderOperatorHistoryBrief,
  renderOutcomeBrief,
  renderRunDoctorHintsBrief,
  renderStatusBrief,
  renderSweepBrief
} from "../src/brief";
import type { DoctorReport } from "../src/doctor";
import type { OperatorHistoryResult, OperatorReceiptResult, SweepTasksResult } from "../src/orchestrator";
import { createTaskSpec } from "../src/schema";
import type { TaskStatusSnapshot } from "../src/status";

test("renderStatusBrief summarizes one task with operator guidance", () => {
  const task = createTaskSpec({
    task_id: "task-brief-1",
    goal: "Review the latest PR in GitHub",
    repo: "C:/repo",
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  });

  const rendered = renderStatusBrief({
    task,
    artifact_dir_path: "C:/repo/codex-head/runtime/artifacts/task-brief-1",
    artifact_refs: {
      worker_result: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-1/worker-result.json", freshness: "current" },
      execution_attempts: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-1/execution-attempts.json", freshness: "history" },
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
  assert.match(rendered, /worker: gemini-cli via github/i);
  assert.match(rendered, /artifacts: C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-1/i);
  assert.match(rendered, /worker-result: C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-1\/worker-result\.json/i);
  assert.match(rendered, /attempts \(history\): C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-1\/execution-attempts\.json/i);
  assert.match(rendered, /output: C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-1\/worker-output\.md/i);
  assert.match(rendered, /log: C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-1\/gemini-cli-local\.combined\.log/i);
  assert.match(rendered, /github-url: https:\/\/github\.com\/example\/repo\/actions\/runs\/321/i);
  assert.match(rendered, /operator: Automatic stale-runner recovery was already attempted/i);
  assert.match(rendered, /receipt: operator-actions\/2026-03-23T08-09-05\.877Z-run-doctor-hint\.json \[run-doctor-hint\]/i);
  assert.match(rendered, /open-receipt: node dist\/src\/index\.js show-operator-receipt operator-actions\/2026-03-23T08-09-05\.877Z-run-doctor-hint\.json --brief/i);
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
      tasks: [
        {
          task_id: "task-brief-doctor",
          state: "failed",
          goal: "Review the latest PR in GitHub",
          worker_target: "gemini-cli",
          routing_mode: "github",
          artifact_dir_path: "C:/repo/codex-head/runtime/artifacts/task-brief-doctor",
          artifact_refs: {
            worker_result: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-doctor/worker-result.json", freshness: "current" },
            execution_attempts: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-doctor/execution-attempts.json", freshness: "history" },
            primary_output: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-doctor/worker-output.md", freshness: "current" },
            primary_log: { path: "C:/repo/codex-head/runtime/artifacts/task-brief-doctor/gemini-cli-local.combined.log", freshness: "current" }
          },
          github_run_url: "https://github.com/example/repo/actions/runs/321",
          severity: "error",
          summary: "Automatic stale-runner recovery was already attempted and manual intervention is now required.",
          actions: ["Inspect C:/repo/codex-head/runtime/artifacts/task-brief-doctor/github-queue-recycle.json and retry."],
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
        command: "node dist/src/index.js sweep-tasks cancel --state failed --older-than-hours 6 --dry-run --brief",
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
  assert.match(rendered, /workers:\n- claude-code \[error\] Worker claude-code health check failed/i);
  assert.match(rendered, /github:\n- \[error\] GitHub dispatch is enabled but gh is not authenticated/i);
  assert.match(rendered, /tasks:\n- task-brief-doctor \[failed\/error\] Review the latest PR in GitHub/i);
  assert.match(rendered, /receipt=operator-actions\/2026-03-23T08-09-05\.877Z-run-doctor-hint\.json \[run-doctor-hint\]/i);
  assert.match(rendered, /receipt-commands:\n- task-brief-doctor :: node dist\/src\/index\.js show-operator-receipt operator-actions\/2026-03-23T08-09-05\.877Z-run-doctor-hint\.json --brief/i);
  assert.match(rendered, /task-links:\n- task-brief-doctor :: artifacts=C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-doctor :: github=https:\/\/github\.com\/example\/repo\/actions\/runs\/321/i);
  assert.match(rendered, /artifact-files:\n- task-brief-doctor :: result=C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-doctor\/worker-result\.json :: attempts\(history\)=C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-doctor\/execution-attempts\.json :: output=C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-doctor\/worker-output\.md :: log=C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-doctor\/gemini-cli-local\.combined\.log/i);
  assert.match(rendered, /next:\n- Inspect the claude-code health command and local runtime\./i);
  assert.match(rendered, /commands:\n- \[suppressed-failed-backlog\] node dist\/src\/index\.js sweep-tasks cancel --state failed --older-than-hours 6 --dry-run --brief/i);
});

test("renderDoctorBrief keeps receipt commands aligned with visible task rows", () => {
  const tasks: DoctorReport["attention"]["tasks"] = Array.from({ length: 9 }, (_, index) => ({
    task_id: `task-brief-visible-${index + 1}`,
    state: "queued",
    goal: `Queued task ${index + 1}`,
    worker_target: "codex-cli",
    routing_mode: "local",
    artifact_dir_path: `C:/repo/codex-head/runtime/artifacts/task-brief-visible-${index + 1}`,
    artifact_refs: {
      worker_result: index < 2
        ? { path: `C:/repo/codex-head/runtime/artifacts/task-brief-visible-${index + 1}/worker-result.json`, freshness: "last_attempt" }
        : null,
      execution_attempts: index < 2
        ? { path: `C:/repo/codex-head/runtime/artifacts/task-brief-visible-${index + 1}/execution-attempts.json`, freshness: "history" }
        : null,
      primary_output: null,
      primary_log: index < 2
        ? { path: `C:/repo/codex-head/runtime/artifacts/task-brief-visible-${index + 1}/codex-cli-local.combined.log`, freshness: "last_attempt" }
        : null
    },
    github_run_url: null,
    severity: "warning",
    summary: "Task is queued and waiting for dispatch.",
    actions: ["Dispatch the queued task when the workspace and workers are ready."],
    operator_receipt_path: `operator-actions/2026-03-23T08-09-0${index}.000Z-run-doctor-hint.json`,
    operator_receipt_command: "run-doctor-hint",
    operator_receipt_created_at: `2026-03-23T08:09:0${index}.000Z`,
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
      database_path: "C:/repo/codex-head/runtime/codex-head.sqlite",
      artifacts_dir: "C:/repo/codex-head/runtime/artifacts"
    },
    attention: {
      workers: [],
      github: [],
      tasks
    },
    actions: ["Dispatch the queued task when the workspace and workers are ready."],
    command_hints: []
  };

  const rendered = renderDoctorBrief(report);
  assert.match(rendered, /tasks:\n- task-brief-visible-1/i);
  assert.doesNotMatch(rendered, /task-brief-visible-9/i);
  assert.match(rendered, /receipt-commands:\n- task-brief-visible-1 :: node dist\/src\/index\.js show-operator-receipt operator-actions\/2026-03-23T08-09-00\.000Z-run-doctor-hint\.json --brief/i);
  assert.match(rendered, /artifact-files:\n- task-brief-visible-1 :: result\(last-attempt\)=C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-visible-1\/worker-result\.json :: attempts\(history\)=C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-visible-1\/execution-attempts\.json :: log\(last-attempt\)=C:\/repo\/codex-head\/runtime\/artifacts\/task-brief-visible-1\/codex-cli-local\.combined\.log/i);
  assert.doesNotMatch(rendered, /receipt-commands:[\s\S]*task-brief-visible-9/i);
  assert.doesNotMatch(rendered, /artifact-files:[\s\S]*task-brief-visible-9/i);
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
        database_path: "C:/repo/codex-head/runtime/codex-head.sqlite",
        artifacts_dir: "C:/repo/codex-head/runtime/artifacts"
      },
      attention: {
        workers: [],
        github: [],
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
          command: "node dist/src/index.js sweep-tasks cancel --task-id task-1 --dry-run --brief",
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
          command: "node dist/src/index.js sweep-tasks cancel --task-id task-2 --dry-run --brief",
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
          command: "node dist/src/index.js sweep-tasks cancel --task-id task-1 --dry-run --brief",
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
          command: "node dist/src/index.js sweep-tasks cancel --task-id task-2 --dry-run --brief",
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
  assert.match(rendered, /selection:\n- kind=queued_backlog/i);
  assert.match(rendered, /hints:\n- queued-backlog-1 \[queued_backlog\]/i);
  assert.match(rendered, /tasks:\n- task-1 \[queued -> canceled\]/i);
});
