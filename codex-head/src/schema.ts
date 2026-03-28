const { randomUUID } = require("node:crypto");

import {
  GITHUB_EXECUTION_PREFERENCES,
  NEXT_ACTIONS,
  OUTPUT_FORMATS,
  OUTPUT_KINDS,
  REVIEW_PROVIDER_PROFILES,
  REVIEW_VERDICTS,
  TASK_STATES,
  WORKER_RESULT_STATUSES,
  WORKER_TARGETS,
  type AdapterCapability,
  type TaskState,
  type TaskSpec,
  type WorkerResult
} from "./contracts";

export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskValidationError";
  }
}

type PartialTaskSpec = Partial<TaskSpec> & Pick<TaskSpec, "goal" | "repo">;

function ensureObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function ensureString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TaskValidationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function ensureNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TaskValidationError(`${label} must be a number`);
  }
  return value;
}

function ensureBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TaskValidationError(`${label} must be a boolean`);
  }
  return value;
}

function ensureStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TaskValidationError(`${label} must be a string array`);
  }
  return value as string[];
}

function slugifyGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "task";
}

export function createTaskSpec(input: PartialTaskSpec): TaskSpec {
  const goal = ensureString(input.goal, "goal");
  const repo = ensureString(input.repo, "repo");
  const taskId = typeof input.task_id === "string" && input.task_id.trim().length > 0
    ? input.task_id
    : randomUUID();
  const workerTarget = input.worker_target ?? "codex-cli";
  if (!WORKER_TARGETS.includes(workerTarget)) {
    throw new TaskValidationError(`worker_target must be one of ${WORKER_TARGETS.join(", ")}`);
  }

  const expectedOutput = input.expected_output ?? {
    kind: "analysis",
    format: "markdown",
    code_change: false
  };

  const task: TaskSpec = {
    task_id: taskId,
    goal,
    repo,
    base_branch: input.base_branch ?? "main",
    work_branch: input.work_branch ?? `codex/${slugifyGoal(goal)}-${taskId.slice(0, 8)}`,
    worker_target: workerTarget,
    execution_preference: input.execution_preference ?? null,
    allowed_tools: input.allowed_tools ?? ["read", "write", "test"],
    input_artifacts: input.input_artifacts ?? [],
    expected_output: {
      kind: expectedOutput.kind,
      format: expectedOutput.format,
      code_change: Boolean(expectedOutput.code_change)
    },
    review_profile: input.review_profile ?? null,
    budget: {
      max_cost_usd: input.budget?.max_cost_usd ?? 5,
      max_attempts: input.budget?.max_attempts ?? 3
    },
    timeout_sec: input.timeout_sec ?? 900,
    review_policy: {
      required_reviewers: input.review_policy?.required_reviewers ?? [],
      require_all: input.review_policy?.require_all ?? true
    },
    artifact_policy: {
      mode: input.artifact_policy?.mode
        ?? (expectedOutput.code_change ? "patch_artifact" : "local_artifact"),
      require_lineage: input.artifact_policy?.require_lineage ?? true
    },
    priority: input.priority ?? 50,
    requires_github: input.requires_github ?? false
  };

  validateTaskSpec(task);
  return task;
}

export function validateTaskSpec(input: unknown): TaskSpec {
  const task = ensureObject(input, "task");
  const expectedOutput = ensureObject(task.expected_output, "expected_output");
  const budget = ensureObject(task.budget, "budget");
  const reviewPolicy = ensureObject(task.review_policy, "review_policy");
  const artifactPolicy = ensureObject(task.artifact_policy, "artifact_policy");
  const workerTarget = ensureString(task.worker_target, "worker_target");

  if (!WORKER_TARGETS.includes(workerTarget as TaskSpec["worker_target"])) {
    throw new TaskValidationError(`worker_target must be one of ${WORKER_TARGETS.join(", ")}`);
  }

  const taskSpec: TaskSpec = {
    task_id: ensureString(task.task_id, "task_id"),
    goal: ensureString(task.goal, "goal"),
    repo: ensureString(task.repo, "repo"),
    base_branch: ensureString(task.base_branch, "base_branch"),
    work_branch: ensureString(task.work_branch, "work_branch"),
    worker_target: workerTarget as TaskSpec["worker_target"],
    execution_preference: task.execution_preference === null || task.execution_preference === undefined
      ? null
      : ensureString(task.execution_preference, "execution_preference") as TaskSpec["execution_preference"],
    allowed_tools: ensureStringArray(task.allowed_tools, "allowed_tools"),
    input_artifacts: ensureStringArray(task.input_artifacts, "input_artifacts"),
    expected_output: {
      kind: ensureString(expectedOutput.kind, "expected_output.kind") as TaskSpec["expected_output"]["kind"],
      format: ensureString(expectedOutput.format, "expected_output.format") as TaskSpec["expected_output"]["format"],
      code_change: ensureBoolean(expectedOutput.code_change, "expected_output.code_change")
    },
    review_profile: task.review_profile === null || task.review_profile === undefined
      ? null
      : ensureString(task.review_profile, "review_profile") as TaskSpec["review_profile"],
    budget: {
      max_cost_usd: ensureNumber(budget.max_cost_usd, "budget.max_cost_usd"),
      max_attempts: ensureNumber(budget.max_attempts, "budget.max_attempts")
    },
    timeout_sec: ensureNumber(task.timeout_sec, "timeout_sec"),
    review_policy: {
      required_reviewers: ensureStringArray(reviewPolicy.required_reviewers, "review_policy.required_reviewers") as TaskSpec["review_policy"]["required_reviewers"],
      require_all: ensureBoolean(reviewPolicy.require_all, "review_policy.require_all")
    },
    artifact_policy: {
      mode: ensureString(artifactPolicy.mode, "artifact_policy.mode") as TaskSpec["artifact_policy"]["mode"],
      require_lineage: ensureBoolean(artifactPolicy.require_lineage, "artifact_policy.require_lineage")
    },
    priority: ensureNumber(task.priority, "priority"),
    requires_github: ensureBoolean(task.requires_github, "requires_github")
  };

  if (!OUTPUT_KINDS.includes(taskSpec.expected_output.kind)) {
    throw new TaskValidationError("expected_output.kind is invalid");
  }

  if (!OUTPUT_FORMATS.includes(taskSpec.expected_output.format)) {
    throw new TaskValidationError("expected_output.format is invalid");
  }

  if (taskSpec.review_profile && !REVIEW_PROVIDER_PROFILES.includes(taskSpec.review_profile)) {
    throw new TaskValidationError("review_profile is invalid");
  }

  if (taskSpec.execution_preference && !GITHUB_EXECUTION_PREFERENCES.includes(taskSpec.execution_preference)) {
    throw new TaskValidationError("execution_preference is invalid");
  }

  return taskSpec;
}

