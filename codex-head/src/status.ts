import type { TaskRecord } from "./contracts";
import { FileArtifactStore } from "./artifacts/fileArtifactStore";

interface QueueDiagnosisArtifact {
  task_id?: string;
  run_id?: number;
  likely_stalled?: boolean;
  reason?: string;
  suggested_action?: string | null;
}

interface QueueRecycleArtifact {
  task_id?: string;
  run_id?: number;
  attempted_at?: string;
  command?: string[];
  executable?: string | null;
  skipped?: boolean;
  detail?: string;
  ok?: boolean;
  exit_code?: number | null;
  stdout?: string;
  stderr?: string;
}

export interface TaskOperatorStatus {
  queue_diagnosis_path: string | null;
  queue_diagnosis: QueueDiagnosisArtifact | null;
  queue_recycle_path: string | null;
  queue_recycle: QueueRecycleArtifact | null;
  latest_receipt_path: string | null;
  latest_receipt_command: string | null;
  latest_receipt_created_at: string | null;
  manual_intervention_required: boolean;
  summary: string | null;
  actions: string[];
}

export interface TaskStatusSnapshot extends TaskRecord {
  operator: TaskOperatorStatus;
}

function hasText(value: string | null | undefined): value is string {
  return Boolean(value && value.trim());
}

function collectTaskTexts(record: TaskRecord, extraTexts: string[] = []): string[] {
  const notes = record.result?.review_notes ?? [];
  return [
    record.last_error,
    record.result?.summary,
    ...notes,
    ...extraTexts
  ].filter(hasText);
}

function buildOperatorActions(
  record: TaskRecord,
  diagnosis: QueueDiagnosisArtifact | null,
  recycle: QueueRecycleArtifact | null,
  artifactStore: FileArtifactStore,
  manualInterventionRequired: boolean,
  extraTexts: string[] = []
): string[] {
  const actions = new Set<string>();
  const taskTexts = collectTaskTexts(record, extraTexts).join("\n");
  const diagnosisReason = diagnosis?.reason ?? "";
  const diagnosisPath = artifactStore.resolveTaskArtifactPath(record.task.task_id, "github-queue-diagnosis.json");
  const recyclePath = artifactStore.resolveTaskArtifactPath(record.task.task_id, "github-queue-recycle.json");

  if (hasText(diagnosis?.suggested_action)) {
    actions.add(diagnosis.suggested_action);
  }

  if (/no self-hosted runner currently matches labels/i.test(diagnosisReason)) {
    actions.add("Check CODEX_HEAD_RUNS_ON_JSON and the self-hosted runner labels so at least one runner matches the workflow.");
  } else if (/offline/i.test(diagnosisReason)) {
    actions.add("Bring one matching self-hosted runner back online or restart the runner listener cleanly.");
  } else if (/all busy/i.test(diagnosisReason)) {
    actions.add("Wait for a runner slot or free one of the matching self-hosted runners.");
  } else if (/stale broker session/i.test(diagnosisReason)) {
    actions.add("Run the self-hosted runner recycle helper or restart the runner cleanly before retrying the GitHub wait path.");
  }

  if (/requires gh authentication|gh auth/i.test(taskTexts)) {
    actions.add("Run gh auth login on the machine that dispatches or reconciles GitHub workflows.");
  }

  if (/github\.repository to be configured|does not have a resolved GitHub workflow run yet/i.test(taskTexts)) {
    actions.add("Set github.repository or dispatch the task again so Codex Head can resolve the workflow run.");
  }

  if (/callback download failed:.*artifact not found/i.test(taskTexts)) {
    actions.add(`Inspect ${diagnosisPath} before retrying GitHub callback download.`);
  }

  if (/quota|usage limit|rate.?limit|too many requests|resource[_\s-]*exhausted|\b429\b/i.test(taskTexts)) {
    actions.add("Wait for the provider reset window or route the task to another healthy worker.");
  }

  if (/Recovered interrupted local task/i.test(taskTexts)) {
    if (record.state === "queued") {
      actions.add("Dispatch the requeued local task when the workspace is ready.");
    } else {
      actions.add("Inspect the interrupted local task state, then rerun it manually if the workspace is still safe.");
    }
  }

  if (manualInterventionRequired && recycle?.ok === true) {
    actions.add(`Inspect ${recyclePath} and the runner _diag logs before retrying this GitHub task.`);
  }

  return [...actions];
}

