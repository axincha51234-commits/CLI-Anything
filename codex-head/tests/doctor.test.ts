import test from "node:test";
import assert from "node:assert/strict";

import { buildDoctorReport, DOCTOR_COMMAND_HINT_KINDS, type DoctorHealthSnapshot } from "../src/doctor";
import { createTaskSpec } from "../src/schema";
import type { TaskStatusSnapshot } from "../src/status";

function createGitHubRuntime(overrides: Partial<DoctorHealthSnapshot["github"]> = {}): DoctorHealthSnapshot["github"] {
  return {
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
    matching_runners: [
      {
        id: 7,
        name: "DESKTOP-F7V83BO-codex-head",
        os: "Windows",
        status: "online",
        busy: false,
        labels: ["self-hosted", "Windows", "codex-head"],
        matches_target_labels: true
      }
    ],
    runner_lookup_detail: null,
    ...overrides
  };
}

function createStatusSnapshot(
  overrides: Partial<TaskStatusSnapshot> = {}
): TaskStatusSnapshot {
  const task = overrides.task ?? createTaskSpec({
    task_id: "task-doctor-1",
    goal: "Review the latest PR in GitHub",
    repo: "C:/repo",
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  });

  return {
    task,
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
    routing: null,
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
      actions: []
    },
    ...overrides
  };
}

test("buildDoctorReport aggregates worker, GitHub, and task findings", () => {
  const health: DoctorHealthSnapshot = {
    adapters: [
      { worker_target: "claude-code", healthy: false, reason: "Timed out while checking auth", detected_binary: "claude.exe" },
      { worker_target: "codex-cli", healthy: true, reason: "ok", detected_binary: "codex.exe" },
      { worker_target: "gemini-cli", healthy: true, reason: "ok", detected_binary: "gemini.exe" },
      { worker_target: "antigravity", healthy: false, reason: "disabled", detected_binary: "antigravity.exe" }
    ],
    readiness: [
      {
        worker_target: "claude-code",
        healthy: false,
        feature_enabled: true,
        supports_local: true,
        supports_github: false,
        has_local_template: true,
        local_ready: false,
        github_ready: false,
        cooldown_until: null,
        cooldown_reason: null
      },
      {
        worker_target: "codex-cli",
        healthy: true,
        feature_enabled: true,
        supports_local: true,
        supports_github: false,
        has_local_template: true,
        local_ready: true,
        github_ready: false,
        cooldown_until: null,
        cooldown_reason: null
      },
      {
        worker_target: "gemini-cli",
        healthy: true,
        feature_enabled: true,
        supports_local: true,
        supports_github: true,
        has_local_template: true,
        local_ready: false,
        github_ready: true,
        cooldown_until: Date.UTC(2026, 2, 23, 6, 0, 0),
        cooldown_reason: "429 RESOURCE_EXHAUSTED"
      },
      {
        worker_target: "antigravity",
        healthy: false,
        feature_enabled: false,
        supports_local: false,
        supports_github: false,
        has_local_template: false,
        local_ready: false,
        github_ready: false,
        cooldown_until: null,
        cooldown_reason: null
      }
    ],
    recent_penalties: [
      {
        worker_target: "gemini-cli",
        category: "rate_limited",
        detail: "429 RESOURCE_EXHAUSTED",
        penalized_until: Date.UTC(2026, 2, 23, 6, 0, 0),
        source_task_id: "task-penalty-1"
      }
    ],
    github: createGitHubRuntime({
      gh_authenticated: false,
      matching_runners: []
    }),
    database_path: "C:/repo/codex-head/runtime/codex-head.sqlite",
    artifacts_dir: "C:/repo/codex-head/runtime/artifacts"
  };

  const failedTask = createStatusSnapshot({
    task: createTaskSpec({
      task_id: "task-doctor-failed",
      goal: "Review the latest PR in GitHub",
      repo: "C:/repo",
      worker_target: "gemini-cli",
      expected_output: { kind: "review", format: "markdown", code_change: false },
      requires_github: true
    }),
    state: "failed",
    routing: {
      worker_target: "gemini-cli",
      mode: "github",
      reason: "test",
      fallback_from: null
    },
    operator: {
      queue_diagnosis_path: "C:/repo/codex-head/runtime/artifacts/task-doctor-failed/github-queue-diagnosis.json",
      queue_diagnosis: null,
      queue_recycle_path: "C:/repo/codex-head/runtime/artifacts/task-doctor-failed/github-queue-recycle.json",
      queue_recycle: null,
      latest_receipt_path: "operator-actions/2026-03-23T08-09-05.877Z-run-doctor-hint.json",
      latest_receipt_command: "run-doctor-hint",
      latest_receipt_created_at: "2026-03-23T08:09:05.877Z",
      manual_intervention_required: true,
      summary: "Automatic stale-runner recovery was already attempted and manual intervention is now required.",
      actions: [
        "Inspect C:/repo/codex-head/runtime/artifacts/task-doctor-failed/github-queue-recycle.json and the runner _diag logs before retrying this GitHub task."
      ]
    }
  });

  const runningTask = createStatusSnapshot({
    task: createTaskSpec({
      task_id: "task-doctor-running",
      goal: "Summarize the current orchestration state",
      repo: "C:/repo",
      worker_target: "codex-cli",
      expected_output: { kind: "analysis", format: "markdown", code_change: false }
    }),
    state: "running",
    routing: {
      worker_target: "codex-cli",
      mode: "local",
      reason: "test",
      fallback_from: null
    }
  });

  const report = buildDoctorReport(health, [failedTask, runningTask]);

  assert.equal(report.ok, false);
  assert.equal(report.counts.enabled_workers, 3);
  assert.equal(report.attention.workers.length, 2);
  assert.equal(report.attention.github.length, 2);
  assert.equal(report.attention.tasks.length, 2);
  assert.equal(report.task_filter.suppressed_task_findings, 0);
  assert.equal(report.actions.some((value) => /gh auth login/i.test(value)), true);
  assert.equal(report.actions.some((value) => /github-queue-recycle\.json/i.test(value)), true);
  assert.equal(report.command_hints.length, 0);
  assert.equal(report.summary.includes("blocking item"), true);
  assert.equal(report.attention.tasks[0]?.task_id, "task-doctor-failed");
  assert.equal(
    report.attention.tasks[0]?.operator_receipt_path,
    "operator-actions/2026-03-23T08-09-05.877Z-run-doctor-hint.json"
  );
});

