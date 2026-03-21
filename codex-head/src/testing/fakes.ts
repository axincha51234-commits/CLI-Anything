import type {
  AdapterCapability,
  PlannerDecision,
  TaskSpec,
  WorkerResult,
  WorkerTarget,
} from "../contracts";
import type { FileArtifactStore } from "../artifacts/fileArtifactStore";
import type { CodexHeadConfig } from "../config";
import { AdapterRegistry } from "../adapter-registry";
import type { WorkerExecutionContext } from "../adapter-registry/base";

class FakeAdapter {
  constructor(
    public readonly target: WorkerTarget,
    public readonly capability: AdapterCapability,
    private readonly resultStatus: WorkerResult["status"] = "needs_review",
  ) {}

  healthCheck(config: CodexHeadConfig) {
    const enabled = config.workerFlags[this.target];
    return {
      worker_target: this.target,
      healthy: enabled,
      details: enabled ? "fake adapter healthy" : "feature flag disabled",
      capability: this.capability,
    };
  }

  async run(
    task: TaskSpec,
    _decision: PlannerDecision,
    context: WorkerExecutionContext,
  ): Promise<WorkerResult> {
    const artifact = context.artifactStore.writeJsonArtifact(
      task.task_id,
      "worker-request",
      `${this.target}-fake-request`,
      { task_id: task.task_id, worker_target: this.target },
      { fake: true },
    );

    return {
      task_id: task.task_id,
      worker_target: this.target,
      status: this.resultStatus,
      summary: `${this.target} fake execution`,
      artifacts: [artifact],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 1,
      next_action: null,
      review_notes: [],
    };
  }
}

export function createFakeRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  const fake = (
    target: WorkerTarget,
    capability: Omit<AdapterCapability, "worker_target">,
  ) =>
    Object.assign(
      new FakeAdapter(target, { worker_target: target, ...capability }),
      { target },
    );

  registry.register(
    fake("claude-code", {
      supports_local: true,
      supports_github: false,
      can_edit_code: true,
      can_review: true,
      can_run_tests: true,
      max_concurrency: 2,
      required_binaries: [],
      feature_flag: "CODEX_HEAD_ENABLE_CLAUDE_CODE",
    }) as never,
  );
  registry.register(
    fake("codex-cli", {
      supports_local: true,
      supports_github: true,
      can_edit_code: true,
      can_review: true,
      can_run_tests: true,
      max_concurrency: 2,
      required_binaries: [],
      feature_flag: "CODEX_HEAD_ENABLE_CODEX_CLI",
    }) as never,
  );
  registry.register(
    fake("gemini-cli", {
      supports_local: true,
      supports_github: true,
      can_edit_code: false,
      can_review: true,
      can_run_tests: false,
      max_concurrency: 4,
      required_binaries: [],
      feature_flag: "CODEX_HEAD_ENABLE_GEMINI_CLI",
    }) as never,
  );
  registry.register(
    fake("antigravity", {
      supports_local: true,
      supports_github: false,
      can_edit_code: false,
      can_review: false,
      can_run_tests: false,
      max_concurrency: 1,
      required_binaries: [],
      feature_flag: "CODEX_HEAD_ENABLE_ANTIGRAVITY",
    }) as never,
  );
  return registry;
}

export function createFakeContext(
  config: CodexHeadConfig,
  artifactStore: FileArtifactStore,
): WorkerExecutionContext {
  return { config, artifactStore };
}
