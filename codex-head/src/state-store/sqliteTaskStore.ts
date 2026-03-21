import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  GitHubMirrorState,
  GitHubRunState,
  RoutingDecision,
  TaskRecord,
  TaskReview,
  TaskSpec,
  TaskState,
  WorkerResult
} from "../contracts";
import { TASK_STORE_SCHEMA } from "./schema";

const REQUIRED_TASK_COLUMNS = [
  "task_id",
  "state",
  "task_json",
  "result_json",
  "routing_json",
  "github_run_json",
  "github_mirror_json",
  "reviews_json",
  "attempts",
  "max_attempts",
  "next_run_at",
  "created_at",
  "updated_at",
  "started_at",
  "finished_at",
  "last_error"
];

const ADDITIVE_COLUMNS: Record<string, string> = {
  github_run_json: "TEXT",
  github_mirror_json: "TEXT",
  reviews_json: `TEXT NOT NULL DEFAULT '[]'`
};

const ALLOWED_TRANSITIONS: Record<TaskState, TaskState[]> = {
  planned: ["queued", "canceled"],
  queued: ["running", "canceled"],
  running: ["queued", "awaiting_review", "completed", "failed", "canceled"],
  awaiting_review: ["completed", "failed", "canceled"],
  completed: [],
  failed: ["queued", "canceled"],
  canceled: []
};

function assertTransition(from: TaskState, to: TaskState): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
}

function parseNullableJson<T>(value: string | null): T | null {
  return value ? JSON.parse(value) as T : null;
}

