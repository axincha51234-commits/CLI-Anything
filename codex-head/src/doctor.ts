import type { AdapterHealth, AdapterRuntimeReadiness, TaskState, WorkerTarget } from "./contracts";
import type { GitHubRuntimeStatus } from "./github/controlPlane";
import type { TaskStatusSnapshot } from "./status";

export type DoctorFindingSeverity = "error" | "warning" | "info";

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

export interface DoctorTaskFinding {
  task_id: string;
  state: TaskState;
  goal: string;
  worker_target: WorkerTarget;
  routing_mode: "local" | "github" | null;
  severity: DoctorFindingSeverity;
  summary: string;
  actions: string[];
  manual_intervention_required: boolean;
}

export interface DoctorReport {
  ok: boolean;
  generated_at: string;
  summary: string;
  counts: {
    total_tasks: number;
    task_states: Partial<Record<TaskState, number>>;
    enabled_workers: number;
    workers_needing_attention: number;
    github_findings: number;
    tasks_needing_attention: number;
    blocking_findings: number;
    informational_findings: number;
  };
  health: DoctorHealthSnapshot;
  attention: {
    workers: DoctorWorkerFinding[];
    github: DoctorGitHubFinding[];
    tasks: DoctorTaskFinding[];
  };
  actions: string[];
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

function deriveTaskSummary(task: TaskStatusSnapshot): string {
  if (task.operator.summary) {
    return task.operator.summary;
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

function deriveTaskActions(task: TaskStatusSnapshot): string[] {
  const actions = new Set(task.operator.actions);

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

function summarizeTaskFinding(task: TaskStatusSnapshot): DoctorTaskFinding | null {
  const activeState = task.state === "running" || task.state === "queued" || task.state === "awaiting_review";
  const needsAttention = task.operator.manual_intervention_required
    || task.operator.actions.length > 0
    || task.state === "failed"
    || activeState;

  if (!needsAttention) {
    return null;
  }

  let severity: DoctorFindingSeverity = "info";
  if (task.operator.manual_intervention_required || task.state === "failed") {
    severity = "error";
  } else if (task.operator.actions.length > 0 || task.state === "queued" || task.state === "awaiting_review") {
    severity = "warning";
  }

  return {
    task_id: task.task.task_id,
    state: task.state,
    goal: task.task.goal,
    worker_target: task.task.worker_target,
    routing_mode: task.routing?.mode ?? null,
    severity,
    summary: deriveTaskSummary(task),
    actions: deriveTaskActions(task),
    manual_intervention_required: task.operator.manual_intervention_required
  };
}

function buildTaskFindings(tasks: TaskStatusSnapshot[]): DoctorTaskFinding[] {
  return tasks
    .map((task) => summarizeTaskFinding(task))
    .filter((entry): entry is DoctorTaskFinding => Boolean(entry))
    .sort((left, right) => {
      const severityDelta = severityRank(left.severity) - severityRank(right.severity);
      if (severityDelta !== 0) {
        return severityDelta;
      }
      return left.task_id.localeCompare(right.task_id);
    });
}

function buildSummary(
  enabledWorkers: number,
  tasks: TaskStatusSnapshot[],
  blockingFindings: number,
  informationalFindings: number,
  workerFindings: DoctorWorkerFinding[],
  githubFindings: DoctorGitHubFinding[],
  taskFindings: DoctorTaskFinding[]
): string {
  if (blockingFindings === 0 && informationalFindings === 0) {
    return `No blocking issues found across ${tasks.length} task(s) and ${enabledWorkers} enabled worker(s).`;
  }

  if (blockingFindings === 0) {
    return `No blocking issues found, but ${informationalFindings} active item(s) still deserve monitoring.`;
  }

  const blockingTaskFindings = taskFindings.filter((entry) => entry.severity !== "info").length;
  const segments = [
    workerFindings.length > 0 ? pluralize(workerFindings.length, "worker finding") : "",
    githubFindings.length > 0 ? pluralize(githubFindings.length, "GitHub finding") : "",
    blockingTaskFindings > 0 ? pluralize(blockingTaskFindings, "task finding") : ""
  ].filter(Boolean);

  const joinedSegments = segments.length > 0 ? segments.join(", ") : "runtime";
  return `Found ${pluralize(blockingFindings, "blocking item")} across ${joinedSegments}.`;
}

export function buildDoctorReport(
  health: DoctorHealthSnapshot,
  tasks: TaskStatusSnapshot[]
): DoctorReport {
  const workerFindings = buildWorkerFindings(health);
  const githubFindings = buildGitHubFindings(health.github);
  const taskFindings = buildTaskFindings(tasks);
  const findings = [
    ...workerFindings,
    ...githubFindings,
    ...taskFindings
  ];
  const blockingFindings = findings.filter((entry) => entry.severity !== "info").length;
  const informationalFindings = findings.length - blockingFindings;
  const enabledWorkers = health.readiness.filter((entry) => entry.feature_enabled).length;

  return {
    ok: blockingFindings === 0,
    generated_at: new Date().toISOString(),
    summary: buildSummary(
      enabledWorkers,
      tasks,
      blockingFindings,
      informationalFindings,
      workerFindings,
      githubFindings,
      taskFindings
    ),
    counts: {
      total_tasks: tasks.length,
      task_states: buildStateCounts(tasks),
      enabled_workers: enabledWorkers,
      workers_needing_attention: workerFindings.length,
      github_findings: githubFindings.length,
      tasks_needing_attention: taskFindings.length,
      blocking_findings: blockingFindings,
      informational_findings: informationalFindings
    },
    health,
    attention: {
      workers: workerFindings,
      github: githubFindings,
      tasks: taskFindings
    },
    actions: dedupe([
      ...workerFindings.flatMap((entry) => entry.actions),
      ...githubFindings.flatMap((entry) => entry.actions),
      ...taskFindings.flatMap((entry) => entry.actions)
    ])
  };
}