function summarizeOperatorState(
  diagnosis: QueueDiagnosisArtifact | null,
  recycle: QueueRecycleArtifact | null,
  manualInterventionRequired: boolean
): string | null {
  if (manualInterventionRequired) {
    return "Automatic stale-runner recovery was already attempted and manual intervention is now required.";
  }
  if (recycle?.ok === true) {
    return recycle.detail ?? "Automatic self-hosted runner recycle completed successfully.";
  }
  if (recycle && recycle.ok === false && hasText(recycle.detail)) {
    return `Automatic recycle attempt did not resolve the queue stall: ${recycle.detail}`;
  }
  if (diagnosis?.reason && diagnosis.suggested_action) {
    return `${diagnosis.reason} ${diagnosis.suggested_action}`;
  }
  if (diagnosis?.reason) {
    return diagnosis.reason;
  }
  return null;
}

type OperatorReceiptSnapshot = {
  command?: string;
  created_at?: string;
  selection?: Record<string, unknown>;
  tasks?: Array<{
    task_id?: string;
  }>;
};

function operatorReceiptMatchesTaskId(receipt: OperatorReceiptSnapshot, taskId: string): boolean {
  if ((receipt.tasks ?? []).some((task) => task.task_id === taskId)) {
    return true;
  }

  const selection = receipt.selection ?? {};
  const directTaskId = selection.task_id;
  if (typeof directTaskId === "string" && directTaskId === taskId) {
    return true;
  }

  const taskIds = selection.task_ids;
  return Array.isArray(taskIds) && taskIds.some((value) => value === taskId);
}

function findLatestOperatorReceipt(
  taskId: string,
  artifactStore: FileArtifactStore
): {
  path: string;
  command: string | null;
  created_at: string | null;
} | null {
  for (const receiptPath of artifactStore.listOperatorReceipts()) {
    const receipt = artifactStore.readOperatorReceiptIfExists<OperatorReceiptSnapshot>(receiptPath);
    if (!receipt || !operatorReceiptMatchesTaskId(receipt, taskId)) {
      continue;
    }

    return {
      path: receiptPath,
      command: typeof receipt.command === "string" ? receipt.command : null,
      created_at: typeof receipt.created_at === "string" ? receipt.created_at : null
    };
  }

  return null;
}

export function buildTaskOperatorStatus(
  record: TaskRecord,
  artifactStore: FileArtifactStore,
  extraTexts: string[] = []
): TaskOperatorStatus {
  const queueDiagnosis = artifactStore.readJsonIfExists<QueueDiagnosisArtifact>(
    record.task.task_id,
    "github-queue-diagnosis.json"
  );
  const queueRecycle = artifactStore.readJsonIfExists<QueueRecycleArtifact>(
    record.task.task_id,
    "github-queue-recycle.json"
  );
  const collectedTexts = collectTaskTexts(record, extraTexts);
  const manualInterventionRequired = collectedTexts.some((value) => /manual intervention is now required/i.test(value));
  const latestReceipt = findLatestOperatorReceipt(record.task.task_id, artifactStore);

  return {
    queue_diagnosis_path: queueDiagnosis
      ? artifactStore.resolveTaskArtifactPath(record.task.task_id, "github-queue-diagnosis.json")
      : null,
    queue_diagnosis: queueDiagnosis,
    queue_recycle_path: queueRecycle
      ? artifactStore.resolveTaskArtifactPath(record.task.task_id, "github-queue-recycle.json")
      : null,
    queue_recycle: queueRecycle,
    latest_receipt_path: latestReceipt?.path ?? null,
    latest_receipt_command: latestReceipt?.command ?? null,
    latest_receipt_created_at: latestReceipt?.created_at ?? null,
    manual_intervention_required: manualInterventionRequired,
    summary: summarizeOperatorState(queueDiagnosis, queueRecycle, manualInterventionRequired),
    actions: buildOperatorActions(
      record,
      queueDiagnosis,
      queueRecycle,
      artifactStore,
      manualInterventionRequired,
      extraTexts
    )
  };
}

export function buildTaskStatusSnapshot(
  record: TaskRecord,
  artifactStore: FileArtifactStore
): TaskStatusSnapshot {
  return {
    ...record,
    operator: buildTaskOperatorStatus(record, artifactStore)
  };
}

export function buildTaskStatusSnapshots(
  records: TaskRecord[],
  artifactStore: FileArtifactStore
): TaskStatusSnapshot[] {
  return records.map((record) => buildTaskStatusSnapshot(record, artifactStore));
}
