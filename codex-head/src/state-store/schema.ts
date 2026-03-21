export const TASK_STORE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    task_json TEXT NOT NULL,
    result_json TEXT,
    routing_json TEXT,
    github_run_json TEXT,
    github_mirror_json TEXT,
    reviews_json TEXT NOT NULL DEFAULT '[]',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    next_run_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    last_error TEXT
  );
`;
