import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { SqliteTaskStore } from "../src/state-store/sqliteTaskStore";
import { createTaskSpec } from "../src/schema";
import { createTempDir, routing } from "./helpers";

test("SqliteTaskStore persists the main lifecycle", () => {
  const root = createTempDir("codex-head-store-");
  const store = new SqliteTaskStore(`${root}/codex-head.sqlite`);
  const task = createTaskSpec({
    goal: "Implement the feature",
    repo: root,
    worker_target: "claude-code",
    expected_output: { kind: "patch", format: "patch", code_change: true }
  });

  store.saveTask(task);
  store.enqueue(task.task_id);
  const claimed = store.claimNextQueued();
  assert.ok(claimed);
  assert.equal(claimed?.state, "running");
  assert.equal(claimed?.attempts, 1);

  store.finish(task.task_id, "awaiting_review", {
    task_id: task.task_id,
    worker_target: "claude-code",
    status: "awaiting_review",
    summary: "Patch ready",
    artifacts: ["/tmp/patch.diff"],
    patch_ref: "/tmp/patch.diff",
    log_ref: null,
    cost: 0,
    duration_ms: 100,
    next_action: "review",
    review_notes: []
  }, routing("claude-code", "local"));

  const updated = store.getTaskOrThrow(task.task_id);
  assert.equal(updated.state, "awaiting_review");
  assert.equal(updated.reviews.length, 0);
});

test("SqliteTaskStore rejects invalid transitions", () => {
  const root = createTempDir("codex-head-store-invalid-");
  const store = new SqliteTaskStore(`${root}/codex-head.sqlite`);
  const task = createTaskSpec({
    goal: "Review the patch",
    repo: root,
    worker_target: "codex-cli"
  });

  store.saveTask(task);
  assert.throws(() => store.finish(task.task_id, "completed", {
    task_id: task.task_id,
    worker_target: "codex-cli",
    status: "completed",
    summary: "Done",
    artifacts: [],
    patch_ref: null,
    log_ref: null,
    cost: 0,
    duration_ms: 10,
    next_action: "none",
    review_notes: []
  }, routing("codex-cli", "local")));
});

test("SqliteTaskStore archives incompatible legacy task tables and recreates schema", () => {
  const root = createTempDir("codex-head-store-legacy-");
  const dbPath = `${root}/codex-head.sqlite`;
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      task_json TEXT NOT NULL
    );
  `);
  legacyDb.close();

  const store = new SqliteTaskStore(dbPath);
  const task = createTaskSpec({
    goal: "Analyze the repo",
    repo: root,
    worker_target: "codex-cli"
  });

  store.saveTask(task);
  const reopened = new DatabaseSync(dbPath);
  const legacyTables = reopened.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'tasks_legacy_%'
  `).all() as Array<{ name: string }>;
  reopened.close();

  assert.ok(legacyTables.length >= 1);
  assert.equal(store.getTaskOrThrow(task.task_id).state, "planned");
});

test("SqliteTaskStore configures sqlite for short concurrent-write waits", () => {
  const root = createTempDir("codex-head-store-pragmas-");
  const store = new SqliteTaskStore(`${root}/codex-head.sqlite`);
  const db = (store as unknown as { db: DatabaseSync }).db;

  const busyTimeout = Object.values(db.prepare("PRAGMA busy_timeout").get() as Record<string, unknown>)[0];
  const journalMode = Object.values(db.prepare("PRAGMA journal_mode").get() as Record<string, unknown>)[0];

  assert.equal(busyTimeout, 5000);
  assert.equal(journalMode, "wal");
});

test("claimTask claims only the requested queued task", () => {
  const root = createTempDir("codex-head-store-claim-");
  const store = new SqliteTaskStore(`${root}/codex-head.sqlite`);
  const first = createTaskSpec({
    goal: "First task",
    repo: root,
    worker_target: "codex-cli",
    priority: 10
  });
  const second = createTaskSpec({
    goal: "Second task",
    repo: root,
    worker_target: "gemini-cli",
    requires_github: true,
    priority: 90
  });

  store.saveTask(first);
  store.saveTask(second);
  store.enqueue(first.task_id);
  store.enqueue(second.task_id);

  const claimed = store.claimTask(first.task_id);
  assert.ok(claimed);
  assert.equal(claimed?.task.task_id, first.task_id);
  assert.equal(claimed?.state, "running");
  assert.equal(store.getTaskOrThrow(second.task_id).state, "queued");
});

test("claimNextQueued respects task priority", () => {
  const root = createTempDir("codex-head-store-priority-");
  const store = new SqliteTaskStore(`${root}/codex-head.sqlite`);
  const low = createTaskSpec({
    goal: "Low priority task",
    repo: root,
    worker_target: "codex-cli",
    priority: 10
  });
  const high = createTaskSpec({
    goal: "High priority task",
    repo: root,
    worker_target: "codex-cli",
    priority: 90
  });

  store.saveTask(low);
  store.saveTask(high);
  store.enqueue(low.task_id);
  store.enqueue(high.task_id);

  const claimed = store.claimNextQueued();
  assert.ok(claimed);
  assert.equal(claimed?.task.task_id, high.task_id);
});