test("buildDoctorReport stays healthy when workers and completed tasks are clean", () => {
  const health: DoctorHealthSnapshot = {
    adapters: [
      { worker_target: "codex-cli", healthy: true, reason: "ok", detected_binary: "codex.exe" },
      { worker_target: "gemini-cli", healthy: true, reason: "ok", detected_binary: "gemini.exe" }
    ],
    readiness: [
      {
        worker_target: "codex-cli",
        healthy: true,
        feature_enabled: true,
        supports_local: true,
        supports_github: false,
        has_local_template: true,
        local_ready: true,
        github_ready: false,
        cooldown_until: null,
        cooldown_reason: null
      },
      {
        worker_target: "gemini-cli",
        healthy: true,
        feature_enabled: true,
        supports_local: true,
        supports_github: true,
        has_local_template: true,
        local_ready: true,
        github_ready: true,
        cooldown_until: null,
        cooldown_reason: null
      }
    ],
    recent_penalties: [],
    github: createGitHubRuntime(),
    database_path: "C:/repo/codex-head/runtime/codex-head.sqlite",
    artifacts_dir: "C:/repo/codex-head/runtime/artifacts"
  };

  const completedTask = createStatusSnapshot({
    task: createTaskSpec({
      task_id: "task-doctor-clean",
      goal: "Summarize the current orchestration state",
      repo: "C:/repo",
      worker_target: "codex-cli",
      expected_output: { kind: "analysis", format: "markdown", code_change: false }
    }),
    state: "completed",
    result: {
      task_id: "task-doctor-clean",
      worker_target: "codex-cli",
      status: "completed",
      review_verdict: null,
      summary: "Completed successfully",
      artifacts: [],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 0,
      next_action: "none",
      review_notes: []
    },
    routing: {
      worker_target: "codex-cli",
      mode: "local",
      reason: "test",
      fallback_from: null
    }
  });

  const report = buildDoctorReport(health, [completedTask]);
  assert.equal(report.ok, true);
  assert.equal(report.attention.workers.length, 0);
  assert.equal(report.attention.github.length, 0);
  assert.equal(report.attention.tasks.length, 0);
  assert.equal(report.actions.length, 0);
  assert.equal(report.command_hints.length, 0);
  assert.match(report.summary, /No blocking issues found/i);
});

