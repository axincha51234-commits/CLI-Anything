import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createDefaultRegistry, type AdapterRegistry } from "./adapter-registry";
import { buildTaskPrompt } from "./adapter-registry/base";
import { FileArtifactStore } from "./artifacts/fileArtifactStore";
import { loadConfig, type CodexHeadConfig } from "./config";
import type {
  AdapterRuntimeReadiness,
  DispatchOutcome,
  HeadPlan,
  ReviewVerdict,
  RoutingDecision,
  TaskRecord,
  TaskReview,
  TaskRuntimeContext,
  TaskState,
  TaskSpec,
  WorkerTarget,
  WorkerResult
} from "./contracts";
import { WORKER_TARGETS } from "./contracts";
import { validateTaskSpec, validateWorkerResult } from "./schema";
import { GitHubControlPlane } from "./github/controlPlane";
import { CodexHeadPlanner } from "./planner";
import { TaskRouter } from "./router";
import { computeRetryBackoffMs } from "./retry";
import { buildTaskOperatorStatus, buildTaskStatusSnapshots, type TaskOperatorStatus } from "./status";
import { SqliteTaskStore } from "./state-store/sqliteTaskStore";
import {
  buildDoctorReport,
  type DoctorCommandHint,
  type DoctorCommandHintKind,
  type DoctorOptions,
  type DoctorReport
} from "./doctor";

function toCliPrompt(lines: string[]): string {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" | ");
}

function enforceWorkerResultPolicy(
  task: TaskSpec,
  result: WorkerResult,
  expectedWorkerTarget: TaskSpec["worker_target"]
): void {
  if (task.task_id !== result.task_id) {
    throw new Error("Worker result task_id does not match the owning task");
  }
  if (expectedWorkerTarget !== result.worker_target) {
    throw new Error("Worker result came from the wrong adapter target");
  }
  if (task.expected_output.code_change && task.artifact_policy.require_lineage && !result.patch_ref) {
    throw new Error("Code-changing work must produce a patch or PR lineage artifact");
  }
}

function inferReviewVerdict(result: WorkerResult): ReviewVerdict {
  if (result.review_verdict) {
    return result.review_verdict;
  }
  if (result.status === "failed") {
    return "changes_requested";
  }
  if (result.status === "completed") {
    return "approved";
  }
  return "commented";
}

function mergeReview(reviews: TaskReview[], nextReview: TaskReview): TaskReview[] {
  return [
    ...reviews.filter((review) => review.reviewer !== nextReview.reviewer),
    nextReview
  ];
}

function summarizeReviewState(task: TaskSpec, reviews: TaskReview[]): {
  state: "awaiting_review" | "completed" | "failed";
  detail: string;
} {
  const required = task.review_policy.required_reviewers;
  const byReviewer = new Map(reviews.map((review) => [review.reviewer, review]));
  const rejected = reviews.find((review) => review.verdict === "changes_requested");
  if (rejected) {
    return {
      state: "failed",
      detail: `Review rejected by ${rejected.reviewer}`
    };
  }

  const approvedReviewers = required.filter((reviewer) => byReviewer.get(reviewer)?.verdict === "approved");
  const completed = task.review_policy.require_all
    ? approvedReviewers.length === required.length
    : approvedReviewers.length > 0;

  if (completed) {
    return {
      state: "completed",
      detail: "Required reviews approved"
    };
  }

  const pending = required.filter((reviewer) => byReviewer.get(reviewer)?.verdict !== "approved");
  return {
    state: "awaiting_review",
    detail: pending.length > 0
      ? `Waiting for reviews from ${pending.join(", ")}`
      : "Waiting for review verdicts"
  };
}

interface ExecutionAttemptArtifact {
  sequence: number;
  attempted_at: number;
  routing: RoutingDecision;
  result: WorkerResult;
}

interface RunningTaskRecovery {
  task_id: string;
  status: "reconciled" | "failed" | "requeued" | "error";
  detail: string;
  outcome: DispatchOutcome | null;
  operator: TaskOperatorStatus | null;
}

export interface SweepTasksOptions {
  action: "cancel" | "requeue";
  states?: TaskState[];
  older_than_hours?: number;
  goal_contains?: string;
  worker_target?: WorkerTarget;
  task_ids?: string[];
  limit?: number;
  dry_run?: boolean;
  now?: number;
}

export interface SweepTasksEntry {
  task_id: string;
  goal: string;
  worker_target: WorkerTarget;
  previous_state: TaskState;
  next_state: TaskState;
  changed: boolean;
  reason: string;
}

export interface SweepTasksResult {
  action: SweepTasksOptions["action"];
  dry_run: boolean;
  receipt_path: string | null;
  filters: {
    states: TaskState[];
    older_than_hours: number | null;
    goal_contains: string | null;
    worker_target: WorkerTarget | null;
    task_ids: string[];
    limit: number | null;
  };
  matched: number;
  changed: number;
  tasks: SweepTasksEntry[];
}

export interface RunDoctorHintResult {
  report: DoctorReport;
  hint: DoctorCommandHint;
  result: SweepTasksResult;
  receipt_path: string | null;
}

export interface RunDoctorHintsEntryResult {
  hint: DoctorCommandHint;
  result: SweepTasksResult;
}

export interface RunDoctorHintsResult {
  report: DoctorReport;
  kind: DoctorCommandHintKind | null;
  limit: number | null;
  apply: boolean;
  allow_multi_task_apply: boolean;
  confirm_token: string;
  total_matched: number;
  total_actionable: number;
  preview: RunDoctorHintsEntryResult[];
  results: RunDoctorHintsEntryResult[];
  receipt_path: string | null;
}

export const OPERATOR_RECEIPT_COMMANDS = [
  "sweep-tasks",
  "run-doctor-hint",
  "run-doctor-hints"
] as const;

export type OperatorReceiptCommand = typeof OPERATOR_RECEIPT_COMMANDS[number];

export interface OperatorActionReceipt {
  schema_version: 1;
  command: OperatorReceiptCommand;
  created_at: string;
  dry_run: boolean;
  apply: boolean;
  selection: Record<string, unknown>;
  summary: {
    matched: number;
    actionable: number;
    changed: number;
  };
  hints?: Array<{
    id: string;
    kind: string;
    reason: string;
    matched: number;
    actionable: number;
    changed: number;
  }>;
  tasks?: SweepTasksEntry[];
}

export interface OperatorHistoryEntry {
  receipt_path: string;
  receipt: OperatorActionReceipt;
}

