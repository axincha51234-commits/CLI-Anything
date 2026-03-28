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

  private async canUseLocal(target: WorkerTarget): Promise<boolean> {
    if (!this.registry.has(target)) {
      return false;
    }
    const adapter = this.registry.get(target);
    if (!this.isFeatureEnabled(adapter.capability.feature_flag)) {
      return false;
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

  private async canUseGitHub(task: TaskSpec, target: WorkerTarget): Promise<boolean> {
    if (!this.registry.has(target)) {
      return false;
    }
    const adapter = this.registry.get(target);
    if (!this.isFeatureEnabled(adapter.capability.feature_flag)) {
      return false;
    }
    if (!this.config.github.enabled) {
      return false;
    }

    const health = await adapter.healthCheck();
    if (!health.healthy) {
      return false;
    }

    if (task.expected_output.kind === "review") {
      return adapter.capability.supports_github;
    }

    return adapter.capability.supports_local
      && Boolean(this.config.command_templates[target].local);
  }

  private fallbackOrder(kind: OutputKind, preferLocal = false): WorkerTarget[] {
    if (preferLocal) {
      return LOCAL_ONLY_FALLBACKS[kind];
    }
    return this.config.github.enabled
      ? GITHUB_ENABLED_FALLBACKS[kind]
      : LOCAL_ONLY_FALLBACKS[kind];
  }

  private async resolveForMode(
    task: TaskSpec,
    candidates: WorkerTarget[],
    mode: RoutingDecision["mode"],
    deprioritized: Set<WorkerTarget>,
    fallbackFrom: WorkerTarget
  ): Promise<RoutingDecision | null> {
    for (const candidate of candidates) {
      const available = mode === "local"
        ? await this.canUseLocal(candidate)
        : await this.canUseGitHub(task, candidate);
      if (!available) {
        continue;
      }

      return {
        worker_target: candidate,
        mode,
        reason: candidate === task.worker_target
          ? mode === "local" && task.requires_github
            ? "primary adapter is available for local execution"
            : "primary adapter is available"
          : deprioritized.has(candidate)
            ? `deprioritized fallback adapter ${candidate} is available for ${mode} execution`
            : `fallback adapter ${candidate} is available for ${mode} execution`,
        fallback_from: candidate === task.worker_target ? null : fallbackFrom
      };
    }

    return null;
  }

  async resolve(
    task: TaskSpec,
    options: {
      exclude_targets?: WorkerTarget[];
      deprioritized_targets?: WorkerTarget[];
      required_mode?: RoutingDecision["mode"];
    } = {}
  ): Promise<RoutingDecision> {
    const excluded = new Set(options.exclude_targets ?? []);
    const deprioritized = new Set(options.deprioritized_targets ?? []);
    const fallbackFrom = options.exclude_targets?.at(-1) ?? task.worker_target;
    const preferredTargets: WorkerTarget[] = [];
    const delayedTargets: WorkerTarget[] = [];
    const effectiveExecutionPreference = task.execution_preference ?? this.config.github.execution_preference;
    const preferLocalExecution = task.requires_github
      && effectiveExecutionPreference === "local_preferred";
    const preferProfileAlignedGitHub = preferLocalExecution
      && task.expected_output.kind === "review"
      && task.review_profile !== null
      && task.review_profile !== "standard";
    const requiredModeOverride = options.required_mode;

    const candidateTargets = [
      task.worker_target,
      ...this.fallbackOrder(task.expected_output.kind, preferLocalExecution).filter((target) => target !== task.worker_target)
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

    const orderedCandidates = [...preferredTargets, ...delayedTargets];
    if (requiredModeOverride) {
      const decision = await this.resolveForMode(
        task,
        orderedCandidates,
        requiredModeOverride,
        deprioritized,
        fallbackFrom
      );
      if (decision) {
        return decision;
      }

      throw new Error(
        requiredModeOverride === "github"
          ? `No GitHub-capable adapter is available for ${task.task_id}`
          : `No local adapter is healthy for ${task.task_id}`
      );
    }

    if (preferLocalExecution) {
      if (preferProfileAlignedGitHub) {
        const primaryLocalDecision = await this.resolveForMode(
          task,
          [task.worker_target],
          "local",
          deprioritized,
          fallbackFrom
        );
        if (primaryLocalDecision) {
          return primaryLocalDecision;
        }

        const githubDecision = await this.resolveForMode(
          task,
          orderedCandidates,
          "github",
          deprioritized,
          fallbackFrom
        );
        if (githubDecision) {
          return githubDecision;
        }

        const localFallbackDecision = await this.resolveForMode(
          task,
          orderedCandidates.filter((candidate) => candidate !== task.worker_target),
          "local",
          deprioritized,
          fallbackFrom
        );
        if (localFallbackDecision) {
          return localFallbackDecision;
        }

        throw new Error(
          this.config.github.enabled
            ? `No local or GitHub-capable adapter is available for ${task.task_id}`
            : `No local adapter is healthy for ${task.task_id}`
        );
      }

      const localDecision = await this.resolveForMode(
        task,
        orderedCandidates,
        "local",
        deprioritized,
        fallbackFrom
      );
      if (localDecision) {
        return localDecision;
      }

      const githubDecision = await this.resolveForMode(
        task,
        orderedCandidates,
        "github",
        deprioritized,
        fallbackFrom
      );
      if (githubDecision) {
        return githubDecision;
      }

      throw new Error(
        this.config.github.enabled
          ? `No local or GitHub-capable adapter is available for ${task.task_id}`
          : `No local adapter is healthy for ${task.task_id}`
      );
    }

    const requiredMode: RoutingDecision["mode"] = task.requires_github ? "github" : "local";
    const decision = await this.resolveForMode(
      task,
      orderedCandidates,
      requiredMode,
      deprioritized,
      fallbackFrom
    );
    if (decision) {
      return decision;
    }

    throw new Error(
      task.requires_github
        ? `No GitHub-capable adapter is available for ${task.task_id}`
        : `No local adapter is healthy for ${task.task_id}`
    );
  }
}
