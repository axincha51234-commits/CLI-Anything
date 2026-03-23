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
  manual_intervention_required: boolean;
  summary: string | null;
}

export interface TaskStatusSnapshot extends TaskRecord {
  operator: TaskOperatorStatus;
}

function hasText(value: string | null | undefined): value is string {
  return Boolean(value && value.trim());
}

function collectTaskTexts(record: TaskRecord): string[] {
  const notes = record.result?.review_notes ?? [];
  return [
    record.last_error,
    record.result?.summary,
    ...notes
  ].filter(hasText);
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

export function buildTaskStatusSnapshot(
  record: TaskRecord,
  artifactStore: FileArtifactStore
): TaskStatusSnapshot {
  const queueDiagnosis = artifactStore.readJsonIfExists<QueueDiagnosisArtifact>(
    record.task.task_id,
    "github-queue-diagnosis.json"
  );
  const queueRecycle = artifactStore.readJsonIfExists<QueueRecycleArtifact>(
    record.task.task_id,
    "github-queue-recycle.json"
  );
  const collectedTexts = collectTaskTexts(record);
  const manualInterventionRequired = collectedTexts.some((value) => /manual intervention is now required/i.test(value));

  return {
    ...record,
    operator: {
      queue_diagnosis_path: queueDiagnosis
        ? artifactStore.resolveTaskArtifactPath(record.task.task_id, "github-queue-diagnosis.json")
        : null,
      queue_diagnosis: queueDiagnosis,
      queue_recycle_path: queueRecycle
        ? artifactStore.resolveTaskArtifactPath(record.task.task_id, "github-queue-recycle.json")
        : null,
      queue_recycle: queueRecycle,
      manual_intervention_required: manualInterventionRequired,
      summary: summarizeOperatorState(queueDiagnosis, queueRecycle, manualInterventionRequired)
    }
  };
}

export function buildTaskStatusSnapshots(
  records: TaskRecord[],
  artifactStore: FileArtifactStore
): TaskStatusSnapshot[] {
  return records.map((record) => buildTaskStatusSnapshot(record, artifactStore));
}