export interface OperatorHistoryResult {
  filters: {
    command: OperatorReceiptCommand | null;
    apply_only: boolean;
    dry_run_only: boolean;
    limit: number;
  };
  scanned: number;
  returned: number;
  receipts: OperatorHistoryEntry[];
}

interface WorkerPenalty {
  worker_target: WorkerTarget;
  category: "rate_limited" | "timed_out" | "auth_failed";
  detail: string;
  penalized_until: number;
  source_task_id: string;
}

const RATE_LIMIT_PATTERNS = [
  /\bquota\b/i,
  /usage limit/i,
  /rate.?limit/i,
  /too many requests/i,
  /quota[_\s-]*exhausted/i,
  /resource[_\s-]*exhausted/i,
  /\b429\b/
];

const AUTH_FAILURE_PATTERNS = [
  /not authenticated/i,
  /login required/i,
  /unauthorized/i,
  /forbidden/i,
  /invalid api key/i,
  /missing api key/i,
  /invalid token/i
];

function parsePenaltyDurationMs(detail: string): number | null {
  const match = detail.match(/(\d+(?:\.\d+)?)\s*(day|days|d|hour|hours|hr|hrs|h|minute|minutes|min|mins|m)\b/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (Number.isNaN(amount) || amount <= 0) {
    return null;
  }

  if (unit.startsWith("d")) {
    return amount * 24 * 60 * 60 * 1000;
  }
  if (unit.startsWith("h")) {
    return amount * 60 * 60 * 1000;
  }
  return amount * 60 * 1000;
}

function summarizePenaltyDetail(result: WorkerResult): string {
  return [
    result.summary,
    ...result.review_notes
  ]
    .join("\n")
    .trim();
}

function inferWorkerPenaltyFromResult(
  taskId: string,
  result: WorkerResult,
  mode: RoutingDecision["mode"] | null,
  timestamp: number,
  now = Date.now()
): WorkerPenalty | null {
  if (mode !== "local") {
    return null;
  }

  const detail = summarizePenaltyDetail(result);
  let category: WorkerPenalty["category"] | null = null;
  let defaultDurationMs = 0;

  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(detail))) {
    category = "rate_limited";
    defaultDurationMs = 30 * 60 * 1000;
  } else if (result.status === "retryable" || /timed out/i.test(detail)) {
    category = "timed_out";
    defaultDurationMs = 5 * 60 * 1000;
  } else if (AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(detail))) {
    category = "auth_failed";
    defaultDurationMs = 15 * 60 * 1000;
  }

  if (!category) {
    return null;
  }

  const penalizedUntil = timestamp + (parsePenaltyDurationMs(detail) ?? defaultDurationMs);
  if (penalizedUntil <= now) {
    return null;
  }

  return {
    worker_target: result.worker_target,
    category,
    detail,
    penalized_until: penalizedUntil,
    source_task_id: taskId
  };
}

function resolveSweepTimestamp(record: TaskRecord): number {
  return record.updated_at
    || record.finished_at
    || record.started_at
    || record.created_at
    || 0;
}

function normalizeSweepStates(
  action: SweepTasksOptions["action"],
  states?: TaskState[]
): TaskState[] {
  if (states && states.length > 0) {
    return states;
  }
  return action === "cancel"
    ? ["planned", "queued", "failed"]
    : ["failed", "planned"];
}

export class CodexHeadOrchestrator {
  readonly artifactStore: FileArtifactStore;
  readonly taskStore: SqliteTaskStore;
  readonly planner: CodexHeadPlanner;
  readonly router: TaskRouter;
  readonly github: GitHubControlPlane;

  constructor(
    readonly config: CodexHeadConfig = loadConfig(process.cwd()),
    readonly registry: AdapterRegistry = createDefaultRegistry(config)
  ) {
    this.artifactStore = new FileArtifactStore(config.artifacts_dir);
    this.taskStore = new SqliteTaskStore(config.database_path);
    this.planner = new CodexHeadPlanner(config.methodology_refs, {
      github_enabled: config.github.enabled,
      antigravity_enabled: Boolean(config.feature_flags.antigravity),
      local_reviewers: (["gemini-cli", "codex-cli", "claude-code"] as WorkerTarget[]).filter((target) => {
        const template = config.command_templates[target];
        return Boolean(template.enabled && template.local);
      })
    });
    this.router = new TaskRouter(this.registry, this.config);
    this.github = new GitHubControlPlane(config, this.artifactStore);
  }

