import type {
  OutputKind,
  RoutingDecision,
  TaskSpec,
  WorkerTarget
} from "../contracts";
import type { CodexHeadConfig } from "../config";
import { AdapterRegistry } from "../adapter-registry";

const GITHUB_ENABLED_FALLBACKS: Record<OutputKind, WorkerTarget[]> = {
  analysis: ["codex-cli", "gemini-cli", "antigravity", "claude-code"],
  patch: ["claude-code", "codex-cli"],
  pull_request: ["gemini-cli", "codex-cli"],
  review: ["codex-cli", "gemini-cli", "claude-code"],
  report: ["codex-cli", "gemini-cli", "antigravity"]
};

const LOCAL_ONLY_FALLBACKS: Record<OutputKind, WorkerTarget[]> = {
  analysis: ["gemini-cli", "codex-cli", "claude-code", "antigravity"],
  patch: ["claude-code", "gemini-cli", "codex-cli"],
  pull_request: ["gemini-cli", "codex-cli"],
  review: ["gemini-cli", "codex-cli", "claude-code"],
  report: ["gemini-cli", "codex-cli", "antigravity"]
};

export class TaskRouter {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly config: CodexHeadConfig
  ) {}

  private isFeatureEnabled(featureFlag: string | null): boolean {
    if (!featureFlag) {
      return true;
    }
    return Boolean(this.config.feature_flags[featureFlag]);
  }

  private async canUse(target: WorkerTarget, requireGitHub: boolean): Promise<boolean> {
    if (!this.registry.has(target)) {
      return false;
    }
    const adapter = this.registry.get(target);
    if (!this.isFeatureEnabled(adapter.capability.feature_flag)) {
      return false;
    }
    if (requireGitHub) {
      return adapter.capability.supports_github && this.config.github.enabled;
    }
    if (!adapter.capability.supports_local) {
      return false;
    }
    if (!this.config.command_templates[target].local) {
      return false;
    }
    const health = await adapter.healthCheck();
    return health.healthy;
  }

  private fallbackOrder(kind: OutputKind): WorkerTarget[] {
    return this.config.github.enabled
      ? GITHUB_ENABLED_FALLBACKS[kind]
      : LOCAL_ONLY_FALLBACKS[kind];
  }

  async resolve(
    task: TaskSpec,
    options: {
      exclude_targets?: WorkerTarget[];
      deprioritized_targets?: WorkerTarget[];
    } = {}
  ): Promise<RoutingDecision> {
    const excluded = new Set(options.exclude_targets ?? []);
    const deprioritized = new Set(options.deprioritized_targets ?? []);
    const fallbackFrom = options.exclude_targets?.at(-1) ?? task.worker_target;
    const preferredTargets: WorkerTarget[] = [];
    const delayedTargets: WorkerTarget[] = [];

    const candidateTargets = [
      task.worker_target,
      ...this.fallbackOrder(task.expected_output.kind).filter((target) => target !== task.worker_target)
    ];

    for (const target of candidateTargets) {
      if (excluded.has(target)) {
        continue;
      }
      if (deprioritized.has(target)) {
        delayedTargets.push(target);
        continue;
      }
      preferredTargets.push(target);
    }

    for (const candidate of [...preferredTargets, ...delayedTargets]) {
      if (await this.canUse(candidate, task.requires_github)) {
        return {
          worker_target: candidate,
          mode: task.requires_github ? "github" : "local",
          reason: candidate === task.worker_target
            ? "primary adapter is available"
            : deprioritized.has(candidate)
              ? `deprioritized fallback adapter ${candidate} is still available`
              : `fallback adapter ${candidate} is available`,
          fallback_from: candidate === task.worker_target ? null : fallbackFrom
        };
      }
    }

    throw new Error(
      task.requires_github
        ? `No GitHub-capable adapter is available for ${task.task_id}`
        : `No local adapter is healthy for ${task.task_id}`
    );
  }
}
