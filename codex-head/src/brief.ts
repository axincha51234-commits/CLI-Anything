import type { DispatchOutcome } from "./contracts";
import type { TaskOperatorStatus, TaskStatusSnapshot } from "./status";

type ReconcileOrRecoveryEntry = {
  task_id: string;
  status: string;
  detail: string;
  outcome: DispatchOutcome | null;
  operator: TaskOperatorStatus | null;
};

function compactText(value: string, maxLength = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function renderOperatorLines(operator: TaskOperatorStatus | null): string[] {
  if (!operator) {
    return [];
  }

  const lines: string[] = [];
  if (operator.summary) {
    lines.push(`operator: ${compactText(operator.summary)}`);
  } else if (operator.actions.length === 0) {
    lines.push("operator: no immediate action");
  }

  if (operator.actions.length > 0) {
    lines.push(`next: ${operator.actions.map((value) => compactText(value, 160)).join(" | ")}`);
  }

  return lines;
}

function renderStatusBlock(snapshot: TaskStatusSnapshot): string {
  const lines = [
    `task ${snapshot.task.task_id} [${snapshot.state}] ${snapshot.task.goal}`,
    `worker: ${snapshot.task.worker_target}${snapshot.routing ? ` via ${snapshot.routing.mode}` : ""}`
  ];

  if (snapshot.github_run) {
    const conclusion = snapshot.github_run.conclusion ? `/${snapshot.github_run.conclusion}` : "";
    lines.push(`github: ${snapshot.github_run.status}${conclusion}`);
  }

  return [
    ...lines,
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
