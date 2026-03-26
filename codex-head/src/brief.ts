import type { DispatchOutcome } from "./contracts";
import type { DoctorReport } from "./doctor";
import type {
  OperatorReceiptResult,
  OperatorHistoryResult,
  RunDoctorHintResult,
  RunDoctorHintsResult,
  SweepTasksResult
} from "./orchestrator";
import type { TaskOperatorStatus, TaskStatusSnapshot } from "./status";

export interface ReviewWorkflowStatusBrief {
  repository: string;
  workflow: string | null;
  local_workflow_path: string | null;
  git_branch: string | null;
  git_tracking_status: string | null;
  local_git_file_status: string | null;
  local_vs_origin_status: string | null;
  local_supports_review_profile: boolean | null;
  local_declared_inputs: string[];
  remote_supports_review_profile: boolean | null;
  remote_declared_inputs: string[];
  missing_on_remote: string[];
  remote_check_detail: string | null;
  inspect_command: string | null;
  sync_action: string | null;
  sync_commands: string[];
}

type ReconcileOrRecoveryEntry = {
  task_id: string;
  status: string;
  detail: string;
  outcome: DispatchOutcome | null;
  operator: TaskOperatorStatus | null;
};

const CLI_BRIEF_PREFIX = "node --disable-warning=ExperimentalWarning dist/src/index.js";