  parseTaskFile(filePath: string): TaskSpec {
    return validateTaskSpec(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
  }

  planGoal(goal: string, repo = this.config.workspace_root): HeadPlan {
    return this.planner.planGoal(goal, repo);
  }

  async runGoal(
    goal: string,
    options: {
      repo?: string;
      publish_github_mirror?: boolean;
      timeout_sec?: number;
      interval_sec?: number;
    } = {}
  ): Promise<{
    plan: HeadPlan;
    task: TaskRecord;
    mirror: DispatchOutcome | null;
    outcome: DispatchOutcome;
  }> {
    const plan = this.planGoal(goal, options.repo ?? this.config.workspace_root);
    const records = this.savePlannedTasks(plan);
    if (records.length !== 1) {
      throw new Error(`runGoal currently supports exactly one planned task, received ${records.length}`);
    }

    const record = records[0]!;
    this.enqueueTask(record.task.task_id);

    const shouldPublishMirror = (options.publish_github_mirror ?? true)
      && (
        record.task.requires_github
        || record.task.expected_output.kind === "pull_request"
        || record.task.artifact_policy.mode === "branch_pr"
      );
    const mirror = shouldPublishMirror
      ? this.publishGitHubMirror(record.task.task_id)
      : null;
    const outcome = await this.dispatchAndWait(
      record.task.task_id,
      options.timeout_sec,
      options.interval_sec
    );

    return {
      plan,
      task: this.getTask(record.task.task_id),
      mirror,
      outcome
    };
  }

  savePlannedTasks(plan: HeadPlan): TaskRecord[] {
    return plan.tasks.map((task) => this.taskStore.saveTask(task));
  }

  submitTask(task: TaskSpec): TaskRecord {
    const validated = validateTaskSpec(task);
    const record = this.taskStore.saveTask(validated);
    this.artifactStore.writeJson(validated.task_id, "task-spec.json", validated);
    return record;
  }

  enqueueTask(taskId: string): TaskRecord {
    return this.taskStore.enqueue(taskId);
  }

  recordReview(
    taskId: string,
    reviewer: TaskSpec["worker_target"],
    verdict: ReviewVerdict,
    summary = `Manual review from ${reviewer}: ${verdict}`
  ): DispatchOutcome {
    return this.acceptWorkerResult({
      task_id: taskId,
      worker_target: reviewer,
      status: verdict === "changes_requested" ? "failed" : "completed",
      review_verdict: verdict,
      summary,
      artifacts: [],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 0,
      next_action: verdict === "approved" ? "none" : verdict === "changes_requested" ? "manual" : "review",
      review_notes: []
    });
  }

  private buildRuntime(task: TaskSpec): TaskRuntimeContext {
    const taskFile = this.artifactStore.writeJson(task.task_id, "task-input.json", task);
    const artifactDir = this.artifactStore.getTaskDir(task.task_id);
    const githubPayload = join(artifactDir, "github-dispatch.json");
    const taskPrompt = toCliPrompt([
      buildTaskPrompt(task, {
        task_file: taskFile,
        task_goal: task.goal,
        task_prompt: "",
        artifact_dir: artifactDir,
        github_payload: githubPayload
      })
    ]);
    return {
      task_file: taskFile,
      task_goal: task.goal,
      task_prompt: taskPrompt,
      artifact_dir: artifactDir,
      github_payload: githubPayload
    };
  }

  private writeExecutionAttempts(taskId: string, attempts: ExecutionAttemptArtifact[]): string {
    return this.artifactStore.writeJson(taskId, "execution-attempts.json", {
      task_id: taskId,
      attempts
    });
  }

  private async resolveNextFallback(
    task: TaskSpec,
    attemptedTargets: WorkerTarget[]
  ): Promise<RoutingDecision | null> {
    const deprioritizedTargets = this.getRecentWorkerPenalties()
      .map((penalty) => penalty.worker_target)
      .filter((target) => !attemptedTargets.includes(target));

    try {
      return await this.router.resolve(task, {
        exclude_targets: attemptedTargets,
        deprioritized_targets: deprioritizedTargets,
        required_mode: "local"
      });
    } catch {}

    if (!task.requires_github || this.config.github.execution_preference !== "local_preferred") {
      return null;
    }

    try {
      return await this.router.resolve(task, {
        required_mode: "github"
      });
    } catch {
      return null;
    }
  }

  private defaultMirrorRouting(task: TaskSpec): RoutingDecision {
    return {
      worker_target: task.worker_target,
      mode: task.requires_github && this.config.github.execution_preference !== "local_preferred"
        ? "github"
        : "local",
      reason: "mirror publish",
      fallback_from: null
    };
  }

  private getPenaltyResetPath(): string {
    return join(this.config.app_root, "runtime", "worker-penalty-resets.json");
  }

  private readPenaltyResetMap(): Partial<Record<WorkerTarget, number>> {
    const resetPath = this.getPenaltyResetPath();
    if (!existsSync(resetPath)) {
      return {};
    }
    return JSON.parse(readFileSync(resetPath, "utf8")) as Partial<Record<WorkerTarget, number>>;
  }

  private getRecentWorkerPenalties(now = Date.now()): WorkerPenalty[] {
    const latestByWorker = new Map<WorkerTarget, WorkerPenalty>();
    const resetMap = this.readPenaltyResetMap();
    const events: Array<{
      worker_target: WorkerTarget;
      occurred_at: number;
      penalty: WorkerPenalty | null;
      clears_penalty: boolean;
    }> = [];

    for (const record of this.taskStore.listTasks()) {
      const taskDir = this.artifactStore.getTaskDir(record.task.task_id);
      const attemptsPath = join(taskDir, "execution-attempts.json");
      const attempts = existsSync(attemptsPath)
        ? (JSON.parse(readFileSync(attemptsPath, "utf8")) as {
            attempts?: ExecutionAttemptArtifact[];
          }).attempts ?? []
        : [];

      if (attempts.length > 0) {
        for (const attempt of attempts) {
          events.push({
            worker_target: attempt.result.worker_target,
            occurred_at: attempt.attempted_at,
            penalty: inferWorkerPenaltyFromResult(
              record.task.task_id,
              attempt.result,
              attempt.routing.mode,
              attempt.attempted_at,
              now
            ),
            clears_penalty: attempt.routing.mode === "local"
              && (attempt.result.status === "completed" || attempt.result.status === "awaiting_review")
          });
        }
        continue;
      }

      if (record.result) {
        const occurredAt = record.finished_at ?? record.updated_at ?? now;
        events.push({
          worker_target: record.result.worker_target,
          occurred_at: occurredAt,
          penalty: inferWorkerPenaltyFromResult(
            record.task.task_id,
            record.result,
            record.routing?.mode ?? null,
            occurredAt,
            now
          ),
          clears_penalty: record.routing?.mode === "local"
            && (record.result.status === "completed" || record.result.status === "awaiting_review")
        });
      }
    }

    events.sort((left, right) => left.occurred_at - right.occurred_at);
    for (const event of events) {
      if (event.occurred_at <= (resetMap[event.worker_target] ?? 0)) {
        continue;
      }
      if (event.clears_penalty) {
        latestByWorker.delete(event.worker_target);
        continue;
      }
      if (!event.penalty) {
        continue;
      }
      latestByWorker.set(event.worker_target, event.penalty);
    }

    return [...latestByWorker.values()].sort((left, right) => left.penalized_until - right.penalized_until);
  }

  clearRecentWorkerPenalties(targets: WorkerTarget[] = [...WORKER_TARGETS]): {
    cleared_at: number;
    cleared_targets: WorkerTarget[];
    reset_file: string;
  } {
    const resetPath = this.getPenaltyResetPath();
    const existing = this.readPenaltyResetMap();
    const clearedAt = Date.now();

    for (const target of targets) {
      existing[target] = clearedAt;
    }

    mkdirSync(join(this.config.app_root, "runtime"), { recursive: true });
    writeFileSync(resetPath, JSON.stringify(existing, null, 2), "utf8");

    return {
      cleared_at: clearedAt,
      cleared_targets: targets,
      reset_file: resetPath
    };
  }

  async dispatchExistingTask(taskId: string): Promise<DispatchOutcome> {
    const claimed = this.taskStore.claimTask(taskId);
    if (!claimed) {
      throw new Error(`Task ${taskId} is not ready to dispatch`);
    }
    return this.dispatchClaimedRecord(claimed);
  }

  async dispatchNext(): Promise<DispatchOutcome | null> {
    const claimed = this.taskStore.claimNextQueued();
    if (!claimed) {
      return null;
    }
    return this.dispatchClaimedRecord(claimed);
  }

  async dispatchAndWait(taskId: string, timeoutSec = 300, intervalSec = 5): Promise<DispatchOutcome> {
    const dispatched = await this.dispatchExistingTask(taskId);
    if (dispatched.state !== "running" || dispatched.routing.mode !== "github") {
      return dispatched;
    }
    const record = this.getTask(taskId);
    if (!this.github.shouldDispatchLive() && !record.github_run) {
      return dispatched;
    }
    return this.waitForGitHubCallback(taskId, timeoutSec, intervalSec);
  }

  private async dispatchClaimedRecord(claimed: TaskRecord): Promise<DispatchOutcome> {
    const task = claimed.task;
    let routing = await this.router.resolve(task, {
      deprioritized_targets: this.getRecentWorkerPenalties().map((penalty) => penalty.worker_target)
    });
    this.artifactStore.writeJson(task.task_id, "routing-decision.json", routing);
    this.taskStore.recordRouting(task.task_id, routing);

    const attemptedTargets: WorkerTarget[] = [];
    const attemptArtifacts: ExecutionAttemptArtifact[] = [];

    while (true) {
      if (routing.mode === "github") {
        const dispatch = this.github.prepareDispatch(task, routing);
        if (!this.github.shouldDispatchLive()) {
          this.artifactStore.writeJson(task.task_id, "dispatch-outcome.json", {
            ...dispatch,
            mode: "artifacts_only"
          });
          return {
            task_id: task.task_id,
            state: "running",
            routing,
            detail: `Prepared GitHub payload at ${dispatch.payload_path}`
          };
        }

        try {
          const receipt = this.github.dispatchWorkflow(task, routing, dispatch);
          if (receipt.run) {
            this.taskStore.recordGitHubRun(task.task_id, receipt.run);
          }
          this.artifactStore.writeJson(task.task_id, "dispatch-outcome.json", {
            ...dispatch,
            mode: "gh_cli",
            receipt
          });
          return {
            task_id: task.task_id,
            state: "running",
            routing,
            detail: `Triggered GitHub workflow ${dispatch.workflow_name}`
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const result: WorkerResult = {
            task_id: task.task_id,
            worker_target: routing.worker_target,
            status: "failed",
            review_verdict: null,
            summary: message,
            artifacts: [dispatch.payload_path, dispatch.workflow_inputs_path],
            patch_ref: null,
            log_ref: null,
            cost: 0,
            duration_ms: 0,
            next_action: "manual",
            review_notes: [message]
          };
          this.artifactStore.writeJson(task.task_id, "dispatch-outcome.json", {
            ...dispatch,
            mode: "gh_cli",
            error: message
          });
          this.taskStore.finish(task.task_id, "failed", result, routing, message);
          return {
            task_id: task.task_id,
            state: "failed",
            routing,
            detail: message
          };
        }
      }

      const adapter = this.registry.get(routing.worker_target);
      const runtime = this.buildRuntime(task);
      const result = await adapter.execute(task, runtime, {
        artifactStore: this.artifactStore,
        cwd: this.config.workspace_root
      });

      attemptArtifacts.push({
        sequence: attemptArtifacts.length + 1,
        attempted_at: Date.now(),
        routing,
        result
      });
      this.writeExecutionAttempts(task.task_id, attemptArtifacts);

      if (result.status !== "failed" && result.status !== "retryable") {
        return this.acceptWorkerResult(result, routing);
      }

      attemptedTargets.push(routing.worker_target);
      const fallback = await this.resolveNextFallback(task, attemptedTargets);
      if (!fallback) {
        return this.acceptWorkerResult(result, routing);
      }

      routing = {
        ...fallback,
        fallback_from: routing.worker_target
      };
      this.artifactStore.writeJson(task.task_id, "routing-decision.json", routing);
      this.taskStore.recordRouting(task.task_id, routing);
    }
  }

  acceptWorkerResult(resultInput: WorkerResult, routingOverride?: RoutingDecision): DispatchOutcome {
    const result = validateWorkerResult(resultInput);
    const record = this.taskStore.getTaskOrThrow(result.task_id);
    const routing = routingOverride ?? record.routing ?? {
      worker_target: result.worker_target,
      mode: "local",
      reason: "external completion",
      fallback_from: null
    };
    const expectedWorkerTarget = routingOverride?.worker_target
      ?? record.routing?.worker_target
      ?? record.task.worker_target;
    const isReviewSubmission = record.state === "awaiting_review"
      && record.task.review_policy.required_reviewers.includes(result.worker_target);

    if (isReviewSubmission) {
      const review: TaskReview = {
        reviewer: result.worker_target,
        verdict: inferReviewVerdict(result),
        summary: result.summary,
        review_notes: result.review_notes,
        artifacts: result.artifacts,
        source_status: result.status,
        reviewed_at: Date.now()
      };
      const reviews = mergeReview(record.reviews, review);
      this.artifactStore.writeJson(result.task_id, `review-${result.worker_target}.json`, {
        result,
        review
      });

      const reviewState = summarizeReviewState(record.task, reviews);
      if (reviewState.state === "awaiting_review") {
        this.taskStore.updateReviews(result.task_id, reviews);
        return {
          task_id: result.task_id,
          state: "awaiting_review",
          routing,
          detail: reviewState.detail
        };
      }

      const currentResult = record.result ?? {
        task_id: record.task.task_id,
        worker_target: expectedWorkerTarget,
        status: "awaiting_review",
        review_verdict: null,
        summary: "Execution completed and waiting for reviews",
        artifacts: [],
        patch_ref: null,
        log_ref: null,
        cost: 0,
        duration_ms: 0,
        next_action: "review",
        review_notes: []
      };
      this.taskStore.finish(
        result.task_id,
        reviewState.state,
        currentResult,
        routing,
        reviewState.state === "failed" ? reviewState.detail : null,
        reviews
      );
      return {
        task_id: result.task_id,
        state: reviewState.state,
        routing,
        detail: reviewState.detail
      };
    }

    enforceWorkerResultPolicy(record.task, result, expectedWorkerTarget);
    this.artifactStore.writeJson(result.task_id, "worker-result.json", result);

    if (result.status === "retryable") {
      if (record.attempts >= record.max_attempts) {
        this.taskStore.finish(result.task_id, "failed", result, routing, result.summary);
        return {
          task_id: result.task_id,
          state: "failed",
          routing,
          detail: "Retry budget exhausted"
        };
      }

      const nextRunAt = Date.now() + computeRetryBackoffMs(record.attempts + 1);
      this.taskStore.finish(result.task_id, "failed", result, routing, result.summary);
      this.taskStore.enqueue(result.task_id, nextRunAt);
      return {
        task_id: result.task_id,
        state: "queued",
        routing,
        detail: `Retry scheduled for ${new Date(nextRunAt).toISOString()}`
      };
    }

    if (result.status === "failed") {
      this.taskStore.finish(result.task_id, "failed", result, routing, result.summary);
      return {
        task_id: result.task_id,
        state: "failed",
        routing,
        detail: result.summary
      };
    }

    if (result.status === "awaiting_review" || record.task.review_policy.required_reviewers.length > 0) {
      this.taskStore.finish(result.task_id, "awaiting_review", result, routing);
      return {
        task_id: result.task_id,
        state: "awaiting_review",
        routing,
        detail: "Task completed execution and is waiting for review"
      };
    }

    this.taskStore.finish(result.task_id, "completed", result, routing);
    return {
      task_id: result.task_id,
      state: "completed",
      routing,
      detail: result.summary
    };
  }

  completeFromFile(resultFile: string): DispatchOutcome {
    const result = JSON.parse(readFileSync(resultFile, "utf8")) as WorkerResult;
    return this.acceptWorkerResult(result);
  }

  publishGitHubMirror(taskId: string): DispatchOutcome {
    const record = this.taskStore.getTaskOrThrow(taskId);
    const routing = record.routing ?? this.defaultMirrorRouting(record.task);
    const dispatch = this.github.prepareDispatch(record.task, routing);
    const receipt = this.github.publishMirror(record.task, dispatch, record.github_mirror);
    this.taskStore.recordGitHubMirror(taskId, receipt.mirror);
    this.artifactStore.writeJson(taskId, "github-mirror-receipt.json", receipt);
    return {
      task_id: taskId,
      state: record.state,
      routing,
      detail: receipt.mirror.pull_request
        ? `Published GitHub issue and PR mirrors for ${taskId}`
        : `Published GitHub issue mirror for ${taskId}`
    };
  }

  syncGitHubCallback(taskId: string): DispatchOutcome {
    const record = this.taskStore.getTaskOrThrow(taskId);
    const runRef = record.github_run
      ?? this.tryResolveGitHubRun(record.task);
    if (runRef && (!record.github_run || record.github_run.run_id !== runRef.run_id)) {
      this.taskStore.recordGitHubRun(taskId, runRef);
    }
    let download;
    try {
      download = this.github.downloadCallbackArtifact(taskId, {
        run_id: runRef?.run_id ?? null
      });
    } catch (error) {
      throw new Error(this.formatGitHubCallbackFailure(taskId, error, runRef?.run_id ?? null));
    }
    return this.completeFromFile(download.callback_path);
  }

  async waitForGitHubCallback(taskId: string, timeoutSec = 300, intervalSec = 5): Promise<DispatchOutcome> {
    const record = this.taskStore.getTaskOrThrow(taskId);
    const runRef = record.github_run
      ?? this.tryResolveGitHubRun(record.task);
    if (!runRef) {
      throw new Error(`Task ${taskId} does not have a resolved GitHub workflow run yet`);
    }

    let latest;
    try {
      latest = await this.github.waitForRunCompletion(
        taskId,
        runRef.run_id,
        Math.max(1, timeoutSec) * 1000,
        Math.max(1, intervalSec) * 1000
      );
    } catch (error) {
      throw new Error(this.formatGitHubCallbackFailure(taskId, error, runRef.run_id));
    }
    this.taskStore.recordGitHubRun(taskId, latest);

    let download;
    try {
      download = this.github.downloadCallbackArtifact(taskId, {
        run_id: latest.run_id
      });
    } catch (error) {
      throw new Error(this.formatGitHubCallbackFailure(taskId, error, latest.run_id));
    }
    return this.completeFromFile(download.callback_path);
  }

  async reconcileRunningGitHubTasks(timeoutSec = 300, intervalSec = 5): Promise<Array<{
    task_id: string;
    status: "reconciled" | "error";
    detail: string;
    outcome: DispatchOutcome | null;
    operator: TaskOperatorStatus | null;
  }>> {
    const runningGitHubTasks = this.taskStore
      .listTasks("running")
      .filter((record) => record.routing?.mode === "github");

    const results: Array<{
      task_id: string;
      status: "reconciled" | "error";
      detail: string;
      outcome: DispatchOutcome | null;
      operator: TaskOperatorStatus | null;
    }> = [];

    for (const record of runningGitHubTasks) {
      try {
        const outcome = await this.waitForGitHubCallback(record.task.task_id, timeoutSec, intervalSec);
        results.push({
          task_id: record.task.task_id,
          status: "reconciled",
          detail: outcome.detail,
          outcome,
          operator: this.buildOperatorStatus(record.task.task_id)
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        results.push({
          task_id: record.task.task_id,
          status: "error",
          detail,
          outcome: null,
          operator: this.buildOperatorStatus(record.task.task_id, [detail])
        });
      }
    }

    return results;
  }

  async recoverRunningTasks(
    options: {
      timeout_sec?: number;
      interval_sec?: number;
      requeue_local?: boolean;
    } = {}
  ): Promise<RunningTaskRecovery[]> {
    const runningTasks = this.taskStore.listTasks("running");
    const results: RunningTaskRecovery[] = [];

    for (const record of runningTasks) {
      if (record.routing?.mode === "github") {
        try {
          const outcome = await this.waitForGitHubCallback(
            record.task.task_id,
            options.timeout_sec,
            options.interval_sec
          );
          results.push({
            task_id: record.task.task_id,
            status: "reconciled",
            detail: outcome.detail,
            outcome,
            operator: this.buildOperatorStatus(record.task.task_id)
          });
        } catch (error) {
          const waitDetail = error instanceof Error ? error.message : String(error);
          try {
            const outcome = this.syncGitHubCallback(record.task.task_id);
            results.push({
              task_id: record.task.task_id,
              status: "reconciled",
              detail: outcome.detail,
              outcome,
              operator: this.buildOperatorStatus(record.task.task_id)
            });
          } catch (syncError) {
            const syncDetail = syncError instanceof Error ? syncError.message : String(syncError);
            const detail = syncDetail === waitDetail
              ? syncDetail
              : `${waitDetail} Fallback callback sync also failed: ${syncDetail}`;
            const routing = record.routing;
            const result: WorkerResult = {
              task_id: record.task.task_id,
              worker_target: routing.worker_target,
              status: "failed",
              review_verdict: null,
              summary: "Recovered unresolved GitHub task",
              artifacts: [],
              patch_ref: null,
              log_ref: null,
              cost: 0,
              duration_ms: 0,
              next_action: "manual",
              review_notes: [detail]
            };
            this.artifactStore.writeJson(record.task.task_id, "recovery-result.json", {
              recovered_at: Date.now(),
              requeue_local: false,
              result
            });
            this.taskStore.finish(record.task.task_id, "failed", result, routing, detail);
            results.push({
              task_id: record.task.task_id,
              status: "failed",
              detail,
              outcome: null,
              operator: this.buildOperatorStatus(record.task.task_id)
            });
          }
        }
        continue;
      }

      const routing = record.routing ?? {
        worker_target: record.task.worker_target,
        mode: "local" as const,
        reason: "recovered interrupted local task",
        fallback_from: null
      };
      const result: WorkerResult = {
        task_id: record.task.task_id,
        worker_target: routing.worker_target,
        status: "failed",
        review_verdict: null,
        summary: "Recovered interrupted local task",
        artifacts: [],
        patch_ref: null,
        log_ref: null,
        cost: 0,
        duration_ms: 0,
        next_action: options.requeue_local ? "retry" : "manual",
        review_notes: ["Codex Head recovered a task that was left in running state."]
      };
      this.artifactStore.writeJson(record.task.task_id, "recovery-result.json", {
        recovered_at: Date.now(),
        requeue_local: Boolean(options.requeue_local),
        result
      });

      if (options.requeue_local) {
        this.taskStore.finish(record.task.task_id, "failed", result, routing, result.summary);
        this.taskStore.enqueue(record.task.task_id);
        results.push({
          task_id: record.task.task_id,
          status: "requeued",
          detail: "Recovered interrupted local task and requeued it",
          outcome: null,
          operator: this.buildOperatorStatus(record.task.task_id)
        });
        continue;
      }

      this.taskStore.finish(record.task.task_id, "failed", result, routing, result.summary);
      results.push({
        task_id: record.task.task_id,
        status: "failed",
        detail: result.summary,
        outcome: null,
        operator: this.buildOperatorStatus(record.task.task_id)
      });
    }

    return results;
  }

  sweepTasks(options: SweepTasksOptions): SweepTasksResult {
    const dryRun = Boolean(options.dry_run);
    const now = options.now ?? Date.now();
    const selectedStates = normalizeSweepStates(options.action, options.states);
    const goalContains = options.goal_contains?.trim().toLowerCase() || null;
    const taskIds = [...new Set((options.task_ids ?? []).map((value) => value.trim()).filter(Boolean))];
    const taskIdSet = new Set(taskIds);
    const olderThanHours = options.older_than_hours ?? null;
    const cutoffTimestamp = olderThanHours === null ? null : now - (olderThanHours * 60 * 60 * 1000);
    const limit = options.limit && Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : null;
    const shouldApplyStateFilter = taskIds.length === 0 || Boolean(options.states && options.states.length > 0);

    const candidates = this.taskStore.listTasks()
      .filter((record) => !shouldApplyStateFilter || selectedStates.includes(record.state))
      .filter((record) => !goalContains || record.task.goal.toLowerCase().includes(goalContains))
      .filter((record) => !options.worker_target || record.task.worker_target === options.worker_target)
      .filter((record) => taskIds.length === 0 || taskIdSet.has(record.task.task_id))
      .filter((record) => cutoffTimestamp === null || resolveSweepTimestamp(record) <= cutoffTimestamp)
      .slice(0, limit ?? undefined);

    const entries: SweepTasksEntry[] = [];

    for (const record of candidates) {
      if (options.action === "cancel") {
        const allowed = record.state !== "completed" && record.state !== "canceled";
        const nextState: TaskState = allowed ? "canceled" : record.state;
        const reason = allowed
          ? (dryRun
            ? "Would cancel the selected task."
            : "Canceled the selected task.")
          : `Task in state ${record.state} cannot be canceled by sweep.`;

        if (!dryRun && allowed) {
          this.taskStore.transitionTask(record.task.task_id, "canceled", {
            last_error: record.last_error,
            finished: true
          });
        }

        entries.push({
          task_id: record.task.task_id,
          goal: record.task.goal,
          worker_target: record.task.worker_target,
          previous_state: record.state,
          next_state: nextState,
          changed: allowed,
          reason
        });
        continue;
      }

      const canRequeue = record.state === "failed" || record.state === "planned";
      const nextState: TaskState = canRequeue ? "queued" : record.state;
      const reason = canRequeue
        ? (dryRun
          ? "Would enqueue the selected task."
          : "Enqueued the selected task.")
        : `Task in state ${record.state} cannot be requeued by sweep.`;

      if (!dryRun && canRequeue) {
        this.taskStore.enqueue(record.task.task_id);
      }

      entries.push({
        task_id: record.task.task_id,
        goal: record.task.goal,
        worker_target: record.task.worker_target,
        previous_state: record.state,
        next_state: nextState,
        changed: canRequeue,
        reason
      });
    }

    return {
      action: options.action,
      dry_run: dryRun,
      receipt_path: null,
      filters: {
        states: selectedStates,
        older_than_hours: olderThanHours,
        goal_contains: goalContains,
        worker_target: options.worker_target ?? null,
        task_ids: taskIds,
        limit
      },
      matched: entries.length,
      changed: entries.filter((entry) => entry.changed).length,
      tasks: entries
    };
  }

  runSweepTasks(options: SweepTasksOptions): SweepTasksResult {
    const result = this.sweepTasks(options);
    const receipt_path = this.writeOperatorReceipt("sweep-tasks", {
      schema_version: 1,
      command: "sweep-tasks",
      created_at: new Date().toISOString(),
      dry_run: result.dry_run,
      apply: !result.dry_run,
      selection: {
        states: result.filters.states,
        older_than_hours: result.filters.older_than_hours,
        goal_contains: result.filters.goal_contains,
        worker_target: result.filters.worker_target,
        task_ids: result.filters.task_ids,
        limit: result.filters.limit
      },
      summary: {
        matched: result.matched,
        actionable: result.changed,
        changed: result.dry_run ? 0 : result.changed
      },
      tasks: result.tasks
    });
    return {
      ...result,
      receipt_path
    };
  }

  async createDoctorReport(options: DoctorOptions = {}): Promise<DoctorReport> {
    return buildDoctorReport(
      await this.smokeAdapters(),
      buildTaskStatusSnapshots(this.listTasks(), this.artifactStore),
      options
    );
  }

  listOperatorHistory(options: {
    command?: OperatorReceiptCommand;
    apply_only?: boolean;
    dry_run_only?: boolean;
    limit?: number;
  } = {}): OperatorHistoryResult {
    if (options.apply_only && options.dry_run_only) {
      throw new Error("operator-history cannot combine --apply-only with --dry-run-only");
    }

    const limit = options.limit === undefined
      ? 10
      : (!Number.isFinite(options.limit) || options.limit <= 0)
        ? (() => { throw new Error("operator-history limit must be a positive number"); })()
        : Math.floor(options.limit);

    const receiptPaths = this.artifactStore.listOperatorReceipts();
    const receipts: OperatorHistoryEntry[] = [];

    for (const receiptPath of receiptPaths) {
      const receipt = this.artifactStore.readOperatorReceiptIfExists<OperatorActionReceipt>(receiptPath);
      if (!receipt) {
        continue;
      }
      if (options.command && receipt.command !== options.command) {
        continue;
      }
      if (options.apply_only && !receipt.apply) {
        continue;
      }
      if (options.dry_run_only && !receipt.dry_run) {
        continue;
      }

      receipts.push({
        receipt_path: receiptPath,
        receipt
      });

      if (receipts.length >= limit) {
        break;
      }
    }

    return {
      filters: {
        command: options.command ?? null,
        apply_only: Boolean(options.apply_only),
        dry_run_only: Boolean(options.dry_run_only),
        limit
      },
      scanned: receiptPaths.length,
      returned: receipts.length,
      receipts
    };
  }

  async runDoctorHint(
    hintId: string,
    options: DoctorOptions & { apply?: boolean } = {}
  ): Promise<RunDoctorHintResult> {
    const report = await this.createDoctorReport(options);
    const hint = report.command_hints.find((entry) => entry.id === hintId);
    if (!hint) {
      throw new Error(`doctor hint ${hintId} was not found`);
    }
    const result = this.executeDoctorHintSweep(hint, Boolean(options.apply));
    const receipt_path = this.writeOperatorReceipt("run-doctor-hint", {
      schema_version: 1,
      command: "run-doctor-hint",
      created_at: new Date().toISOString(),
      dry_run: result.dry_run,
      apply: !result.dry_run,
      selection: {
        hint_id: hint.id,
        kind: hint.kind,
        include_all_task_history: options.include_all_task_history ?? false,
        task_window_hours: options.include_all_task_history ? null : (options.task_window_hours ?? 6)
      },
      summary: {
        matched: result.matched,
        actionable: result.changed,
        changed: result.dry_run ? 0 : result.changed
      },
      hints: [
        {
          id: hint.id,
          kind: hint.kind,
          reason: hint.reason,
          matched: result.matched,
          actionable: result.changed,
          changed: result.dry_run ? 0 : result.changed
        }
      ],
      tasks: result.tasks
    });

    return {
      report,
      hint,
      result: {
        ...result,
        receipt_path
      },
      receipt_path
    };
  }

  async runDoctorHints(
    options: DoctorOptions & {
      kind?: DoctorCommandHintKind;
      limit?: number;
      apply?: boolean;
      allow_multi_task_apply?: boolean;
      confirm_token?: string;
    } = {}
  ): Promise<RunDoctorHintsResult> {
    const report = await this.createDoctorReport(options);
    const limit = options.limit === undefined
      ? null
      : (!Number.isFinite(options.limit) || options.limit <= 0)
        ? (() => { throw new Error("doctor hint limit must be a positive number"); })()
        : Math.floor(options.limit);
    const selectedHints = report.command_hints
      .filter((entry) => !options.kind || entry.kind === options.kind)
      .slice(0, limit ?? undefined);

    if (selectedHints.length === 0) {
      if (options.kind) {
        throw new Error(`doctor hints for kind ${options.kind} were not found`);
      }
      throw new Error("doctor report does not contain any runnable hints");
    }

    const preview = selectedHints.map((hint) => ({
      hint,
      result: this.executeDoctorHintSweep(hint, false)
    }));
    const previewSummary = summarizeRunDoctorHints(preview);
    const confirmToken = this.createRunDoctorHintsConfirmToken(options.kind ?? null, limit, preview);
    if (options.apply && previewSummary.totalActionable > 1 && !options.allow_multi_task_apply) {
      throw new Error(
        `run-doctor-hints would change ${previewSummary.totalActionable} tasks across `
        + `${selectedHints.length} hints; rerun with --allow-multi-task-apply after reviewing the dry-run preview`
      );
    }
    if (options.apply && !options.confirm_token) {
      throw new Error(
        `run-doctor-hints --apply requires --confirm-token ${confirmToken}; `
        + "rerun without --apply to refresh the current dry-run preview first"
      );
    }
    if (options.apply && options.confirm_token !== confirmToken) {
      throw new Error(
        `run-doctor-hints confirm token mismatch: expected ${confirmToken}, received ${options.confirm_token}; `
        + "rerun without --apply to refresh the current dry-run preview"
      );
    }
    const apply = Boolean(options.apply);
    const results = apply
      ? selectedHints.map((hint) => ({
        hint,
        result: this.executeDoctorHintSweep(hint, true)
      }))
      : preview;
    const receipt_path = this.writeOperatorReceipt("run-doctor-hints", {
      schema_version: 1,
      command: "run-doctor-hints",
      created_at: new Date().toISOString(),
      dry_run: !apply,
      apply,
      selection: {
        kind: options.kind ?? null,
        limit,
        confirm_token: confirmToken,
        include_all_task_history: options.include_all_task_history ?? false,
        task_window_hours: options.include_all_task_history ? null : (options.task_window_hours ?? 6)
      },
      summary: {
        matched: previewSummary.totalMatched,
        actionable: previewSummary.totalActionable,
        changed: apply ? previewSummary.totalActionable : 0
      },
      hints: results.map((entry) => ({
        id: entry.hint.id,
        kind: entry.hint.kind,
        reason: entry.hint.reason,
        matched: entry.result.matched,
        actionable: entry.result.changed,
        changed: entry.result.dry_run ? 0 : entry.result.changed
      })),
      tasks: flattenSweepEntries(results)
    });

    return {
      report,
      kind: options.kind ?? null,
      limit,
      apply,
      allow_multi_task_apply: Boolean(options.allow_multi_task_apply),
      confirm_token: confirmToken,
      total_matched: previewSummary.totalMatched,
      total_actionable: previewSummary.totalActionable,
      preview,
      results: results.map((entry) => ({
        hint: entry.hint,
        result: {
          ...entry.result,
          receipt_path
        }
      })),
      receipt_path
    };
  }

  getTask(taskId: string): TaskRecord {
    return this.taskStore.getTaskOrThrow(taskId);
  }

  listTasks(): TaskRecord[] {
    return this.taskStore.listTasks();
  }

  private buildOperatorStatus(taskId: string, extraTexts: string[] = []): TaskOperatorStatus | null {
    try {
      return buildTaskOperatorStatus(this.taskStore.getTaskOrThrow(taskId), this.artifactStore, extraTexts);
    } catch {
      return null;
    }
  }

  private executeDoctorHintSweep(hint: DoctorCommandHint, apply: boolean): SweepTasksResult {
    return this.sweepTasks({
      action: hint.sweep.action,
      states: hint.sweep.states,
      older_than_hours: hint.sweep.older_than_hours,
      goal_contains: hint.sweep.goal_contains,
      worker_target: hint.sweep.worker_target,
      task_ids: hint.sweep.task_ids,
      limit: hint.sweep.limit,
      dry_run: !apply
    });
  }

  private writeOperatorReceipt(commandName: string, payload: unknown): string {
    return this.artifactStore.writeOperatorReceipt(commandName, payload);
  }

  private createRunDoctorHintsConfirmToken(
    kind: DoctorCommandHintKind | null,
    limit: number | null,
    preview: RunDoctorHintsEntryResult[]
  ): string {
    const payload = {
      kind,
      limit,
      preview: preview.map((entry) => ({
        hint_id: entry.hint.id,
        hint_kind: entry.hint.kind,
        sweep: entry.hint.sweep,
        tasks: entry.result.tasks.map((task) => ({
          task_id: task.task_id,
          previous_state: task.previous_state,
          next_state: task.next_state,
          changed: task.changed
        }))
      }))
    };

    return createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")
      .slice(0, 12);
  }

  private tryResolveGitHubRun(task: TaskSpec): TaskRecord["github_run"] | null {
    const candidate = (this.github as unknown as {
      resolveTaskRun?: (taskInput: TaskSpec) => TaskRecord["github_run"] | null;
    }).resolveTaskRun;
    return typeof candidate === "function" ? candidate.call(this.github, task) : null;
  }

  private formatGitHubCallbackFailure(taskId: string, error: unknown, runId: number | null): string {
    let detail = error instanceof Error ? error.message : String(error);

    if (runId !== null && Number.isFinite(runId)) {
      const candidate = (this.github as unknown as {
        diagnoseQueuedRunIfPresent?: (
          queuedTaskId: string,
          queuedRunId: number,
          queuedForMs?: number
        ) => {
          reason: string;
          suggested_action: string | null;
        } | null;
      }).diagnoseQueuedRunIfPresent;

      if (typeof candidate === "function") {
        const diagnosis = candidate.call(this.github, taskId, runId, 0);
        if (diagnosis) {
          if (!detail.includes(diagnosis.reason)) {
            detail = `${detail} ${diagnosis.reason}`;
          }
          if (diagnosis.suggested_action && !detail.includes(diagnosis.suggested_action)) {
            detail = `${detail} ${diagnosis.suggested_action}`;
          }
        }
      }
    }

    const diagnosisPath = join(this.artifactStore.getTaskDir(taskId), "github-queue-diagnosis.json");
    if (existsSync(diagnosisPath) && !detail.includes(diagnosisPath)) {
      detail = `${detail} See ${diagnosisPath} for runner queue diagnosis.`;
    }

    const recyclePath = join(this.artifactStore.getTaskDir(taskId), "github-queue-recycle.json");
    if (this.hasSuccessfulQueueRecycle(taskId) && !/manual intervention is now required/i.test(detail)) {
      detail = `${detail} Automatic stale-runner recovery was already attempted and manual intervention is now required. See ${recyclePath}.`;
    }

    return detail;
  }

  private hasSuccessfulQueueRecycle(taskId: string): boolean {
    const recyclePath = join(this.artifactStore.getTaskDir(taskId), "github-queue-recycle.json");
    if (!existsSync(recyclePath)) {
      return false;
    }

    try {
      const parsed = JSON.parse(readFileSync(recyclePath, "utf8")) as { ok?: boolean };
      return parsed.ok === true;
    } catch {
      return false;
    }
  }

  private async inspectAdapterReadiness(healthEntries?: Awaited<ReturnType<AdapterRegistry["health"]>>): Promise<AdapterRuntimeReadiness[]> {
    const resolvedHealthEntries = healthEntries ?? await this.registry.health();
    const penaltiesByWorker = new Map(
      this.getRecentWorkerPenalties().map((penalty) => [penalty.worker_target, penalty] as const)
    );
    return resolvedHealthEntries.map((entry) => {
      const adapter = this.registry.get(entry.worker_target);
      const featureEnabled = adapter.capability.feature_flag
        ? Boolean(this.config.feature_flags[adapter.capability.feature_flag])
        : true;
      const hasLocalTemplate = Boolean(this.config.command_templates[entry.worker_target].local);
      const penalty = penaltiesByWorker.get(entry.worker_target);

      return {
        worker_target: entry.worker_target,
        healthy: entry.healthy,
        feature_enabled: featureEnabled,
        supports_local: adapter.capability.supports_local,
        supports_github: adapter.capability.supports_github,
        has_local_template: hasLocalTemplate,
        local_ready: entry.healthy
          && featureEnabled
          && adapter.capability.supports_local
          && hasLocalTemplate
          && !penalty,
        github_ready: featureEnabled && adapter.capability.supports_github && this.config.github.enabled,
        cooldown_until: penalty?.penalized_until ?? null,
        cooldown_reason: penalty?.detail ?? null
      };
    });
  }

  async smokeAdapters() {
    const adapters = await this.registry.health();
    return {
      adapters,
      readiness: await this.inspectAdapterReadiness(adapters),
      recent_penalties: this.getRecentWorkerPenalties(),
      github: this.github.inspectRuntime(),
      database_path: this.config.database_path,
      artifacts_dir: this.config.artifacts_dir
    };
  }
}

function summarizeRunDoctorHints(results: RunDoctorHintsEntryResult[]): {
  totalMatched: number;
  totalActionable: number;
} {
  const matchedTaskIds = new Set<string>();
  const actionableTaskIds = new Set<string>();

  for (const entry of results) {
    for (const task of entry.result.tasks) {
      matchedTaskIds.add(task.task_id);
      if (task.changed) {
        actionableTaskIds.add(task.task_id);
      }
    }
  }

  return {
    totalMatched: matchedTaskIds.size,
    totalActionable: actionableTaskIds.size
  };
}

function flattenSweepEntries(results: RunDoctorHintsEntryResult[]): SweepTasksEntry[] {
  const byTaskId = new Map<string, SweepTasksEntry>();
  for (const entry of results) {
    for (const task of entry.result.tasks) {
      byTaskId.set(task.task_id, task);
    }
  }
  return [...byTaskId.values()];
}
