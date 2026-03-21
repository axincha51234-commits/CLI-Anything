import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { createDefaultRegistry } from "../src/adapter-registry";
import { createTaskSpec } from "../src/schema";
import { executeGitHubPayload, validateGitHubDispatchPayload } from "../src/github/workflowRunner";
import { createTempDir, createTestConfig, routing } from "./helpers";

test("validateGitHubDispatchPayload accepts a typed dispatch payload", () => {
  const root = createTempDir("codex-head-github-payload-");
  const task = createTaskSpec({
    goal: "Analyze the repository",
    repo: root,
    worker_target: "codex-cli"
  });

  const payload = validateGitHubDispatchPayload({
    repository: "example/repo",
    workflow: "codex-head-worker.yml",
    task,
    routing: routing("codex-cli", "github")
  });

  assert.equal(payload.repository, "example/repo");
  assert.equal(payload.workflow, "codex-head-worker.yml");
  assert.equal(payload.task.task_id, task.task_id);
});

test("executeGitHubPayload writes a typed callback artifact on success", async () => {
  const root = createTempDir("codex-head-github-runner-success-");
  const config = createTestConfig(root);
  config.command_templates["codex-cli"].local = {
    name: "codex-local",
    executable: "node",
    args: ["-e", "process.stdout.write('runner ok')"]
  };

  const task = createTaskSpec({
    goal: "Analyze the repository",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  });

  const execution = await executeGitHubPayload({
    repository: "example/repo",
    workflow: "codex-head-worker.yml",
    task,
    routing: routing("codex-cli", "github")
  }, config, createDefaultRegistry(config));

  assert.equal(execution.result.status, "completed");
  assert.equal(existsSync(execution.callback_path), true);
  const callback = JSON.parse(readFileSync(execution.callback_path, "utf8")) as { worker_target: string; status: string };
  assert.equal(callback.worker_target, "codex-cli");
  assert.equal(callback.status, "completed");
});

test("executeGitHubPayload still writes a callback artifact when local execution is unavailable", async () => {
  const root = createTempDir("codex-head-github-runner-fail-");
  const config = createTestConfig(root);
  config.command_templates["codex-cli"].local = undefined;

  const task = createTaskSpec({
    goal: "Analyze the repository",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  });

  const execution = await executeGitHubPayload({
    repository: "example/repo",
    workflow: "codex-head-worker.yml",
    task,
    routing: routing("codex-cli", "github")
  }, config, createDefaultRegistry(config));

  assert.equal(execution.result.status, "failed");
  assert.match(execution.result.summary, /No local command template is configured/i);
  assert.equal(existsSync(execution.callback_path), true);
});
