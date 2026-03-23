import test from "node:test";
import assert from "node:assert/strict";

import { renderOutcomeBrief, renderStatusBrief } from "../src/brief";
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
      manual_intervention_required: true,
      summary: "Automatic stale-runner recovery was already attempted and manual intervention is now required.",
      actions: [
        "Inspect C:/artifacts/task-brief-1/github-queue-recycle.json and the runner _diag logs before retrying this GitHub task."
      ]
    }
  } satisfies TaskStatusSnapshot);

  assert.match(rendered, /task task-brief-1 \[failed\] Review the latest PR in GitHub/i);
  assert.match(rendered, /worker: gemini-cli via github/i);
  assert.match(rendered, /operator: Automatic stale-runner recovery was already attempted/i);
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
