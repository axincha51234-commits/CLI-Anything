import { dirname, join } from "node:path";
import type { AdapterHealth, AdapterRuntimeReadiness, ReviewProviderProfile, TaskState, WorkerTarget } from "./contracts";
import type { GitHubRuntimeStatus } from "./github/controlPlane";
import type { LocalReviewStackSnapshot } from "./localStack";
import type { TaskArtifactRefs, TaskStatusSnapshot } from "./status";

export type DoctorFindingSeverity = "error" | "warning" | "info";
export const DOCTOR_COMMAND_HINT_KINDS = [
  "queued_backlog",
  "suppressed_failed_backlog"
] as const;
export type DoctorCommandHintKind = (typeof DOCTOR_COMMAND_HINT_KINDS)[number];
const CLI_BRIEF_PREFIX = "node --disable-warning=ExperimentalWarning dist/src/index.js";

export interface DoctorPenaltySnapshot {
  worker_target: WorkerTarget;
  category: string;
  detail: string;
  penalized_until: number;
  source_task_id: string;
}

export interface DoctorHealthSnapshot {
  adapters: AdapterHealth[];
  readiness: AdapterRuntimeReadiness[];
  recent_penalties: DoctorPenaltySnapshot[];
  github: GitHubRuntimeStatus;
  local_stack: LocalReviewStackSnapshot;
  database_path: string;
  artifacts_dir: string;
}

export interface DoctorWorkerFinding {
  worker_target: WorkerTarget;
  severity: DoctorFindingSeverity;
  summary: string;
  actions: string[];
}

export interface DoctorGitHubFinding {
  severity: DoctorFindingSeverity;
  summary: string;
  actions: string[];
}

export interface DoctorIntegrationFinding {
  integration: "local_review_stack";
  severity: DoctorFindingSeverity;
  summary: string;
  actions: string[];
}

export interface DoctorTaskFinding {
  task_id: string;
  state: TaskState;
  goal: string;
  worker_target: WorkerTarget;
  review_profile?: ReviewProviderProfile | null;
  review_dispatch_degraded: boolean;
  routing_mode: "local" | "github" | null;
  artifact_dir_path: string;
  artifact_refs: TaskArtifactRefs;
  github_run_url: string | null;
  severity: DoctorFindingSeverity;
  summary: string;
  actions: string[];
  has_operator_actions: boolean;
  operator_receipt_path: string | null;
  operator_receipt_command: string | null;
  operator_receipt_created_at: string | null;
  manual_intervention_required: boolean;
}

export interface DoctorSweepPayload {
  action: "cancel" | "requeue";
  states?: TaskState[];
  older_than_hours?: number;
  goal_contains?: string;
  worker_target?: WorkerTarget;
  task_ids?: string[];
  limit?: number;
}

export interface DoctorCommandHint {
  id: string;
  kind: DoctorCommandHintKind;
  reason: string;
  command: string;
  sweep: DoctorSweepPayload;
}

export interface DoctorReport {
  ok: boolean;
  generated_at: string;
  summary: string;
  task_filter: {
    include_all_task_history: boolean;
    task_window_hours: number | null;
    cutoff_at: string | null;
    suppressed_task_findings: number;
  };
  counts: {
    total_tasks: number;
    task_states: Partial<Record<TaskState, number>>;
    enabled_workers: number;
    workers_needing_attention: number;
    github_findings: number;
    integration_findings: number;
    tasks_needing_attention: number;
    suppressed_task_findings: number;
    blocking_findings: number;
    warning_findings?: number;
    informational_findings: number;
  };
  health: DoctorHealthSnapshot;
  attention: {
    workers: DoctorWorkerFinding[];
    github: DoctorGitHubFinding[];
    integrations: DoctorIntegrationFinding[];
    tasks: DoctorTaskFinding[];
  };
  actions: string[];
  command_hints: DoctorCommandHint[];
}

export interface DoctorOptions {
  include_all_task_history?: boolean;
  task_window_hours?: number;
  now?: number;
}

