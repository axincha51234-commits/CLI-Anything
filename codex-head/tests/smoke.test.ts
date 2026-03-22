import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ClaudeCodeAdapter } from "../src/adapter-registry/adapters/claudeCode";
import { CodexCliAdapter } from "../src/adapter-registry/adapters/codexCli";
import { GeminiCliAdapter } from "../src/adapter-registry/adapters/geminiCli";
import { AntigravityAdapter } from "../src/adapter-registry/adapters/antigravity";
import { FileArtifactStore } from "../src/artifacts/fileArtifactStore";
import type { WorkerTemplateConfig } from "../src/config";
import { createTaskSpec } from "../src/schema";
import { createTempDir } from "./helpers";

function makeNodeBackedConfig(): WorkerTemplateConfig {
  return {
    enabled: true,
    binary: "node",
    health: {
      name: "node-version",
      executable: "node",
      args: ["--version"]
    }
  };
}

test("all adapters can perform a health check with a valid binary", async () => {
  const adapters = [
    new ClaudeCodeAdapter(makeNodeBackedConfig()),
    new CodexCliAdapter(makeNodeBackedConfig()),
    new GeminiCliAdapter(makeNodeBackedConfig()),
    new AntigravityAdapter(makeNodeBackedConfig())
  ];

  for (const adapter of adapters) {
    const health = await adapter.healthCheck();
    assert.equal(health.healthy, true);
    assert.ok(health.detected_binary);
  }
});

test("missing binaries fail clearly", async () => {
  const adapter = new ClaudeCodeAdapter({
    enabled: true,
    binary: "definitely-not-a-real-binary",
    health: {
      name: "missing",
      executable: "definitely-not-a-real-binary",
      args: ["--version"]
    }
  });

  const health = await adapter.healthCheck();
  assert.equal(health.healthy, false);
  assert.equal(health.reason, "missing_binary");
});

test("local execution can run a Windows cmd wrapper when shell fallback is needed", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows-specific cmd wrapper test");
    return;
  }

  const root = createTempDir("codex-head-cmd-wrapper-");
  const binDir = join(root, "bin");
  const artifactsDir = join(root, "artifacts");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  const wrapperPath = join(binDir, "codex-fake.cmd");
  writeFileSync(wrapperPath, "@echo off\r\necho cmd wrapper ok\r\n", "utf8");

  const adapter = new CodexCliAdapter({
    enabled: true,
    binary: wrapperPath,
    local: {
      name: "codex-fake",
      executable: wrapperPath,
      args: []
    }
  });

  const task = createTaskSpec({
    goal: "Summarize the current orchestration state",
    repo: root,
    worker_target: "codex-cli"
  });
  const runtime = {
    task_file: join(root, "task.json"),
    task_goal: task.goal,
    task_prompt: "Return only the final requested content.",
    artifact_dir: join(artifactsDir, task.task_id),
    github_payload: null
  };
  const result = await adapter.execute(task, runtime, {
    cwd: root,
    artifactStore: new FileArtifactStore(artifactsDir)
  });

  assert.equal(result.status, "completed");
  assert.match(result.summary, /cmd wrapper ok/i);
});

test("local execution can run a Windows cmd wrapper from a path with spaces", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows-specific cmd wrapper test");
    return;
  }

  const root = createTempDir("codex head cmd wrapper ");
  const binDir = join(root, "bin with space");
  const artifactsDir = join(root, "artifacts");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  const wrapperPath = join(binDir, "gemini fake.cmd");
  writeFileSync(wrapperPath, "@echo off\r\necho spaced wrapper ok\r\n", "utf8");

  const adapter = new GeminiCliAdapter({
    enabled: true,
    binary: wrapperPath,
    local: {
      name: "gemini-fake",
      executable: wrapperPath,
      args: ["{{task_prompt}}"]
    }
  });

  const task = createTaskSpec({
    goal: "Summarize the current orchestration state",
    repo: root,
    worker_target: "gemini-cli"
  });
  const runtime = {
    task_file: join(root, "task.json"),
    task_goal: task.goal,
    task_prompt: "Return only the final requested content.",
    artifact_dir: join(artifactsDir, task.task_id),
    github_payload: null
  };
  const result = await adapter.execute(task, runtime, {
    cwd: root,
    artifactStore: new FileArtifactStore(artifactsDir)
  });

  assert.equal(result.status, "completed");
  assert.match(result.summary, /spaced wrapper ok/i);
  assert.match(result.log_ref ?? "", /gemini-cli-local\.combined\.log$/i);
});

test("local execution timeout tears down a Windows process tree quickly", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows-specific timeout test");
    return;
  }

  const root = createTempDir("codex head timeout ");
  const binDir = join(root, "bin with space");
  const artifactsDir = join(root, "artifacts");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  const wrapperPath = join(binDir, "sleepy worker.cmd");
  writeFileSync(
    wrapperPath,
    "@echo off\r\npowershell -NoProfile -Command \"Start-Sleep -Seconds 60\"\r\n",
    "utf8"
  );

  const adapter = new CodexCliAdapter({
    enabled: true,
    binary: wrapperPath,
    local: {
      name: "sleepy-worker",
      executable: wrapperPath,
      args: []
    }
  });

  const task = createTaskSpec({
    goal: "Summarize the current orchestration state",
    repo: root,
    worker_target: "codex-cli",
    timeout_sec: 1
  });
  const runtime = {
    task_file: join(root, "task.json"),
    task_goal: task.goal,
    task_prompt: "Return only the final requested content.",
    artifact_dir: join(artifactsDir, task.task_id),
    github_payload: null
  };

  const startedAt = Date.now();
  const result = await adapter.execute(task, runtime, {
    cwd: root,
    artifactStore: new FileArtifactStore(artifactsDir)
  });

  assert.equal(result.status, "retryable");
  assert.match(result.summary, /timed out/i);
  assert.ok(Date.now() - startedAt < 15_000);
});

test("local execution forwards interpolated environment variables", async () => {
  const root = createTempDir("codex-head-env-forwarding-");
  const artifactsDir = join(root, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });

  const workerPath = join(root, "env-worker.js");
  writeFileSync(
    workerPath,
    "console.log(`${process.env.CODEX_HEAD_PROFILE ?? 'missing'}|${process.env.CODEX_HEAD_PROMPT ?? 'missing'}`);\n",
    "utf8"
  );

  const adapter = new CodexCliAdapter({
    enabled: true,
    binary: "node",
    local: {
      name: "env-worker",
      executable: "node",
      args: [workerPath],
      env: {
        CODEX_HEAD_PROFILE: "{{task_goal}}",
        CODEX_HEAD_PROMPT: "{{task_prompt}}"
      }
    }
  });

  const task = createTaskSpec({
    goal: "Summarize the current orchestration state",
    repo: root,
    worker_target: "codex-cli"
  });
  const runtime = {
    task_file: join(root, "task.json"),
    task_goal: task.goal,
    task_prompt: "Return only the final requested content.",
    artifact_dir: join(artifactsDir, task.task_id),
    github_payload: null
  };

  const result = await adapter.execute(task, runtime, {
    cwd: root,
    artifactStore: new FileArtifactStore(artifactsDir)
  });

  assert.equal(result.status, "completed");
  assert.match(result.summary, /Summarize the current orchestration state/i);
  assert.match(result.summary, /Return only the final requested content\./i);
});