test("buildDoctorReport hides older failed backlog by default but can include all history", () => {
  const health: DoctorHealthSnapshot = {
    adapters: [
      { worker_target: "codex-cli", healthy: true, reason: "ok", detected_binary: "codex.exe" }
    ],
    readiness: [
      {
        worker_target: "codex-cli",
        healthy: true,
        feature_enabled: true,
        supports_local: true,
        supports_github: false,
        has_local_template: true,
        local_ready: true,
        github_ready: false,
        cooldown_until: null,
        cooldown_reason: null
      }
    ],
    recent_penalties: [],
    github: createGitHubRuntime({ enabled: false, self_hosted_targeted: false, matching_runners: [] }),
    database_path: "C:/repo/codex-head/runtime/codex-head.sqlite",
    artifacts_dir: "C:/repo/codex-head/runtime/artifacts"
  };

  const recentRunning = createStatusSnapshot({
    task: createTaskSpec({
      task_id: "task-doctor-recent-running",
      goal: "Summarize the current orchestration state",
      repo: "C:/repo",
      worker_target: "codex-cli",
      expected_output: { kind: "analysis", format: "markdown", code_change: false }
    }),
    state: "running",
    updated_at: Date.UTC(2026, 2, 23, 5, 30, 0),
    routing: {
      worker_target: "codex-cli",
      mode: "local",
      reason: "test",
      fallback_from: null
    }
  });

  const staleFailed = createStatusSnapshot({
    task: createTaskSpec({
      task_id: "task-doctor-stale-failed",
      goal: "Old failed task",
      repo: "C:/repo",
      worker_target: "codex-cli",
      expected_output: { kind: "analysis", format: "markdown", code_change: false }
    }),
    state: "failed",
    updated_at: Date.UTC(2026, 2, 22, 1, 0, 0),
    last_error: "Old failure",
    routing: {
      worker_target: "codex-cli",
      mode: "local",
      reason: "test",
      fallback_from: null
    }
  });

  const filtered = buildDoctorReport(
    health,
    [recentRunning, staleFailed],
    {
      now: Date.UTC(2026, 2, 23, 6, 0, 0),
      task_window_hours: 6
    }
  );
  assert.equal(filtered.attention.tasks.some((entry) => entry.task_id === "task-doctor-stale-failed"), false);
  assert.equal(filtered.attention.tasks.some((entry) => entry.task_id === "task-doctor-recent-running"), true);
  assert.equal(filtered.task_filter.suppressed_task_findings, 1);
  assert.equal(
    filtered.command_hints.some((entry) => entry.kind === "suppressed_failed_backlog"),
    true
  );
  assert.equal(
    filtered.command_hints.some((entry) => entry.id === "suppressed-failed-backlog"),
    true
  );

  const allTasks = buildDoctorReport(
    health,
    [recentRunning, staleFailed],
    {
      now: Date.UTC(2026, 2, 23, 6, 0, 0),
      include_all_task_history: true
    }
  );
  assert.equal(allTasks.attention.tasks.some((entry) => entry.task_id === "task-doctor-stale-failed"), true);
  assert.equal(allTasks.task_filter.suppressed_task_findings, 0);
  assert.equal(allTasks.task_filter.task_window_hours, null);
  assert.equal(allTasks.command_hints.some((entry) => entry.kind === "suppressed_failed_backlog"), false);
});