function hasText(value: string | null | undefined): value is string {
  return Boolean(value && value.trim());
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(hasText))];
}

function formatTimestamp(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return new Date(value).toISOString();
}

function severityRank(value: DoctorFindingSeverity): number {
  if (value === "error") {
    return 0;
  }
  if (value === "warning") {
    return 1;
  }
  return 2;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildStateCounts(tasks: TaskStatusSnapshot[]): Partial<Record<TaskState, number>> {
  const counts: Partial<Record<TaskState, number>> = {};
  for (const task of tasks) {
    counts[task.state] = (counts[task.state] ?? 0) + 1;
  }
  return counts;
}

function summarizeWorkerFinding(
  readiness: AdapterRuntimeReadiness,
  adapter: AdapterHealth | undefined
): DoctorWorkerFinding | null {
  if (!readiness.feature_enabled) {
    return null;
  }

  const adapterReason = adapter?.reason?.trim() ?? "";

  if (!readiness.healthy) {
    const reason = hasText(adapterReason) ? adapterReason : "Health check failed.";
    const actions = /not found|enoent|missing/i.test(reason)
      ? [`Install or expose the ${readiness.worker_target} binary on PATH.`]
      : /auth|login|unauthorized|forbidden/i.test(reason)
        ? [`Refresh ${readiness.worker_target} authentication before retrying local execution.`]
        : [`Inspect the ${readiness.worker_target} health command and local runtime.`];
    return {
      worker_target: readiness.worker_target,
      severity: "error",
      summary: `Worker ${readiness.worker_target} health check failed: ${reason}`,
      actions
    };
  }

  if (readiness.cooldown_until) {
    const until = formatTimestamp(readiness.cooldown_until);
    return {
      worker_target: readiness.worker_target,
      severity: "warning",
      summary: until
        ? `Worker ${readiness.worker_target} is cooling down until ${until}.`
        : `Worker ${readiness.worker_target} is cooling down after a recent provider failure.`,
      actions: dedupe([
        "Wait for the cooldown to expire or clear penalties once the provider is healthy again.",
        readiness.cooldown_reason ?? ""
      ])
    };
  }

  if (readiness.supports_local && !readiness.has_local_template) {
    const githubReviewReady = readiness.github_review_ready
      ?? (readiness.supports_github && readiness.github_ready);
    if (githubReviewReady) {
      return null;
    }
    return {
      worker_target: readiness.worker_target,
      severity: "warning",
      summary: `Worker ${readiness.worker_target} is enabled but has no local command template configured.`,
      actions: [`Add command_templates.${readiness.worker_target}.local if this worker should execute on the machine.`]
    };
  }

  if (readiness.supports_local && !readiness.local_ready) {
    return {
      worker_target: readiness.worker_target,
      severity: "warning",
      summary: `Worker ${readiness.worker_target} is enabled but not currently local-ready.`,
      actions: [`Inspect the local template and runtime prerequisites for ${readiness.worker_target}.`]
    };
  }

  return null;
}

function buildWorkerFindings(health: DoctorHealthSnapshot): DoctorWorkerFinding[] {
  const adapterByTarget = new Map(health.adapters.map((entry) => [entry.worker_target, entry]));
  return health.readiness
    .map((readiness) => summarizeWorkerFinding(readiness, adapterByTarget.get(readiness.worker_target)))
    .filter((entry): entry is DoctorWorkerFinding => Boolean(entry))
    .sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
}

function buildGitHubFindings(runtime: GitHubRuntimeStatus): DoctorGitHubFinding[] {
  if (!runtime.enabled) {
    return [];
  }

  const findings: DoctorGitHubFinding[] = [];

  if (runtime.repository === "OWNER/REPO") {
    findings.push({
      severity: "error",
      summary: "GitHub dispatch is enabled but github.repository is still the placeholder OWNER/REPO.",
      actions: [
        "Run configure-github-repo OWNER/REPO or set github.repository before dispatching GitHub work."
      ]
    });
  }

  if (!runtime.gh_cli_available) {
    findings.push({
      severity: "error",
      summary: "GitHub dispatch is enabled but the gh CLI binary is not available.",
      actions: [
        "Install GitHub CLI or set github.cli_binary to a reachable gh executable."
      ]
    });
  } else if (!runtime.gh_authenticated) {
    findings.push({
      severity: "error",
      summary: "GitHub dispatch is enabled but gh is not authenticated on this machine.",
      actions: [
        "Run gh auth login on the machine that dispatches or reconciles GitHub workflows."
      ]
    });
  }

  if (runtime.self_hosted_targeted) {
    if (runtime.matching_runners.length === 0) {
      findings.push({
        severity: "error",
        summary: "No self-hosted runner currently matches CODEX_HEAD_RUNS_ON_JSON.",
        actions: [
          "Check CODEX_HEAD_RUNS_ON_JSON and the self-hosted runner labels so at least one runner matches the workflow."
        ]
      });
    } else if (runtime.matching_runners.every((entry) => entry.status !== "online")) {
      findings.push({
        severity: "error",
        summary: "Matching self-hosted runners exist, but all of them are offline.",
        actions: [
          "Bring one matching self-hosted runner back online or restart the runner listener cleanly."
        ]
      });
    } else if (runtime.matching_runners.every((entry) => entry.busy)) {
      findings.push({
        severity: "warning",
        summary: "Matching self-hosted runners are online, but all of them are currently busy.",
        actions: [
          "Wait for a runner slot or free one of the matching self-hosted runners."
        ]
      });
    }

    if (!runtime.machine_config_exists && runtime.machine_config_path) {
      findings.push({
        severity: "warning",
        summary: "The configured machine-local override file is missing on disk.",
        actions: [
          "Create the machine config file or update CODEX_HEAD_MACHINE_CONFIG so self-hosted jobs can see the expected local overrides."
        ]
      });
    }
  }

  if (runtime.review_workflow && runtime.review_workflow_supports_review_profile === false) {
    const syncAction = runtime.review_workflow_sync_action
      ?? `Push or sync .github/workflows/${runtime.review_workflow} to the GitHub default branch so review_profile is accepted during workflow_dispatch and research/code-assist routing works live.`;
    const syncCommands = runtime.review_workflow_sync_commands ?? [];
    const localDriftDetail = runtime.review_workflow_local_vs_origin_status
      ? ` Local workflow status: ${runtime.review_workflow_local_vs_origin_status}.`
      : "";
    findings.push({
      severity: "warning",
      summary: `Remote review workflow ${runtime.review_workflow} is missing the review_profile workflow_dispatch input, so specialized live review profiles will fall back to legacy standard routing.${localDriftDetail}`,
      actions: dedupe([
        syncAction,
        ...syncCommands
      ])
    });
  }

  if (runtime.auto_recycle_stale_runner && !runtime.recycle_script_available) {
    findings.push({
      severity: "warning",
      summary: "Automatic stale-runner recycle is enabled, but the recycle helper script is not present.",
      actions: [
        "Place recycle-self-hosted-runner.ps1 on disk or disable github.auto_recycle_stale_runner."
      ]
    });
  }

  return findings.sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
}

function buildIntegrationFindings(health: DoctorHealthSnapshot): DoctorIntegrationFinding[] {
  if (!health.github.self_hosted_targeted) {
    return [];
  }

  const stack = health.local_stack;
  const helperDirectory = stack.helper_script_available ? dirname(stack.helper_script_path) : null;
  const bootstrapAction = stack.helper_bootstrap_command
    ? `Run ${stack.helper_bootstrap_command} to start or repair the local review stack.`
    : "Start the local 9router and Antigravity-Manager services on this machine.";
  const perplexityBootstrapCommand = helperDirectory
    ? `powershell -ExecutionPolicy Bypass -File "${join(helperDirectory, "ensure-9router-perplexity-stack.ps1")}"`
    : null;
  const blackboxBootstrapCommand = helperDirectory
    ? `powershell -ExecutionPolicy Bypass -File "${join(helperDirectory, "ensure-9router-blackbox-stack.ps1")}"`
    : null;
  const findings: DoctorIntegrationFinding[] = [];

  if (!stack.antigravity.reachable && !stack.router9.reachable) {
    findings.push({
      integration: "local_review_stack",
      severity: "error",
      summary: "The self-hosted review path expects 9router and Antigravity-Manager, but neither local endpoint is reachable.",
      actions: [bootstrapAction]
    });
    return findings;
  }

  if (!stack.antigravity.reachable) {
    findings.push({
      integration: "local_review_stack",
      severity: "error",
      summary: `Antigravity-Manager is not reachable at ${stack.antigravity.base_url}.`,
      actions: [bootstrapAction]
    });
  }

  if (!stack.router9.reachable) {
    findings.push({
      integration: "local_review_stack",
      severity: "error",
      summary: `9router is not reachable at ${stack.router9.base_url}.`,
      actions: [bootstrapAction]
    });
  }

  if (stack.router9.reachable && (!stack.router9.agm_chat.present || stack.router9.agm_chat.active_connection !== true)) {
    findings.push({
      integration: "local_review_stack",
      severity: "error",
      summary: "9router is up, but the agm chat route is not ready for review traffic.",
      actions: [
        bootstrapAction,
        `Inspect ${stack.router9.base_url}/api/provider-nodes and ${stack.router9.base_url}/api/providers to confirm the agm route is seeded and active.`
      ]
    });
  }

  if (stack.antigravity.reachable && stack.antigravity.proxy_status_available && stack.antigravity.running === false) {
    findings.push({
      integration: "local_review_stack",
      severity: "warning",
      summary: "Antigravity-Manager responded, but proxy status reports the service as not running.",
      actions: [bootstrapAction]
    });
  }

  if (stack.antigravity.reachable && stack.antigravity.proxy_status_available && stack.antigravity.active_accounts === 0) {
    findings.push({
      integration: "local_review_stack",
      severity: "warning",
      summary: "Antigravity-Manager is reachable, but there are no active accounts in the local provider pool.",
      actions: ["Sign in or reactivate at least one Antigravity-managed account before dispatching review work."]
    });
  }

  if (stack.perplexity) {
    if (!stack.perplexity.manager_reachable) {
      findings.push({
        integration: "local_review_stack",
        severity: "info",
        summary: `Perplexity runtime manager is not reachable at ${stack.perplexity.manager_base_url}.`,
        actions: perplexityBootstrapCommand
          ? [`Run ${perplexityBootstrapCommand} to start or repair the Perplexity runtime manager and seed the pplxapp route.`]
          : ["Start the Perplexity runtime manager and seed the pplxapp route if you want that optional provider path available."]
      });
    } else if (!stack.perplexity.cdp_reachable) {
      findings.push({
        integration: "local_review_stack",
        severity: "info",
        summary: `Perplexity runtime manager responded, but CDP is not reachable at ${stack.perplexity.cdp_base_url}.`,
        actions: perplexityBootstrapCommand
          ? [`Run ${perplexityBootstrapCommand} to relaunch Perplexity with remote debugging enabled and repair the pplxapp route.`]
          : ["Restart Perplexity with remote debugging enabled if you want the optional pplxapp route available."]
      });
    } else if (!stack.perplexity.pplxapp_chat.present || stack.perplexity.pplxapp_chat.active_connection !== true) {
      findings.push({
        integration: "local_review_stack",
        severity: "info",
        summary: "Perplexity runtime manager is up, but the pplxapp chat route is not active in 9router.",
        actions: perplexityBootstrapCommand
          ? [
              `Run ${perplexityBootstrapCommand} to seed or reactivate the pplxapp route.`,
              `Inspect ${stack.router9.base_url}/api/provider-nodes and ${stack.router9.base_url}/api/providers to confirm the pplxapp route is active.`
            ]
          : [`Inspect ${stack.router9.base_url}/api/provider-nodes and ${stack.router9.base_url}/api/providers to confirm the pplxapp route is active.`]
      });
    }
  }

  if (stack.blackbox) {
    if (!stack.blackbox.manager_reachable) {
      findings.push({
        integration: "local_review_stack",
        severity: "info",
        summary: `BLACKBOXAI account manager is not reachable at ${stack.blackbox.manager_base_url}.`,
        actions: blackboxBootstrapCommand
          ? [`Run ${blackboxBootstrapCommand} to start or repair the BLACKBOXAI account manager and seed the bbxapp route.`]
          : ["Start the BLACKBOXAI account manager and seed the bbxapp route if you want that optional provider path available."]
      });
    } else if (stack.blackbox.identity_loaded === false || stack.blackbox.user_id_present === false) {
      findings.push({
        integration: "local_review_stack",
        severity: "info",
        summary: "BLACKBOXAI account manager responded, but local identity is not fully loaded from state.vscdb.",
        actions: blackboxBootstrapCommand
          ? [`Run ${blackboxBootstrapCommand} to refresh the BLACKBOXAI account manager identity and route wiring.`]
          : ["Refresh the BLACKBOXAI account manager identity from state.vscdb if you want the optional bbxapp route available."]
      });
    } else if (!stack.blackbox.bbxapp_chat.present || stack.blackbox.bbxapp_chat.active_connection !== true) {
      findings.push({
        integration: "local_review_stack",
        severity: "info",
        summary: "BLACKBOXAI account manager is up, but the bbxapp chat route is not active in 9router.",
        actions: blackboxBootstrapCommand
          ? [
              `Run ${blackboxBootstrapCommand} to seed or reactivate the bbxapp route.`,
              `Inspect ${stack.router9.base_url}/api/provider-nodes and ${stack.router9.base_url}/api/providers to confirm the bbxapp route is active.`
            ]
          : [`Inspect ${stack.router9.base_url}/api/provider-nodes and ${stack.router9.base_url}/api/providers to confirm the bbxapp route is active.`]
      });
    }
  }

  return findings.sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
}

function deriveTaskSummary(task: TaskStatusSnapshot, reviewDispatchNeedsAttention: boolean): string {
  if (task.operator.summary) {
    return task.operator.summary;
  }
  if (reviewDispatchNeedsAttention) {
    return "Specialized review dispatch used legacy standard routing because the remote workflow did not accept review_profile.";
  }
  if (task.state === "failed") {
    return task.last_error ?? task.result?.summary ?? "Task failed and needs attention.";
  }
  if (task.state === "awaiting_review") {
    return "Task is awaiting required review input.";
  }
  if (task.state === "queued") {
    return "Task is queued and waiting for dispatch.";
  }
  if (task.state === "running") {
    if (task.github_run) {
      const conclusion = task.github_run.conclusion ? `/${task.github_run.conclusion}` : "";
      return `GitHub run is ${task.github_run.status}${conclusion}.`;
    }
    return "Task is still running.";
  }
  return task.result?.summary ?? "Task needs operator attention.";
}

function deriveTaskActions(task: TaskStatusSnapshot, reviewDispatchNeedsAttention: boolean): string[] {
  const actions = new Set(task.operator.actions);

  if (reviewDispatchNeedsAttention) {
    actions.add("Sync the remote review workflow on the default branch if this task should use research/code-assist routing live.");
  }

  if (actions.size > 0) {
    return [...actions];
  }

  if (task.state === "awaiting_review") {
    actions.add("Record a review verdict or continue the required review workflow for this task.");
  } else if (task.state === "queued") {
    actions.add("Dispatch the queued task when the workspace and workers are ready.");
  } else if (task.state === "running") {
    if (task.github_run) {
      actions.add("Wait for the workflow to finish or run reconcile-github-running if this GitHub task looks stuck.");
    } else {
      actions.add("Wait for the local task to finish or run recover-running if the previous session was interrupted.");
    }
  } else if (task.state === "failed") {
    actions.add("Inspect the task artifacts and rerun or requeue the task after fixing the root cause.");
  }

  return [...actions];
}

function isActiveTask(task: TaskStatusSnapshot): boolean {
  return task.state === "running" || task.state === "queued" || task.state === "awaiting_review";
}

function resolveTaskFreshnessTimestamp(task: TaskStatusSnapshot): number {
  return task.updated_at
    || task.finished_at
    || task.started_at
    || task.created_at
    || 0;
}

function shouldIncludeTaskFinding(
  task: TaskStatusSnapshot,
  includeAllTaskHistory: boolean,
  cutoffTimestamp: number | null
): boolean {
  const needsAttention = task.operator.manual_intervention_required
    || task.operator.actions.length > 0
    || (task.review_dispatch?.degraded ?? false)
    || task.state === "failed"
    || isActiveTask(task);

  if (!needsAttention) {
    return false;
  }

  if (isActiveTask(task)) {
    return true;
  }
  if (task.operator.manual_intervention_required) {
    return true;
  }
  if (includeAllTaskHistory || cutoffTimestamp === null) {
    return true;
  }
  return resolveTaskFreshnessTimestamp(task) >= cutoffTimestamp;
}

function summarizeTaskFinding(
  task: TaskStatusSnapshot,
  includeAllTaskHistory: boolean,
  cutoffTimestamp: number | null,
  runtimeReviewProfileRoutingHealthy: boolean
): DoctorTaskFinding | null {
  const reviewDispatchNeedsAttention = Boolean(
    task.review_dispatch?.degraded
    && (includeAllTaskHistory || !runtimeReviewProfileRoutingHealthy)
  );
  const activeState = task.state === "running" || task.state === "queued" || task.state === "awaiting_review";
  const needsAttention = task.operator.manual_intervention_required
    || task.operator.actions.length > 0
    || reviewDispatchNeedsAttention
    || task.state === "failed"
    || activeState;

  if (!needsAttention || !shouldIncludeTaskFinding(task, includeAllTaskHistory, cutoffTimestamp)) {
    return null;
  }

  let severity: DoctorFindingSeverity = "info";
  if (task.operator.manual_intervention_required || task.state === "failed") {
    severity = "error";
  } else if (
    task.operator.actions.length > 0
    || reviewDispatchNeedsAttention
    || task.state === "queued"
    || task.state === "awaiting_review"
  ) {
    severity = "warning";
  }

  return {
    task_id: task.task.task_id,
    state: task.state,
    goal: task.task.goal,
    worker_target: task.task.worker_target,
    review_profile: task.task.review_profile ?? null,
    review_dispatch_degraded: task.review_dispatch?.degraded ?? false,
    routing_mode: task.routing?.mode ?? null,
    artifact_dir_path: task.artifact_dir_path,
    artifact_refs: task.artifact_refs,
    github_run_url: task.github_run?.run_url ?? null,
    severity,
    summary: deriveTaskSummary(task, reviewDispatchNeedsAttention),
    actions: deriveTaskActions(task, reviewDispatchNeedsAttention),
    has_operator_actions: task.operator.actions.length > 0,
    operator_receipt_path: task.operator.latest_receipt_path,
    operator_receipt_command: task.operator.latest_receipt_command,
    operator_receipt_created_at: task.operator.latest_receipt_created_at,
    manual_intervention_required: task.operator.manual_intervention_required
  };
}

function buildTaskFindings(
  tasks: TaskStatusSnapshot[],
  includeAllTaskHistory: boolean,
  cutoffTimestamp: number | null,
  runtimeReviewProfileRoutingHealthy: boolean
): {
  findings: DoctorTaskFinding[];
  suppressedCount: number;
  suppressedFailedCount: number;
} {
  const findings = tasks
    .map((task) => summarizeTaskFinding(
      task,
      includeAllTaskHistory,
      cutoffTimestamp,
      runtimeReviewProfileRoutingHealthy
    ))
    .filter((entry): entry is DoctorTaskFinding => Boolean(entry))
    .sort((left, right) => {
      const severityDelta = severityRank(left.severity) - severityRank(right.severity);
      if (severityDelta !== 0) {
        return severityDelta;
      }
      return left.task_id.localeCompare(right.task_id);
    });

  const suppressedTasks = tasks.filter((task) => {
    const reviewDispatchNeedsAttention = Boolean(
      task.review_dispatch?.degraded
      && (includeAllTaskHistory || !runtimeReviewProfileRoutingHealthy)
    );
    const needsAttention = task.operator.manual_intervention_required
      || task.operator.actions.length > 0
      || reviewDispatchNeedsAttention
      || task.state === "failed"
      || isActiveTask(task);
    return needsAttention && !shouldIncludeTaskFinding(task, includeAllTaskHistory, cutoffTimestamp);
  });
  const suppressedCount = suppressedTasks.length;
  const suppressedFailedCount = suppressedTasks.filter((task) => task.state === "failed").length;

  return {
    findings,
    suppressedCount,
    suppressedFailedCount
  };
}

function buildSummary(
  enabledWorkers: number,
  tasks: TaskStatusSnapshot[],
  blockingFindings: number,
  warningFindings: number,
  informationalFindings: number,
  workerFindings: DoctorWorkerFinding[],
  githubFindings: DoctorGitHubFinding[],
  integrationFindings: DoctorIntegrationFinding[],
  taskFindings: DoctorTaskFinding[]
): string {
  if (blockingFindings === 0 && warningFindings === 0 && informationalFindings === 0) {
    return `No blocking issues found across ${tasks.length} task(s) and ${enabledWorkers} enabled worker(s).`;
  }

  if (blockingFindings === 0 && warningFindings === 0) {
    return `No blocking issues found, but ${informationalFindings} active item(s) still deserve monitoring.`;
  }

  const blockingTaskFindings = taskFindings.filter((entry) => entry.severity !== "info").length;
  const segments = [
    workerFindings.length > 0 ? pluralize(workerFindings.length, "worker finding") : "",
    githubFindings.length > 0 ? pluralize(githubFindings.length, "GitHub finding") : "",
    integrationFindings.length > 0 ? pluralize(integrationFindings.length, "integration finding") : "",
    blockingTaskFindings > 0 ? pluralize(blockingTaskFindings, "task finding") : ""
  ].filter(Boolean);

  const joinedSegments = segments.length > 0 ? segments.join(", ") : "runtime";
  const errorFindings = blockingFindings;
  if (errorFindings === 0 && warningFindings > 0) {
    return `Found ${pluralize(warningFindings, "attention item")} across ${joinedSegments}.`;
  }
  if (warningFindings === 0) {
    return `Found ${pluralize(errorFindings, "blocking item")} across ${joinedSegments}.`;
  }
  return `Found ${pluralize(errorFindings, "blocking item")} and ${pluralize(warningFindings, "attention item")} across ${joinedSegments}.`;
}

function buildCommandHints(
  taskFindings: DoctorTaskFinding[],
  taskWindowHours: number | null,
  suppressedTaskFindings: number,
  suppressedFailedTaskFindings: number
): DoctorCommandHint[] {
  const hints: DoctorCommandHint[] = [];

  for (const [index, entry] of taskFindings.filter((task) => task.state === "queued").slice(0, 3).entries()) {
    hints.push({
      id: `queued-backlog-${index + 1}`,
      kind: "queued_backlog",
      reason: `Inspect queued task ${entry.task_id} before canceling it from the backlog.`,
      command: `${CLI_BRIEF_PREFIX} sweep-tasks cancel --task-id ${entry.task_id} --dry-run --brief`,
      sweep: {
        action: "cancel",
        task_ids: [entry.task_id]
      }
    });
  }

  if (suppressedTaskFindings > 0 && suppressedFailedTaskFindings > 0 && taskWindowHours !== null) {
    hints.push({
      id: "suppressed-failed-backlog",
      kind: "suppressed_failed_backlog",
      reason: "Inspect older failed tasks hidden by the current doctor window before canceling them in bulk.",
      command: `${CLI_BRIEF_PREFIX} sweep-tasks cancel --state failed --older-than-hours ${taskWindowHours} --dry-run --brief`,
      sweep: {
        action: "cancel",
        states: ["failed"],
        older_than_hours: taskWindowHours
      }
    });
  }

  return hints;
}

export function buildDoctorReport(
  health: DoctorHealthSnapshot,
  tasks: TaskStatusSnapshot[],
  options: DoctorOptions = {}
): DoctorReport {
  const includeAllTaskHistory = options.include_all_task_history ?? false;
  const taskWindowHours = options.task_window_hours ?? 6;
  const cutoffTimestamp = includeAllTaskHistory
    ? null
    : (options.now ?? Date.now()) - taskWindowHours * 60 * 60 * 1000;
  const workerFindings = buildWorkerFindings(health);
  const githubFindings = buildGitHubFindings(health.github);
  const integrationFindings = buildIntegrationFindings(health);
  const taskFindingSummary = buildTaskFindings(
    tasks,
    includeAllTaskHistory,
    cutoffTimestamp,
    health.github.review_workflow_supports_review_profile === true
  );
  const taskFindings = taskFindingSummary.findings;
  const findings = [
    ...workerFindings,
    ...githubFindings,
    ...integrationFindings,
    ...taskFindings
  ];
  const blockingFindings = findings.filter((entry) => entry.severity === "error").length;
  const warningFindings = findings.filter((entry) => entry.severity === "warning").length;
  const informationalFindings = findings.filter((entry) => entry.severity === "info").length;
  const enabledWorkers = health.readiness.filter((entry) => entry.feature_enabled).length;
  const actionableFindings = blockingFindings + warningFindings;

  return {
    ok: actionableFindings === 0,
    generated_at: new Date().toISOString(),
    summary: buildSummary(
      enabledWorkers,
      tasks,
      blockingFindings,
      warningFindings,
      informationalFindings,
      workerFindings,
      githubFindings,
      integrationFindings,
      taskFindings
    ),
    task_filter: {
      include_all_task_history: includeAllTaskHistory,
      task_window_hours: includeAllTaskHistory ? null : taskWindowHours,
      cutoff_at: cutoffTimestamp === null ? null : new Date(cutoffTimestamp).toISOString(),
      suppressed_task_findings: taskFindingSummary.suppressedCount
    },
    counts: {
      total_tasks: tasks.length,
      task_states: buildStateCounts(tasks),
      enabled_workers: enabledWorkers,
      workers_needing_attention: workerFindings.length,
      github_findings: githubFindings.length,
      integration_findings: integrationFindings.length,
      tasks_needing_attention: taskFindings.length,
      suppressed_task_findings: taskFindingSummary.suppressedCount,
      blocking_findings: blockingFindings,
      warning_findings: warningFindings,
      informational_findings: informationalFindings
    },
    health,
    attention: {
      workers: workerFindings,
      github: githubFindings,
      integrations: integrationFindings,
      tasks: taskFindings
    },
    actions: dedupe([
      ...workerFindings.flatMap((entry) => entry.actions),
      ...githubFindings.flatMap((entry) => entry.actions),
      ...integrationFindings.flatMap((entry) => entry.actions),
      ...taskFindings.flatMap((entry) => entry.actions)
    ]),
    command_hints: buildCommandHints(
      taskFindings,
      includeAllTaskHistory ? null : taskWindowHours,
      taskFindingSummary.suppressedCount,
      taskFindingSummary.suppressedFailedCount
    )
  };
}