export class SqliteTaskStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.ensureCompatibleSchema();
    this.db.exec(TASK_STORE_SCHEMA);
  }

  private ensureCompatibleSchema(): void {
    const table = this.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'tasks'
    `).get() as { name?: string } | undefined;

    if (!table?.name) {
      return;
    }

    const columns = this.db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
    const available = new Set(columns.map((column) => column.name));
    const missing = REQUIRED_TASK_COLUMNS.filter((column) => !available.has(column));

    if (missing.length === 0) {
      return;
    }

    const addable = missing.every((column) => column in ADDITIVE_COLUMNS);
    if (addable) {
      for (const column of missing) {
        this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${ADDITIVE_COLUMNS[column]}`);
      }
      return;
    }

    const legacyTableName = `tasks_legacy_${Date.now()}`;
    this.db.exec(`ALTER TABLE tasks RENAME TO ${legacyTableName}`);
  }

  private rowToRecord(row: any): TaskRecord {
    return {
      task: JSON.parse(row.task_json) as TaskSpec,
      state: row.state as TaskState,
      attempts: row.attempts,
      max_attempts: row.max_attempts,
      next_run_at: row.next_run_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      last_error: row.last_error,
      result: parseNullableJson<WorkerResult>(row.result_json),
      routing: parseNullableJson<RoutingDecision>(row.routing_json),
      github_run: parseNullableJson<GitHubRunState>(row.github_run_json),
      github_mirror: parseNullableJson<GitHubMirrorState>(row.github_mirror_json),
      reviews: parseNullableJson<TaskReview[]>(row.reviews_json) ?? []
    };
  }

  saveTask(task: TaskSpec): TaskRecord {
    const now = Date.now();
    const existing = this.getTask(task.task_id);
    if (existing) {
      this.db.prepare(`
        UPDATE tasks
        SET task_json = ?, max_attempts = ?, updated_at = ?
        WHERE task_id = ?
      `).run(
        JSON.stringify(task),
        task.budget.max_attempts,
        now,
        task.task_id
      );
      return this.getTaskOrThrow(task.task_id);
    }

    this.db.prepare(`
      INSERT INTO tasks (
        task_id, state, task_json, result_json, routing_json, github_run_json, github_mirror_json, reviews_json, attempts,
        max_attempts, next_run_at, created_at, updated_at, started_at, finished_at, last_error
      ) VALUES (?, 'planned', ?, NULL, NULL, NULL, NULL, '[]', 0, ?, 0, ?, ?, NULL, NULL, NULL)
    `).run(task.task_id, JSON.stringify(task), task.budget.max_attempts, now, now);
    return this.getTaskOrThrow(task.task_id);
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE task_id = ?`).get(taskId);
    return row ? this.rowToRecord(row) : null;
  }

  getTaskOrThrow(taskId: string): TaskRecord {
    const record = this.getTask(taskId);
    if (!record) {
      throw new Error(`Task ${taskId} was not found`);
    }
    return record;
  }

  listTasks(state?: TaskState): TaskRecord[] {
    const rows = state
      ? this.db.prepare(`SELECT * FROM tasks WHERE state = ? ORDER BY created_at ASC`).all(state)
      : this.db.prepare(`SELECT * FROM tasks ORDER BY created_at ASC`).all();
    return rows.map((row: any) => this.rowToRecord(row));
  }

  recordRouting(taskId: string, routing: RoutingDecision): TaskRecord {
    this.getTaskOrThrow(taskId);
    const now = Date.now();
    this.db.prepare(`
      UPDATE tasks
      SET routing_json = ?, updated_at = ?
      WHERE task_id = ?
    `).run(JSON.stringify(routing), now, taskId);
    return this.getTaskOrThrow(taskId);
  }

  recordGitHubRun(taskId: string, githubRun: GitHubRunState | null): TaskRecord {
    this.getTaskOrThrow(taskId);
    const now = Date.now();
    this.db.prepare(`
      UPDATE tasks
      SET github_run_json = ?, updated_at = ?
      WHERE task_id = ?
    `).run(githubRun ? JSON.stringify(githubRun) : null, now, taskId);
    return this.getTaskOrThrow(taskId);
  }

  recordGitHubMirror(taskId: string, githubMirror: GitHubMirrorState | null): TaskRecord {
    this.getTaskOrThrow(taskId);
    const now = Date.now();
    this.db.prepare(`
      UPDATE tasks
      SET github_mirror_json = ?, updated_at = ?
      WHERE task_id = ?
    `).run(githubMirror ? JSON.stringify(githubMirror) : null, now, taskId);
    return this.getTaskOrThrow(taskId);
  }

  updateReviews(taskId: string, reviews: TaskReview[]): TaskRecord {
    this.getTaskOrThrow(taskId);
    const now = Date.now();
    this.db.prepare(`
      UPDATE tasks
      SET reviews_json = ?, updated_at = ?
      WHERE task_id = ?
    `).run(JSON.stringify(reviews), now, taskId);
    return this.getTaskOrThrow(taskId);
  }

  transitionTask(
    taskId: string,
    nextState: TaskState,
    patch: {
      result?: WorkerResult | null;
      routing?: RoutingDecision | null;
      github_run?: GitHubRunState | null;
      github_mirror?: GitHubMirrorState | null;
      reviews?: TaskReview[] | null;
      last_error?: string | null;
      next_run_at?: number;
      increment_attempt?: boolean;
      finished?: boolean;
    } = {}
  ): TaskRecord {
    const current = this.getTaskOrThrow(taskId);
    assertTransition(current.state, nextState);
    const now = Date.now();

    this.db.prepare(`
      UPDATE tasks
      SET state = ?,
          result_json = ?,
          routing_json = ?,
          github_run_json = ?,
          github_mirror_json = ?,
          reviews_json = ?,
          attempts = ?,
          next_run_at = ?,
          updated_at = ?,
          started_at = ?,
          finished_at = ?,
          last_error = ?
      WHERE task_id = ?
    `).run(
      nextState,
      patch.result === undefined ? JSON.stringify(current.result) : JSON.stringify(patch.result),
      patch.routing === undefined ? JSON.stringify(current.routing) : JSON.stringify(patch.routing),
      patch.github_run === undefined ? JSON.stringify(current.github_run) : JSON.stringify(patch.github_run),
      patch.github_mirror === undefined ? JSON.stringify(current.github_mirror) : JSON.stringify(patch.github_mirror),
      patch.reviews === undefined ? JSON.stringify(current.reviews) : JSON.stringify(patch.reviews),
      patch.increment_attempt ? current.attempts + 1 : current.attempts,
      patch.next_run_at ?? current.next_run_at,
      now,
      nextState === "running" ? now : current.started_at,
      patch.finished ? now : current.finished_at,
      patch.last_error === undefined ? current.last_error : patch.last_error,
      taskId
    );

    return this.getTaskOrThrow(taskId);
  }

  enqueue(taskId: string, nextRunAt = 0): TaskRecord {
    const current = this.getTaskOrThrow(taskId);
    if (current.state !== "planned" && current.state !== "failed") {
      throw new Error(`Task ${taskId} cannot be enqueued from ${current.state}`);
    }
    return this.transitionTask(taskId, "queued", {
      next_run_at: nextRunAt,
      last_error: null
    });
  }

  claimNextQueued(now = Date.now()): TaskRecord | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT * FROM tasks
        WHERE state = 'queued' AND next_run_at <= ?
        ORDER BY COALESCE(CAST(json_extract(task_json, '$.priority') AS INTEGER), 50) DESC,
                 next_run_at ASC,
                 created_at ASC
        LIMIT 1
      `).get(now);

      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }

      const current = this.rowToRecord(row);
      this.db.prepare(`
        UPDATE tasks
        SET state = 'running',
            attempts = ?,
            updated_at = ?,
            started_at = ?
        WHERE task_id = ?
      `).run(current.attempts + 1, now, now, current.task.task_id);
      this.db.exec("COMMIT");
      return this.getTaskOrThrow(current.task.task_id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claimTask(taskId: string, now = Date.now()): TaskRecord | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT * FROM tasks
        WHERE task_id = ? AND state = 'queued' AND next_run_at <= ?
        LIMIT 1
      `).get(taskId, now);

      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }

      const current = this.rowToRecord(row);
      this.db.prepare(`
        UPDATE tasks
        SET state = 'running',
            attempts = ?,
            updated_at = ?,
            started_at = ?
        WHERE task_id = ?
      `).run(current.attempts + 1, now, now, current.task.task_id);
      this.db.exec("COMMIT");
      return this.getTaskOrThrow(current.task.task_id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finish(
    taskId: string,
    state: "awaiting_review" | "completed" | "failed",
    result: WorkerResult,
    routing: RoutingDecision,
    lastError: string | null = null,
    reviews?: TaskReview[]
  ): TaskRecord {
    const current = this.getTaskOrThrow(taskId);
    assertTransition(current.state, state);
    const now = Date.now();
    this.db.prepare(`
      UPDATE tasks
      SET state = ?,
          result_json = ?,
          routing_json = ?,
          github_run_json = ?,
          github_mirror_json = ?,
          reviews_json = ?,
          updated_at = ?,
          finished_at = ?,
          last_error = ?
      WHERE task_id = ?
    `).run(
      state,
      JSON.stringify(result),
      JSON.stringify(routing),
      JSON.stringify(current.github_run),
      JSON.stringify(current.github_mirror),
      JSON.stringify(reviews ?? current.reviews),
      now,
      state === "completed" || state === "failed" ? now : null,
      lastError,
      taskId
    );
    return this.getTaskOrThrow(taskId);
  }
}