test("buildDoctorReport emits task-specific queued backlog command hints", () => {
  const health: DoctorHealthSnapshot = {
    adapters: [
      { worker_target: "codex-cli", healthy: true, reason: "ok", detected_binary: "codex.exe" }
    ],
    readiness: [
      {
        worker_target: "codex-cli",
        healthy: true,
        feature_enabled: true,
        supports_local: true,
        supports_github: false,
        has_local_template: true,
        local_ready: true,
        github_ready: false,
        cooldown_until: null,
        cooldown_reason: null
      }
    ],
    recent_penalties: [],
    github: createGitHubRuntime({ enabled: false, self_hosted_targeted: false, matching_runners: [] }),
    database_path: "C:/repo/codex-head/runtime/codex-head.sqlite",
    artifacts_dir: "C:/repo/codex-head/runtime/artifacts"
  };

  const queuedTask = createStatusSnapshot({
    task: createTaskSpec({
      task_id: "task-doctor-queued-hint",
      goal: "Summarize the current orchestration state",
      repo: "C:/repo",
      worker_target: "codex-cli",
      expected_output: { kind: "analysis", format: "markdown", code_change: false }
    }),
    state: "queued",
    routing: {
      worker_target: "codex-cli",
      mode: "local",
      reason: "test",
      fallback_from: null
    }
  });

  const report = buildDoctorReport(health, [queuedTask]);
  assert.equal(report.command_hints.some((entry) => entry.kind === "queued_backlog"), true);
  assert.equal(
    report.command_hints.some((entry) => /--task-id task-doctor-queued-hint --dry-run --brief/i.test(entry.command)),
    true
  );
  assert.equal(report.command_hints[0]?.id, "queued-backlog-1");
  assert.deepEqual(report.command_hints[0]?.sweep, {
    action: "cancel",
    task_ids: ["task-doctor-queued-hint"]
  });
});

test("buildDoctorReport only emits supported command hint kinds", () => {
  const health: DoctorHealthSnapshot = {
    adapters: [
      { worker_target: "codex-cli", healthy: true, reason: "ok", detected_binary: "codex.exe" }
    ],
    readiness: [
      {
        worker_target: "codex-cli",
        healthy: true,
        feature_enabled: true,
        supports_local: true,
        supports_github: false,
        has_local_template: true,
        local_ready: true,
        github_ready: false,
        cooldown_until: null,
        cooldown_reason: null
      }
    ],
    recent_penalties: [],
    github: createGitHubRuntime({ enabled: false, self_hosted_targeted: false, matching_runners: [] }),
    database_path: "C:/repo/codex-head/runtime/codex-head.sqlite",
    artifacts_dir: "C:/repo/codex-head/runtime/artifacts"
  };

  const queuedTask = createStatusSnapshot({
    task: createTaskSpec({
      task_id: "task-doctor-kind-queued",
      goal: "Queued task",
      repo: "C:/repo",
      worker_target: "codex-cli",
      expected_output: { kind: "analysis", format: "markdown", code_change: false }
    }),
    state: "queued",
    updated_at: Date.UTC(2026, 2, 23, 5, 59, 0),
    routing: {
      worker_target: "codex-cli",
      mode: "local",
      reason: "test",
      fallback_from: null
    }
  });

  const staleFailed = createStatusSnapshot({
    task: createTaskSpec({
      task_id: "task-doctor-kind-stale",
      goal: "Old failed task",
      repo: "C:/repo",
      worker_target: "codex-cli",
      expected_output: { kind: "analysis", format: "markdown", code_change: false }
    }),
    state: "failed",
    updated_at: Date.UTC(2026, 2, 22, 1, 0, 0),
    last_error: "Old failure",
    routing: {
      worker_target: "codex-cli",
      mode: "local",
      reason: "test",
      fallback_from: null
    }
  });

  const report = buildDoctorReport(
    health,
    [queuedTask, staleFailed],
    {
      now: Date.UTC(2026, 2, 23, 6, 0, 0),
      task_window_hours: 6
    }
  );

  assert.deepEqual(
    [...new Set(report.command_hints.map((entry) => entry.kind))].sort(),
    [...DOCTOR_COMMAND_HINT_KINDS].sort()
  );
});
