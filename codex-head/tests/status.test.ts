import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { FileArtifactStore } from "../src/artifacts/fileArtifactStore";
import { buildTaskStatusSnapshot, buildTaskStatusSnapshots } from "../src/status";
import { createTaskSpec } from "../src/schema";
import type { TaskRecord, WorkerResult } from "../src/contracts";
import { createTempDir } from "./helpers";

function createRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const task = overrides.task ?? createTaskSpec({
    goal: "Review the latest PR in GitHub",
    repo: "C:/repo",
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  });
  const now = Date.now();
  const defaultResult: WorkerResult = {
    task_id: task.task_id,
    worker_target: task.worker_target,
    status: "failed",
    review_verdict: null,
    summary: "GitHub callback reconciliation failed",
    artifacts: [],
    patch_ref: null,
    log_ref: null,
    cost: 0,
    duration_ms: 0,
    next_action: "manual",
    review_notes: []
  };

  return {
    task,
    state: "failed",
    attempts: 1,
    max_attempts: task.budget.max_attempts,
    next_run_at: now,
    created_at: now,
    updated_at: now,
    started_at: now,
    finished_at: now,
    last_error: null,
    result: defaultResult,
    routing: {
      worker_target: task.worker_target,
      mode: "github",
      reason: "test",
      fallback_from: null
    },
    github_run: null,
    github_mirror: null,
    reviews: [],
    ...overrides
  };
}