export function validateWorkerResult(input: unknown): WorkerResult {
  const result = ensureObject(input, "worker result");
  const workerTarget = ensureString(result.worker_target, "worker_target");
  const status = ensureString(result.status, "status");
  const nextAction = ensureString(result.next_action, "next_action");

  if (!WORKER_TARGETS.includes(workerTarget as WorkerResult["worker_target"])) {
    throw new TaskValidationError("worker_result.worker_target is invalid");
  }

  if (!WORKER_RESULT_STATUSES.includes(status as WorkerResult["status"])) {
    throw new TaskValidationError("worker_result.status is invalid");
  }

  if (!NEXT_ACTIONS.includes(nextAction as WorkerResult["next_action"])) {
    throw new TaskValidationError("worker_result.next_action is invalid");
  }

  let reviewVerdict: WorkerResult["review_verdict"] = null;
  if (result.review_verdict !== undefined && result.review_verdict !== null) {
    const parsedVerdict = ensureString(result.review_verdict, "review_verdict");
    if (!REVIEW_VERDICTS.includes(parsedVerdict as NonNullable<WorkerResult["review_verdict"]>)) {
      throw new TaskValidationError("worker_result.review_verdict is invalid");
    }
    reviewVerdict = parsedVerdict as WorkerResult["review_verdict"];
  }

  return {
    task_id: ensureString(result.task_id, "task_id"),
    worker_target: workerTarget as WorkerResult["worker_target"],
    status: status as WorkerResult["status"],
    review_verdict: reviewVerdict,
    summary: ensureString(result.summary, "summary"),
    artifacts: ensureStringArray(result.artifacts, "artifacts"),
    patch_ref: result.patch_ref === null ? null : ensureString(result.patch_ref, "patch_ref"),
    log_ref: result.log_ref === null ? null : ensureString(result.log_ref, "log_ref"),
    cost: ensureNumber(result.cost, "cost"),
    duration_ms: ensureNumber(result.duration_ms, "duration_ms"),
    next_action: nextAction as WorkerResult["next_action"],
    review_notes: ensureStringArray(result.review_notes, "review_notes")
  };
}

export function validateAdapterCapability(input: unknown): AdapterCapability {
  const capability = ensureObject(input, "adapter capability");
  const workerTarget = ensureString(capability.worker_target, "worker_target");
  if (!WORKER_TARGETS.includes(workerTarget as AdapterCapability["worker_target"])) {
    throw new TaskValidationError("adapter capability worker_target is invalid");
  }

  return {
    worker_target: workerTarget as AdapterCapability["worker_target"],
    supports_local: ensureBoolean(capability.supports_local, "supports_local"),
    supports_github: ensureBoolean(capability.supports_github, "supports_github"),
    can_edit_code: ensureBoolean(capability.can_edit_code, "can_edit_code"),
    can_review: ensureBoolean(capability.can_review, "can_review"),
    can_run_tests: ensureBoolean(capability.can_run_tests, "can_run_tests"),
    max_concurrency: ensureNumber(capability.max_concurrency, "max_concurrency"),
    required_binaries: ensureStringArray(capability.required_binaries, "required_binaries"),
    feature_flag: capability.feature_flag === null
      ? null
      : ensureString(capability.feature_flag, "feature_flag")
  };
}

export function validateTaskState(state: string): void {
  if (!TASK_STATES.includes(state as TaskState)) {
    throw new TaskValidationError(`invalid task state: ${state}`);
  }
}
