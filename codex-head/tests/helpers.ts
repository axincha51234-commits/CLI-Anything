import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AdapterCapability,
  AdapterHealth,
  RoutingDecision,
  TaskRuntimeContext,
  TaskSpec,
  WorkerResult,
  WorkerTarget
} from "../src/contracts";
import type { WorkerAdapter, WorkerExecutionOptions } from "../src/adapter-registry/base";
import type { CodexHeadConfig } from "../src/config";
import { createDefaultConfig } from "../src/config";
import { AdapterRegistry } from "../src/adapter-registry";
import { FileArtifactStore } from "../src/artifacts/fileArtifactStore";
import { GitHubControlPlane } from "../src/github/controlPlane";
import { CodexHeadPlanner } from "../src/planner";
import { SqliteTaskStore } from "../src/state-store/sqliteTaskStore";
import { CodexHeadOrchestrator } from "../src/orchestrator";

export function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function createTestConfig(root: string): CodexHeadConfig {
  const config = createDefaultConfig(root);
  config.app_root = root;
  config.workspace_root = root;
  config.artifacts_dir = join(root, "artifacts");
  config.database_path = join(root, "codex-head.sqlite");
  config.command_templates["claude-code"].local = {
    name: "claude-local",
    executable: "node",
    args: ["--version"]
  };
  config.command_templates["codex-cli"].local = {
    name: "codex-local",
    executable: "node",
    args: ["--version"]
  };
  config.command_templates["gemini-cli"].local = {
    name: "gemini-local",
    executable: "node",
    args: ["--version"]
  };
  config.github = {
    enabled: true,
    repository: "test/repo",
    workflow: "codex-head-worker.yml",
    review_workflow: "codex-head-gemini-review.yml",
    dispatch_mode: "artifacts_only",
    cli_binary: "gh"
  };
  return config;
}

export function makeCapability(target: WorkerTarget, overrides: Partial<AdapterCapability> = {}): AdapterCapability {
  return {
    worker_target: target,
    supports_local: true,
    supports_github: target === "gemini-cli",
    can_edit_code: target !== "antigravity",
    can_review: true,
    can_run_tests: target !== "antigravity",
    max_concurrency: 1,
    required_binaries: [target],
    feature_flag: target === "antigravity" ? "antigravity" : null,
    ...overrides
  };
}

export function createHealthyHealth(target: WorkerTarget): AdapterHealth {
  return {
    worker_target: target,
    healthy: true,
    reason: "ok",
    detected_binary: `${target}.exe`
  };
}

export class FakeAdapter implements WorkerAdapter {
  constructor(
    public readonly capability: AdapterCapability,
    private readonly health: AdapterHealth,
    private readonly handler: (
      task: TaskSpec,
      runtime: TaskRuntimeContext,
      options: WorkerExecutionOptions
    ) => Promise<WorkerResult>
  ) {}

  async healthCheck(): Promise<AdapterHealth> {
    return this.health;
  }

  async execute(
    task: TaskSpec,
    runtime: TaskRuntimeContext,
    options: WorkerExecutionOptions
  ): Promise<WorkerResult> {
    return this.handler(task, runtime, options);
  }
}

export function createAppWithRegistry(root: string, registry: AdapterRegistry, config?: CodexHeadConfig): CodexHeadOrchestrator {
  const resolvedConfig = config ?? createTestConfig(root);
  const artifactStore = new FileArtifactStore(resolvedConfig.artifacts_dir);
  const taskStore = new SqliteTaskStore(resolvedConfig.database_path);
  const planner = new CodexHeadPlanner(resolvedConfig.methodology_refs, {
    github_enabled: resolvedConfig.github.enabled,
    antigravity_enabled: Boolean(resolvedConfig.feature_flags.antigravity),
    local_reviewers: ["gemini-cli", "codex-cli", "claude-code"].filter((target) => {
      const template = resolvedConfig.command_templates[target as "gemini-cli" | "codex-cli" | "claude-code"];
      return Boolean(template.enabled && template.local);
    }) as WorkerTarget[]
  });
  const github = new GitHubControlPlane(resolvedConfig, artifactStore);
  const app = new CodexHeadOrchestrator(resolvedConfig, registry);
  (app as any).artifactStore = artifactStore;
  (app as any).taskStore = taskStore;
  (app as any).planner = planner;
  (app as any).github = github;
  return app;
}

export function routing(target: WorkerTarget, mode: RoutingDecision["mode"]): RoutingDecision {
  return {
    worker_target: target,
    mode,
    reason: "test",
    fallback_from: null
  };
}