test("buildTaskStatusSnapshot surfaces queue diagnosis and recycle state", () => {
  const root = createTempDir("codex-head-status-");
  const artifactStore = new FileArtifactStore(resolve(root, "artifacts"));
  const record = createRecord({
    last_error: "Automatic stale-runner recovery was already attempted and manual intervention is now required.",
    result: {
      task_id: "unused",
      worker_target: "gemini-cli",
      status: "failed",
      review_verdict: null,
      summary: "Recovered unresolved GitHub task",
      artifacts: [],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 0,
      next_action: "manual",
      review_notes: [
        "Fallback callback sync also failed after queue recovery."
      ]
    }
  });

  artifactStore.writeJson(record.task.task_id, "github-queue-diagnosis.json", {
    task_id: record.task.task_id,
    run_id: 321,
    likely_stalled: true,
    reason: "The run is still queued even though a matching self-hosted runner appears online and idle; a stale broker session is likely.",
    suggested_action: "Consider recycling the self-hosted runner before retrying."
  });
  artifactStore.writeJson(record.task.task_id, "github-queue-recycle.json", {
    task_id: record.task.task_id,
    run_id: 321,
    ok: true,
    skipped: false,
    detail: "Automatic self-hosted runner recycle completed successfully."
  });
  const latestReceiptPath = artifactStore.writeOperatorReceipt("run-doctor-hint", {
    schema_version: 1,
    command: "run-doctor-hint",
    created_at: "2026-03-23T09:00:00.000Z",
    dry_run: true,
    apply: false,
    selection: {
      task_ids: [record.task.task_id]
    },
    summary: {
      matched: 1,
      actionable: 1,
      changed: 0
    }
  });

  const snapshot = buildTaskStatusSnapshot(record, artifactStore);
  assert.equal(snapshot.operator.queue_diagnosis?.likely_stalled, true);
  assert.match(snapshot.operator.queue_diagnosis_path ?? "", /github-queue-diagnosis\.json$/i);
  assert.equal(snapshot.operator.queue_recycle?.ok, true);
  assert.match(snapshot.operator.queue_recycle_path ?? "", /github-queue-recycle\.json$/i);
  assert.match(
    snapshot.artifact_dir_path,
    new RegExp(`artifacts[\\\\/]${record.task.task_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")
  );
  assert.equal(snapshot.operator.latest_receipt_path, latestReceiptPath);
  assert.equal(snapshot.operator.latest_receipt_command, "run-doctor-hint");
  assert.equal(snapshot.operator.latest_receipt_created_at, "2026-03-23T09:00:00.000Z");
  assert.deepEqual(snapshot.artifact_refs, {
    worker_result: null,
    execution_attempts: null,
    primary_output: null,
    primary_log: null
  });
  assert.equal(snapshot.operator.manual_intervention_required, true);
  assert.match(snapshot.operator.summary ?? "", /manual intervention is now required/i);
  assert.equal(snapshot.operator.actions.some((value) => /inspect .*github-queue-recycle\.json/i.test(value)), true);
});

test("buildTaskStatusSnapshots stays read-only when queue artifacts do not exist", () => {
  const root = createTempDir("codex-head-status-clean-");
  const artifactStore = new FileArtifactStore(resolve(root, "artifacts"));
  const record = createRecord({
    state: "completed",
    last_error: null,
    result: {
      task_id: "unused",
      worker_target: "gemini-cli",
      status: "completed",
      review_verdict: "commented",
      summary: "GitHub task completed normally",
      artifacts: [],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 0,
      next_action: "none",
      review_notes: []
    }
  });
  const taskDir = resolve(root, "artifacts", record.task.task_id);

  assert.equal(existsSync(taskDir), false);
  const [snapshot] = buildTaskStatusSnapshots([record], artifactStore);

  assert.equal(existsSync(taskDir), false);
  assert.match(
    snapshot?.artifact_dir_path ?? "",
    new RegExp(`artifacts[\\\\/]${record.task.task_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")
  );
  assert.equal(snapshot?.operator.queue_diagnosis, null);
  assert.equal(snapshot?.operator.queue_recycle, null);
  assert.equal(snapshot?.operator.latest_receipt_path, null);
  assert.equal(snapshot?.operator.latest_receipt_command, null);
  assert.equal(snapshot?.operator.latest_receipt_created_at, null);
  assert.deepEqual(snapshot?.artifact_refs, {
    worker_result: null,
    execution_attempts: null,
    primary_output: null,
    primary_log: null
  });
  assert.equal(snapshot?.operator.manual_intervention_required, false);
  assert.equal(snapshot?.operator.summary, null);
  assert.deepEqual(snapshot?.operator.actions, []);
});

test("buildTaskStatusSnapshot prefers the newest matching operator receipt", async () => {
  const root = createTempDir("codex-head-status-latest-receipt-");
  const artifactStore = new FileArtifactStore(resolve(root, "artifacts"));
  const record = createRecord();

  artifactStore.writeOperatorReceipt("sweep-tasks", {
    schema_version: 1,
    command: "sweep-tasks",
    created_at: "2026-03-23T08:59:00.000Z",
    dry_run: true,
    apply: false,
    selection: {
      task_ids: [record.task.task_id]
    },
    summary: {
      matched: 1,
      actionable: 1,
      changed: 0
    }
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  const latestReceiptPath = artifactStore.writeOperatorReceipt("run-doctor-hint", {
    schema_version: 1,
    command: "run-doctor-hint",
    created_at: "2026-03-23T09:01:00.000Z",
    dry_run: true,
    apply: false,
    selection: {
      task_ids: [record.task.task_id]
    },
    summary: {
      matched: 1,
      actionable: 1,
      changed: 0
    }
  });

  const snapshot = buildTaskStatusSnapshot(record, artifactStore);
  assert.equal(snapshot.operator.latest_receipt_path, latestReceiptPath);
  assert.equal(snapshot.operator.latest_receipt_command, "run-doctor-hint");
});

test("buildTaskStatusSnapshot surfaces canonical artifact refs when present", () => {
  const root = createTempDir("codex-head-status-artifact-refs-");
  const artifactStore = new FileArtifactStore(resolve(root, "artifacts"));
  const record = createRecord({
    result: {
      task_id: "unused",
      worker_target: "gemini-cli",
      status: "completed",
      review_verdict: "commented",
      summary: "Worker completed successfully",
      artifacts: [
        resolve(root, "artifacts", "task-output", "worker-output.md")
      ],
      patch_ref: null,
      log_ref: resolve(root, "artifacts", "task-output", "gemini-cli-local.combined.log"),
      cost: 0,
      duration_ms: 0,
      next_action: "none",
      review_notes: []
    }
  });
  const taskId = record.task.task_id;

  artifactStore.writeJson(taskId, "worker-result.json", { ok: true });
  artifactStore.writeJson(taskId, "execution-attempts.json", { attempts: [] });

  const snapshot = buildTaskStatusSnapshot(record, artifactStore);
  assert.match(snapshot.artifact_refs.worker_result?.path ?? "", /worker-result\.json$/i);
  assert.equal(snapshot.artifact_refs.worker_result?.freshness, "current");
  assert.match(snapshot.artifact_refs.execution_attempts?.path ?? "", /execution-attempts\.json$/i);
  assert.equal(snapshot.artifact_refs.execution_attempts?.freshness, "history");
  assert.match(snapshot.artifact_refs.primary_output?.path ?? "", /worker-output\.md$/i);
  assert.equal(snapshot.artifact_refs.primary_output?.freshness, "current");
  assert.match(snapshot.artifact_refs.primary_log?.path ?? "", /gemini-cli-local\.combined\.log$/i);
  assert.equal(snapshot.artifact_refs.primary_log?.freshness, "current");
});

test("buildTaskStatusSnapshot marks active-task result refs as last_attempt", () => {
  const root = createTempDir("codex-head-status-active-artifact-refs-");
  const artifactStore = new FileArtifactStore(resolve(root, "artifacts"));
  const taskId = "task-active-last-attempt";
  const record = createRecord({
    task: createTaskSpec({
      task_id: taskId,
      goal: "Summarize the current orchestration state",
      repo: "C:/repo",
      worker_target: "codex-cli",
      expected_output: { kind: "analysis", format: "markdown", code_change: false }
    }),
    state: "queued",
    result: {
      task_id: taskId,
      worker_target: "codex-cli",
      status: "failed",
      review_verdict: null,
      summary: "Previous attempt failed",
      artifacts: [],
      patch_ref: null,
      log_ref: resolve(root, "artifacts", taskId, "codex-cli-local.combined.log"),
      cost: 0,
      duration_ms: 0,
      next_action: "retry",
      review_notes: []
    }
  });

  artifactStore.writeJson(taskId, "worker-result.json", { ok: false });
  artifactStore.writeJson(taskId, "execution-attempts.json", { attempts: [] });

  const snapshot = buildTaskStatusSnapshot(record, artifactStore);
  assert.equal(snapshot.artifact_refs.worker_result?.freshness, "last_attempt");
  assert.equal(snapshot.artifact_refs.execution_attempts?.freshness, "history");
  assert.equal(snapshot.artifact_refs.primary_log?.freshness, "last_attempt");
});

test("buildTaskStatusSnapshot recommends concrete actions for busy runners and gh auth failures", () => {
  const root = createTempDir("codex-head-status-actions-");
  const artifactStore = new FileArtifactStore(resolve(root, "artifacts"));
  const record = createRecord({
    last_error: "GitHub callback sync requires gh authentication",
    result: {
      task_id: "unused",
      worker_target: "gemini-cli",
      status: "failed",
      review_verdict: null,
      summary: "GitHub callback sync requires gh authentication",
      artifacts: [],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 0,
      next_action: "manual",
      review_notes: []
    }
  });

  artifactStore.writeJson(record.task.task_id, "github-queue-diagnosis.json", {
    task_id: record.task.task_id,
    run_id: 654,
    likely_stalled: true,
    reason: "Matching self-hosted runners are all busy.",
    suggested_action: "Wait for a runner slot or free one of the matching runners."
  });

  const snapshot = buildTaskStatusSnapshot(record, artifactStore);
  assert.equal(snapshot.operator.manual_intervention_required, false);
  assert.equal(
    snapshot.operator.actions.some((value) => /wait for a runner slot/i.test(value)),
    true
  );
  assert.equal(
    snapshot.operator.actions.some((value) => /gh auth login/i.test(value)),
    true
  );
});
