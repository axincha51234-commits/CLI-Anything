import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createDefaultConfig, loadConfig, resolveMachineConfigPath, updateGitHubConfig } from "../src/config";
import { createTempDir } from "./helpers";

test("loadConfig accepts camelCase external config keys", () => {
  const root = createTempDir("codex-head-config-");
  const configPath = join(root, "workers.local.json");
  writeFileSync(configPath, JSON.stringify({
    github: {
      executionPreference: "local_preferred"
    },
    featureFlags: {
      antigravity: true
    },
    commandTemplates: {
      "codex-cli": {
        local: {
          name: "codex-task",
          executable: "codex",
          args: ["exec", "{{task_goal}}"],
          env: {
            "CODEX_HEAD_PROFILE": "{{task_goal}}"
          }
        }
      }
    }
  }, null, 2), "utf8");

  const config = loadConfig(root, configPath);
  assert.equal(config.feature_flags.antigravity, true);
  assert.equal(config.github.execution_preference, "local_preferred");
  assert.equal(config.command_templates["codex-cli"].local?.name, "codex-task");
  assert.equal(
    config.command_templates["codex-cli"].local?.env?.CODEX_HEAD_PROFILE,
    "{{task_goal}}"
  );
});

test("createDefaultConfig provides safe local execution templates", () => {
  const root = createTempDir("codex-head-default-config-");
  const config = createDefaultConfig(root);

  assert.equal(config.github.enabled, false);
  assert.equal(config.github.execution_preference, "remote_only");
  assert.deepEqual(config.command_templates["claude-code"].local?.args, [
    "-p",
    "--permission-mode",
    "plan",
    "--output-format",
    "text",
    "{{task_prompt}}"
  ]);
  assert.deepEqual(config.command_templates["codex-cli"].local?.args, [
    "exec",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "--color",
    "never",
    "{{task_prompt}}"
  ]);
  assert.deepEqual(config.command_templates["gemini-cli"].local?.args, [
    "-m",
    "gemini-2.5-flash",
    "-p",
    "{{task_prompt}}",
    "--approval-mode",
    "plan",
    "--output-format",
    "text"
  ]);
});

test("createDefaultConfig uses GITHUB_REPOSITORY when available", () => {
  const previous = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY = "axincha51234-commits/codex-head-test";

  try {
    const root = createTempDir("codex-head-default-config-repo-");
    const config = createDefaultConfig(root);
    assert.equal(config.github.repository, "axincha51234-commits/codex-head-test");
  } finally {
    if (previous === undefined) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = previous;
    }
  }
});

test("updateGitHubConfig writes a repository override to workers.local.json", () => {
  const root = createTempDir("codex-head-update-github-config-");
  const result = updateGitHubConfig(root, {
    repository: "axincha51234-commits/codex-head-test",
    dispatch_mode: "gh_cli"
  });

  const config = loadConfig(root, result.path);
  assert.equal(config.github.repository, "axincha51234-commits/codex-head-test");
  assert.equal(config.github.dispatch_mode, "gh_cli");
});

test("loadConfig merges workers.machine.json after workers.local.json by default", () => {
  const root = createTempDir("codex-head-machine-config-");
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });

  writeFileSync(join(configDir, "workers.local.json"), JSON.stringify({
    github: {
      enabled: true,
      execution_preference: "remote_only"
    },
    command_templates: {
      "gemini-cli": {
        local: {
          name: "gemini-local",
          executable: "gemini",
          args: ["-p", "{{task_prompt}}"],
          env: {
            GEMINI_API_KEY: "shared-placeholder"
          }
        }
      }
    }
  }, null, 2), "utf8");

  writeFileSync(resolveMachineConfigPath(root), JSON.stringify({
    github: {
      execution_preference: "local_preferred"
    },
    command_templates: {
      "gemini-cli": {
        local: {
          name: "gemini-machine",
          executable: "gemini",
          args: ["-m", "gemini-2.5-flash", "-p", "{{task_prompt}}"],
          env: {
            GEMINI_API_KEY: "machine-secret"
          }
        }
      }
    }
  }, null, 2), "utf8");

  const config = loadConfig(root);
  assert.equal(config.github.enabled, true);
  assert.equal(config.github.execution_preference, "local_preferred");
  assert.equal(config.command_templates["gemini-cli"].local?.name, "gemini-machine");
  assert.equal(config.command_templates["gemini-cli"].local?.env?.GEMINI_API_KEY, "machine-secret");
});