function compactText(value: string, maxLength = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function pushLimitedSection(
  lines: string[],
  heading: string,
  values: string[],
  maxItems: number
): void {
  if (values.length === 0) {
    return;
  }

  lines.push(heading);
  for (const value of values.slice(0, maxItems)) {
    lines.push(value);
  }
  if (values.length > maxItems) {
    lines.push(`- ... ${values.length - maxItems} more`);
  }
}

function buildShowOperatorReceiptCommand(receiptPath: string): string {
  return `${CLI_BRIEF_PREFIX} show-operator-receipt ${receiptPath} --brief`;
}

function buildStatusCommand(taskId: string): string {
  return `${CLI_BRIEF_PREFIX} status ${taskId} --brief`;
}

function buildDoctorCommand(): string {
  return `${CLI_BRIEF_PREFIX} doctor --brief`;
}

function buildInspectWorkflowCommand(workflow: string): string {
  return `${CLI_BRIEF_PREFIX} review-workflow-status --brief`;
}

function renderLocalStackSummary(report: DoctorReport): string | null {
  const stack = report.health.local_stack;
  if (!stack.detected) {
    return null;
  }

  const parts = [
    stack.recommended_review_path_ready ? "review-ready" : "review-path-incomplete",
    `9router=${stack.router9.reachable ? "up" : "down"}`,
    `agm-chat=${stack.router9.agm_chat.present && stack.router9.agm_chat.active_connection === true ? "ready" : "missing"}`,
    `antigravity=${stack.antigravity.reachable ? "up" : "down"}`
  ];

  if (stack.perplexity) {
    parts.push(`pplx-manager=${stack.perplexity.manager_reachable ? "up" : "down"}`);
    parts.push(
      `pplxapp-chat=${stack.perplexity.pplxapp_chat.present && stack.perplexity.pplxapp_chat.active_connection === true ? "ready" : "missing"}`
    );
  }

  if (stack.blackbox) {
    parts.push(`bbx-manager=${stack.blackbox.manager_reachable ? "up" : "down"}`);
    parts.push(
      `bbxapp-chat=${stack.blackbox.bbxapp_chat.present && stack.blackbox.bbxapp_chat.active_connection === true ? "ready" : "missing"}`
    );
  }

  if (typeof stack.antigravity.active_accounts === "number") {
    parts.push(`accounts=${stack.antigravity.active_accounts}`);
  }

  return parts.join(" :: ");
}

function extractReceiptTaskIds(selection: Record<string, unknown>): string[] {
  const candidate = (selection as { task_ids?: unknown }).task_ids;
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function shouldRenderDoctorArtifactFiles(finding: DoctorReport["attention"]["tasks"][number]): boolean {
  return finding.severity === "error"
    || finding.review_dispatch_degraded
    || finding.manual_intervention_required
    || finding.state === "failed"
    || finding.has_operator_actions;
}

function shouldRenderDoctorTaskLink(finding: DoctorReport["attention"]["tasks"][number]): boolean {
  return shouldRenderDoctorArtifactFiles(finding)
    || Boolean(finding.operator_receipt_path)
    || Boolean(finding.github_run_url);
}

function isRoutineDoctorTaskFinding(finding: DoctorReport["attention"]["tasks"][number]): boolean {
  return !shouldRenderDoctorArtifactFiles(finding)
    && !finding.operator_receipt_path
    && !finding.github_run_url
    && !finding.manual_intervention_required
    && (finding.state === "queued" || finding.state === "running" || finding.state === "awaiting_review")
    && (finding.severity === "warning" || finding.severity === "info");
}

function renderDoctorTaskLine(finding: DoctorReport["attention"]["tasks"][number]): string {
  const profileSuffix = finding.review_profile ? ` :: profile=${finding.review_profile}` : "";
  const dispatchSuffix = finding.review_dispatch_degraded ? " :: dispatch=legacy-standard" : "";
  const receiptSuffix = finding.operator_receipt_path
    ? ` :: receipt=${finding.operator_receipt_path}${finding.operator_receipt_command ? ` [${finding.operator_receipt_command}]` : ""}`
    : "";
  return `- ${finding.task_id} [${finding.state}/${finding.severity}] ${compactText(finding.goal, 90)}${profileSuffix}${dispatchSuffix} :: ${compactText(finding.summary, 180)}${receiptSuffix}`;
}

function filterDoctorNextActions(report: DoctorReport): string[] {
  const queuedHintPresent = report.command_hints.some((hint) => hint.kind === "queued_backlog");
  return report.actions.filter((action) => {
    if (!queuedHintPresent) {
      return true;
    }
    return action !== "Dispatch the queued task when the workspace and workers are ready.";
  });
}

type DoctorRoutineTaskGroupInfo = {
  count: number;
  state: string;
  severity: string;
  goal: string;
};

function summarizeDoctorTaskLines(findings: DoctorReport["attention"]["tasks"]): {
  lines: string[];
  groupedTaskInfo: Map<string, DoctorRoutineTaskGroupInfo>;
} {
  const routineGroups = new Map<string, DoctorReport["attention"]["tasks"]>();
  const lines: string[] = [];
  const groupedTaskInfo = new Map<string, DoctorRoutineTaskGroupInfo>();

  for (const finding of findings) {
    if (!isRoutineDoctorTaskFinding(finding)) {
      lines.push(renderDoctorTaskLine(finding));
      continue;
    }

    const groupKey = [
      finding.state,
      finding.severity,
      finding.goal,
      finding.summary
    ].join("::");
    const group = routineGroups.get(groupKey) ?? [];
    group.push(finding);
    routineGroups.set(groupKey, group);
  }

  for (const group of routineGroups.values()) {
    if (group.length === 1) {
      lines.push(renderDoctorTaskLine(group[0]!));
      continue;
    }

    const first = group[0]!;
    const groupInfo = {
      count: group.length,
      state: first.state,
      severity: first.severity,
      goal: first.goal
    };
    for (const entry of group) {
      groupedTaskInfo.set(entry.task_id, groupInfo);
    }
    const examples = group.slice(0, 3).map((entry) => entry.task_id).join(", ");
    const moreCount = group.length - Math.min(group.length, 3);
    const exampleSuffix = moreCount > 0
      ? `${examples}, +${moreCount} more`
      : examples;
    lines.push(
      `- ${groupInfo.count} similar task(s) [${groupInfo.state}/${groupInfo.severity}] ${compactText(groupInfo.goal, 90)}`
      + ` :: ${compactText(first.summary, 180)} :: examples=${exampleSuffix}`
    );
  }

  return {
    lines,
    groupedTaskInfo
  };
}

function renderArtifactRefLines(refs: {
  worker_result: { path: string; freshness: string } | null;
  execution_attempts: { path: string; freshness: string } | null;
  dispatch_receipt: { path: string; freshness: string } | null;
  primary_output: { path: string; freshness: string } | null;
  primary_log: { path: string; freshness: string } | null;
}): string[] {
  const lines: string[] = [];

  const formatLabel = (label: string, freshness: string): string => {
    if (freshness === "current") {
      return label;
    }
    return `${label} (${freshness.replace(/_/g, "-")})`;
  };

  if (refs.worker_result) {
    lines.push(`${formatLabel("worker-result", refs.worker_result.freshness)}: ${refs.worker_result.path}`);
  }
  if (refs.execution_attempts) {
    lines.push(`${formatLabel("attempts", refs.execution_attempts.freshness)}: ${refs.execution_attempts.path}`);
  }
  if (refs.dispatch_receipt) {
    lines.push(`${formatLabel("dispatch-receipt", refs.dispatch_receipt.freshness)}: ${refs.dispatch_receipt.path}`);
  }
  if (refs.primary_output) {
    lines.push(`${formatLabel("output", refs.primary_output.freshness)}: ${refs.primary_output.path}`);
  }
  if (refs.primary_log) {
    lines.push(`${formatLabel("log", refs.primary_log.freshness)}: ${refs.primary_log.path}`);
  }

  return lines;
}

function renderOperatorLines(operator: TaskOperatorStatus | null): string[] {
  if (!operator) {
    return [];
  }

  const lines: string[] = [];
  if (operator.summary) {
    lines.push(`operator: ${compactText(operator.summary)}`);
  } else if (operator.actions.length === 0 && !operator.latest_receipt_path) {
    lines.push("operator: no immediate action");
  }

  if (operator.latest_receipt_path) {
    const receiptLabel = operator.latest_receipt_command
      ? `${operator.latest_receipt_path} [${operator.latest_receipt_command}]`
      : operator.latest_receipt_path;
    lines.push(`receipt: ${receiptLabel}`);
    lines.push(`next-command: ${buildShowOperatorReceiptCommand(operator.latest_receipt_path)}`);
  }

  if (operator.actions.length > 0) {
    lines.push(`next: ${operator.actions.map((value) => compactText(value, 160)).join(" | ")}`);
  }

  return lines;
}

function renderStatusBlock(snapshot: TaskStatusSnapshot): string {
  const lines = [
    `task ${snapshot.task.task_id} [${snapshot.state}] ${snapshot.task.goal}`,
    `worker: ${snapshot.task.worker_target}${snapshot.routing ? ` via ${snapshot.routing.mode}` : ""}${snapshot.task.review_profile ? ` :: profile=${snapshot.task.review_profile}` : ""}`,
    `artifacts: ${snapshot.artifact_dir_path}`
  ];

  if (snapshot.github_run) {
    const conclusion = snapshot.github_run.conclusion ? `/${snapshot.github_run.conclusion}` : "";
    lines.push(`github: ${snapshot.github_run.status}${conclusion}`);
    if (snapshot.github_run.run_url) {
      lines.push(`github-url: ${snapshot.github_run.run_url}`);
    }
  }

  if (snapshot.review_dispatch?.degraded) {
    lines.push(
      `dispatch: requested profile=${snapshot.review_dispatch.requested_profile ?? "unknown"} -> legacy standard routing`
    );
  }

  return [
    ...lines,
    ...renderArtifactRefLines(snapshot.artifact_refs),
    ...renderOperatorLines(snapshot.operator)
  ].join("\n");
}

function renderOutcomeBlock(entry: ReconcileOrRecoveryEntry): string {
  const lines = [
    `task ${entry.task_id} [${entry.status}]`,
    `detail: ${compactText(entry.detail)}`
  ];

  if (entry.outcome) {
    lines.push(
      `outcome: ${entry.outcome.state} via ${entry.outcome.routing.worker_target}/${entry.outcome.routing.mode}`
    );
  }

  return [
    ...lines,
    ...renderOperatorLines(entry.operator)
  ].join("\n");
}

export function renderStatusBrief(value: TaskStatusSnapshot | TaskStatusSnapshot[]): string {
  const snapshots = Array.isArray(value) ? value : [value];
  if (snapshots.length === 0) {
    return "No tasks.";
  }
  return snapshots.map((snapshot) => renderStatusBlock(snapshot)).join("\n\n");
}

export function renderOutcomeBrief(
  value: ReconcileOrRecoveryEntry | ReconcileOrRecoveryEntry[],
  emptyMessage: string
): string {
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 0) {
    return emptyMessage;
  }
  return entries.map((entry) => renderOutcomeBlock(entry)).join("\n\n");
}

export function renderDoctorBrief(report: DoctorReport): string {
  const lines = [
    `doctor: ${report.ok ? "healthy" : "needs attention"}`,
    `summary: ${compactText(report.summary)}`
  ];
  const visibleTaskFindings = report.attention.tasks.slice(0, 8);
  const taskSummary = summarizeDoctorTaskLines(visibleTaskFindings);
  const nextActions = filterDoctorNextActions(report);
  const reviewWorkflowDriftPresent = report.health.github.review_workflow_supports_review_profile === false
    && typeof report.health.github.review_workflow === "string"
    && report.health.github.review_workflow.trim().length > 0;
  const nextCommand = report.ok
    ? null
    : reviewWorkflowDriftPresent
      ? buildInspectWorkflowCommand(report.health.github.review_workflow!)
      : report.command_hints[0]?.command
      ?? (() => {
        const receiptPath = visibleTaskFindings.find((finding) => finding.operator_receipt_path)?.operator_receipt_path ?? null;
        return receiptPath ? buildShowOperatorReceiptCommand(receiptPath) : null;
      })();

  if (report.task_filter.suppressed_task_findings > 0) {
    const windowLabel = report.task_filter.task_window_hours === null
      ? "current filter"
      : `${report.task_filter.task_window_hours}h window`;
    lines.push(`history: hidden ${report.task_filter.suppressed_task_findings} older task finding(s) outside the ${windowLabel}`);
  }

  const localStackSummary = renderLocalStackSummary(report);
  if (localStackSummary) {
    lines.push(`local-stack: ${localStackSummary}`);
  }

  pushLimitedSection(
    lines,
    "workers:",
    report.attention.workers.map((finding) => `- ${finding.worker_target} [${finding.severity}] ${compactText(finding.summary, 180)}`),
    5
  );
  pushLimitedSection(
    lines,
    "github:",
    report.attention.github.map((finding) => `- [${finding.severity}] ${compactText(finding.summary, 280)}`),
    5
  );
  pushLimitedSection(
    lines,
    "integrations:",
    report.attention.integrations.map((finding) => `- [${finding.severity}] ${compactText(finding.summary, 180)}`),
    5
  );
  pushLimitedSection(
    lines,
    "tasks:",
    taskSummary.lines,
    8
  );
  pushLimitedSection(
    lines,
    "receipt-commands:",
    visibleTaskFindings
      .filter((finding) => Boolean(finding.operator_receipt_path))
      .map((finding) => `- ${finding.task_id} :: ${buildShowOperatorReceiptCommand(finding.operator_receipt_path!)}`),
    8
  );
  if (nextCommand) {
    lines.push(`next-command: ${nextCommand}`);
  }
  pushLimitedSection(
    lines,
    "task-links:",
    visibleTaskFindings
      .filter((finding) => shouldRenderDoctorTaskLink(finding))
      .map((finding) => {
      const segments = [`- ${finding.task_id} :: artifacts=${finding.artifact_dir_path}`];
      if (finding.github_run_url) {
        segments.push(`github=${finding.github_run_url}`);
      }
      return segments.join(" :: ");
    }),
    8
  );
  pushLimitedSection(
    lines,
    "artifact-files:",
    visibleTaskFindings
      .filter((finding) => shouldRenderDoctorArtifactFiles(finding))
      .map((finding) => {
        const segments = [
          finding.artifact_refs.worker_result
            ? `result${finding.artifact_refs.worker_result.freshness === "current" ? "" : `(${finding.artifact_refs.worker_result.freshness.replace(/_/g, "-")})`}=${finding.artifact_refs.worker_result.path}`
            : null,
          finding.artifact_refs.execution_attempts
            ? `attempts${finding.artifact_refs.execution_attempts.freshness === "current" ? "" : `(${finding.artifact_refs.execution_attempts.freshness.replace(/_/g, "-")})`}=${finding.artifact_refs.execution_attempts.path}`
            : null,
          finding.artifact_refs.dispatch_receipt
            ? `dispatch-receipt${finding.artifact_refs.dispatch_receipt.freshness === "current" ? "" : `(${finding.artifact_refs.dispatch_receipt.freshness.replace(/_/g, "-")})`}=${finding.artifact_refs.dispatch_receipt.path}`
            : null,
          finding.artifact_refs.primary_output
            ? `output${finding.artifact_refs.primary_output.freshness === "current" ? "" : `(${finding.artifact_refs.primary_output.freshness.replace(/_/g, "-")})`}=${finding.artifact_refs.primary_output.path}`
            : null,
          finding.artifact_refs.primary_log
            ? `log${finding.artifact_refs.primary_log.freshness === "current" ? "" : `(${finding.artifact_refs.primary_log.freshness.replace(/_/g, "-")})`}=${finding.artifact_refs.primary_log.path}`
            : null
        ].filter((value): value is string => Boolean(value));

        if (segments.length === 0) {
          return null;
        }

        return `- ${finding.task_id} :: ${segments.join(" :: ")}`;
      })
      .filter((value): value is string => Boolean(value)),
    8
  );
  pushLimitedSection(
    lines,
    "next:",
    nextActions.map((action) => `- ${compactText(action, 180)}`),
    8
  );
  if (!report.ok) {
    pushLimitedSection(
      lines,
      "commands:",
      report.command_hints.map((hint) => {
        const hintedTaskId = hint.sweep.task_ids?.[0] ?? null;
        const groupedTask = hintedTaskId ? taskSummary.groupedTaskInfo.get(hintedTaskId) : null;
        const groupSuffix = groupedTask
          ? ` :: representative of ${groupedTask.count} similar ${groupedTask.state}/${groupedTask.severity} task(s)`
          : "";
        return `- [${hint.id}] ${hint.command}${groupSuffix}`;
      }),
      6
    );
  }

  return lines.join("\n");
}

export function renderReviewWorkflowStatusBrief(status: ReviewWorkflowStatusBrief): string {
  const lines = [
    `review-workflow: ${status.workflow ?? "not configured"}`,
    `repository: ${status.repository}`
  ];

  if (status.local_workflow_path) {
    lines.push(
      `local: ${status.local_supports_review_profile ? "supports review_profile" : "missing review_profile"} :: ${status.local_workflow_path}`
    );
  } else {
    lines.push("local: workflow file not found");
  }
  if (status.git_branch) {
    lines.push(`git-branch: ${status.git_branch}`);
  }
  if (status.git_tracking_status) {
    lines.push(`git-tracking: ${status.git_tracking_status}`);
  }
  if (status.local_git_file_status) {
    lines.push(`git-file-status: ${status.local_git_file_status}`);
  }
  if (status.local_vs_origin_status) {
    lines.push(`git-origin-status: ${status.local_vs_origin_status}`);
  }
  if (status.local_declared_inputs.length > 0) {
    lines.push(`local-inputs: ${compactText(status.local_declared_inputs.join(", "), 240)}`);
  }

  if (status.remote_supports_review_profile === true) {
    lines.push("remote: supports review_profile");
  } else if (status.remote_supports_review_profile === false) {
    lines.push("remote: legacy workflow without review_profile");
  } else {
    lines.push("remote: support for review_profile is unknown");
  }
  if (status.remote_declared_inputs.length > 0) {
    lines.push(`remote-inputs: ${compactText(status.remote_declared_inputs.join(", "), 240)}`);
  }
  if (status.missing_on_remote.length > 0) {
    lines.push(`missing-on-remote: ${status.missing_on_remote.join(", ")}`);
  }

  if (status.remote_check_detail) {
    lines.push(`detail: ${compactText(status.remote_check_detail)}`);
  }
  if (status.inspect_command) {
    lines.push(`inspect-command: ${status.inspect_command}`);
  }
  if (status.sync_action) {
    lines.push(`next: ${compactText(status.sync_action)}`);
  }
  pushLimitedSection(lines, "sync-commands:", status.sync_commands.map((command) => `- ${command}`), 6);

  return lines.join("\n");
}

export function renderSweepBrief(result: SweepTasksResult): string {
  const lines = [
    `sweep: ${result.action}${result.dry_run ? " (dry-run)" : ""}`,
    `summary: matched ${result.matched}, actionable ${result.changed}`
  ];

  const taskLines = result.tasks.map((entry) => {
    const marker = entry.changed ? `${entry.previous_state} -> ${entry.next_state}` : `${entry.previous_state} (skipped)`;
    return `- ${entry.task_id} [${marker}] ${compactText(entry.goal, 100)} :: ${compactText(entry.reason, 140)}`;
  });
  pushLimitedSection(lines, "tasks:", taskLines, 8);
  if (result.receipt_path) {
    lines.push(`receipt: ${result.receipt_path}`);
  }

  return lines.join("\n");
}

export function renderRunDoctorHintBrief(result: RunDoctorHintResult): string {
  return [
    `hint: ${result.hint.id} [${result.hint.kind}] ${result.hint.reason}`,
    renderSweepBrief(result.result)
  ].join("\n");
}

export function renderRunDoctorHintsBrief(result: RunDoctorHintsResult): string {
  const lines = [
    `doctor-hints: ${result.results.length} selected${result.apply ? "" : " (dry-run)"}`,
    `summary: matched ${result.total_matched}, actionable ${result.total_actionable}`,
    `confirm-token: ${result.confirm_token}`
  ];

  if (result.kind) {
    lines.push(`kind: ${result.kind}`);
  }
  if (result.limit !== null) {
    lines.push(`limit: ${result.limit}`);
  }
  if (!result.apply && result.total_actionable > 1) {
    lines.push(
      `next: rerun with --apply --allow-multi-task-apply --confirm-token ${result.confirm_token} `
      + "only if this preview still matches intent."
    );
  } else if (!result.apply) {
    lines.push(`next: rerun with --apply --confirm-token ${result.confirm_token} if this preview still matches intent.`);
  } else if (result.apply && result.total_actionable > 1 && result.allow_multi_task_apply) {
    lines.push(`guard: applied with confirm-token ${result.confirm_token} and explicit multi-task approval.`);
  } else if (result.apply) {
    lines.push(`guard: applied with confirm-token ${result.confirm_token}.`);
  }

  pushLimitedSection(
    lines,
    "hints:",
    result.results.map((entry) => (
      `- ${entry.hint.id} [${entry.hint.kind}] ${compactText(entry.hint.reason, 120)} :: `
      + `matched ${entry.result.matched}, actionable ${entry.result.changed}`
    )),
    8
  );
  if (result.receipt_path) {
    lines.push(`receipt: ${result.receipt_path}`);
  }

  return lines.join("\n");
}

export function renderOperatorHistoryBrief(result: OperatorHistoryResult): string {
  const lines = [
    `operator-history: ${result.returned} receipt(s)`,
    `scanned: ${result.scanned}`
  ];

  if (result.filters.command) {
    lines.push(`command: ${result.filters.command}`);
  }
  if (result.filters.apply_only) {
    lines.push("mode: apply-only");
  } else if (result.filters.dry_run_only) {
    lines.push("mode: dry-run-only");
  }
  lines.push(`limit: ${result.filters.limit}`);
  if (result.receipts[0]) {
    lines.push(`next-command: ${buildShowOperatorReceiptCommand(result.receipts[0].receipt_path)}`);
  }

  pushLimitedSection(
    lines,
    "receipts:",
    result.receipts.map((entry) => {
      const mode = entry.receipt.apply ? "apply" : "dry-run";
      return `- ${entry.receipt.created_at} ${entry.receipt.command} ${mode} `
        + `matched=${entry.receipt.summary.matched} actionable=${entry.receipt.summary.actionable} `
        + `changed=${entry.receipt.summary.changed} receipt=${entry.receipt_path}`;
    }),
    10
  );

  return lines.join("\n");
}

export function renderOperatorReceiptBrief(result: OperatorReceiptResult): string {
  const lines = [
    `receipt: ${result.receipt_path}`,
    `created: ${result.receipt.created_at}`,
    `command: ${result.receipt.command}`,
    `mode: ${result.receipt.apply ? "apply" : "dry-run"}`,
    `summary: matched ${result.receipt.summary.matched}, actionable ${result.receipt.summary.actionable}, changed ${result.receipt.summary.changed}`
  ];

  if (result.lookup.mode === "latest") {
    lines.push("lookup: latest receipt");
  } else if (result.lookup.mode === "task_id") {
    lines.push(`lookup: latest receipt for task ${result.lookup.task_id}`);
  }

  const lookupFilters: string[] = [];
  if (result.lookup.filters.command) {
    lookupFilters.push(`command=${result.lookup.filters.command}`);
  }
  if (result.lookup.filters.apply_only) {
    lookupFilters.push("mode=apply-only");
  } else if (result.lookup.filters.dry_run_only) {
    lookupFilters.push("mode=dry-run-only");
  }
  if (lookupFilters.length > 0) {
    lines.push(`lookup-filters: ${lookupFilters.join(", ")}`);
  }
  const receiptTasks = result.receipt.tasks ?? [];
  const selectedTaskIds = extractReceiptTaskIds(result.receipt.selection);
  const nextTaskId = result.lookup.mode === "task_id"
    ? result.lookup.task_id
    : receiptTasks.length === 1
      ? receiptTasks[0]!.task_id
      : selectedTaskIds.length === 1
        ? selectedTaskIds[0]!
        : null;
  if (nextTaskId) {
    lines.push(`next-command: ${buildStatusCommand(nextTaskId)}`);
  } else if (receiptTasks.length > 1 || selectedTaskIds.length > 1) {
    lines.push(`next-command: ${buildDoctorCommand()}`);
  }

  const selectionEntries = Object.entries(result.receipt.selection)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`);
  pushLimitedSection(lines, "selection:", selectionEntries.map((entry) => `- ${entry}`), 8);

  pushLimitedSection(
    lines,
    "hints:",
    (result.receipt.hints ?? []).map((hint) => (
      `- ${hint.id} [${hint.kind}] ${compactText(hint.reason, 120)} :: `
      + `matched ${hint.matched}, actionable ${hint.actionable}, changed ${hint.changed}`
    )),
    8
  );

  pushLimitedSection(
    lines,
    "tasks:",
    (result.receipt.tasks ?? []).map((task) => {
      const marker = task.changed ? `${task.previous_state} -> ${task.next_state}` : `${task.previous_state} (skipped)`;
      return `- ${task.task_id} [${marker}] ${compactText(task.goal, 100)} :: ${compactText(task.reason, 140)}`;
    }),
    8
  );

  return lines.join("\n");
}
