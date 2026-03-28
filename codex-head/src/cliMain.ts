import { resolve } from "node:path";

import {
  renderDoctorBrief,
  renderOperatorReceiptBrief,
  renderOperatorHistoryBrief,
  renderOutcomeBrief,
  renderReviewWorkflowStatusBrief,
  renderRunDoctorHintBrief,
  renderRunDoctorHintsBrief,
  renderStatusBrief,
  renderSweepBrief
} from "./brief";
import { normalizeGitHubRepository, updateGitHubConfig } from "./config";
import { REVIEW_VERDICTS, TASK_STATES, WORKER_TARGETS } from "./contracts";
import { DOCTOR_COMMAND_HINT_KINDS } from "./doctor";
import { inspectLocalReviewWorkflowDrift } from "./github/reviewWorkflowDrift";
import { executeGitHubPayloadFile } from "./github/workflowRunner";
import { CodexHeadOrchestrator, OPERATOR_RECEIPT_COMMANDS } from "./orchestrator";
import { buildTaskStatusSnapshot, buildTaskStatusSnapshots } from "./status";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printText(value: string): void {
  process.stdout.write(`${value}\n`);
}

const CLI_USAGE_PREFIX = "node --disable-warning=ExperimentalWarning dist/src/index.js";

function stripFlag(args: string[], flag: string): {
  values: string[];
  present: boolean;
} {
  let present = false;
  const values = args.filter((value) => {
    if (value === flag) {
      present = true;
      return false;
    }
    return true;
  });
  return {
    values,
    present
  };
}

function parseRunGoalArgs(args: string[]): {
  goal: string;
  repository?: string;
  baseBranch?: string;
  workBranch?: string;
  dispatchMode?: "artifacts_only" | "gh_cli";
  executionPreference?: "remote_only" | "local_preferred";
  timeoutSec?: number;
  intervalSec?: number;
  publishMirror: boolean;
} {
  const readFlagValue = (flag: string, index: number): string => {
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return next;
  };

  const goalParts: string[] = [];
  let repository: string | undefined;
  let baseBranch: string | undefined;
  let workBranch: string | undefined;
  let dispatchMode: "artifacts_only" | "gh_cli" | undefined;
  let executionPreference: "remote_only" | "local_preferred" | undefined;
  let timeoutSec: number | undefined;
  let intervalSec: number | undefined;
  let publishMirror = true;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--repo") {
      repository = readFlagValue("--repo", index);
      index += 1;
      continue;
    }
    if (current === "--base-branch") {
      baseBranch = readFlagValue("--base-branch", index);
      index += 1;
      continue;
    }
    if (current === "--work-branch") {
      workBranch = readFlagValue("--work-branch", index);
      index += 1;
      continue;
    }
    if (current === "--dispatch-mode") {
      const next = readFlagValue("--dispatch-mode", index);
      if (next !== "artifacts_only" && next !== "gh_cli") {
        throw new Error("--dispatch-mode must be gh_cli or artifacts_only");
      }
      dispatchMode = next;
      index += 1;
      continue;
    }
    if (current === "--execution-preference") {
      const next = readFlagValue("--execution-preference", index);
      if (next !== "remote_only" && next !== "local_preferred") {
        throw new Error("--execution-preference must be remote_only or local_preferred");
      }
      executionPreference = next;
      index += 1;
      continue;
    }
    if (current === "--timeout-sec") {
      timeoutSec = Number(readFlagValue("--timeout-sec", index));
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
        throw new Error("--timeout-sec must be a positive number");
      }
      index += 1;
      continue;
    }
    if (current === "--interval-sec") {
      intervalSec = Number(readFlagValue("--interval-sec", index));
      if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
        throw new Error("--interval-sec must be a positive number");
      }
      index += 1;
      continue;
    }
    if (current === "--no-mirror") {
      publishMirror = false;
      continue;
    }
    if (current.startsWith("--")) {
      throw new Error(
        "run-goal only accepts --repo, --base-branch, --work-branch, --dispatch-mode, --execution-preference, --timeout-sec, --interval-sec, and --no-mirror"
      );
    }
    goalParts.push(current);
  }

  const goal = goalParts.join(" ").trim();
  if (!goal) {
    throw new Error("goal is required");
  }

  return {
    goal,
    repository,
    baseBranch,
    workBranch,
    dispatchMode,
    executionPreference,
    timeoutSec,
    intervalSec,
    publishMirror
  };
}

export { parseRunGoalArgs };

type RunGoalGitHubOverride = {
  repository: string;
  dispatch_mode: "artifacts_only" | "gh_cli";
  execution_preference?: "remote_only" | "local_preferred";
};

export function buildRunGoalGitHubOverride(
  repository: string,
  dispatchMode?: "artifacts_only" | "gh_cli",
  executionPreference?: "remote_only" | "local_preferred",
  defaultDispatchMode: "artifacts_only" | "gh_cli" = "gh_cli"
): RunGoalGitHubOverride {
  return {
    repository,
    dispatch_mode: dispatchMode ?? defaultDispatchMode,
    ...(executionPreference ? { execution_preference: executionPreference } : {})
  };
}

function parseRecoverRunningArgs(args: string[]): {
  timeoutSec?: number;
  intervalSec?: number;
  requeueLocal: boolean;
  brief: boolean;
} {
  let timeoutSec: number | undefined;
  let intervalSec: number | undefined;
  let requeueLocal = false;
  let brief = false;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--requeue-local") {
      requeueLocal = true;
      continue;
    }
    if (current === "--brief") {
      brief = true;
      continue;
    }
    positionals.push(current);
  }

  if (positionals[0]) {
    timeoutSec = Number(positionals[0]);
  }
  if (positionals[1]) {
    intervalSec = Number(positionals[1]);
  }

  return {
    timeoutSec,
    intervalSec,
    requeueLocal,
    brief
  };
}

function parseStatusArgs(args: string[]): {
  taskId?: string;
  brief: boolean;
} {
  const stripped = stripFlag(args, "--brief");
  return {
    taskId: stripped.values[0],
    brief: stripped.present
  };
}

function parseReconcileArgs(args: string[]): {
  timeoutSec?: number;
  intervalSec?: number;
  brief: boolean;
} {
  const stripped = stripFlag(args, "--brief");
  return {
    timeoutSec: stripped.values[0] ? Number(stripped.values[0]) : undefined,
    intervalSec: stripped.values[1] ? Number(stripped.values[1]) : undefined,
    brief: stripped.present
  };
}

function parseDoctorArgs(args: string[]): {
  brief: boolean;
  includeAllTaskHistory: boolean;
  taskWindowHours?: number;
} {
  let brief = false;
  let includeAllTaskHistory = false;
  let taskWindowHours: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--brief") {
      brief = true;
      continue;
    }
    if (current === "--all-tasks") {
      includeAllTaskHistory = true;
      continue;
    }
    if (current === "--task-window-hours") {
      taskWindowHours = Number(args[index + 1]);
      if (!Number.isFinite(taskWindowHours) || taskWindowHours < 0) {
        throw new Error("--task-window-hours must be a non-negative number");
      }
      index += 1;
      continue;
    }
    throw new Error("doctor only accepts --brief, --all-tasks, and --task-window-hours N");
  }
  return {
    brief,
    includeAllTaskHistory,
    taskWindowHours
  };
}

function parseReviewWorkflowStatusArgs(args: string[]): {
  brief: boolean;
} {
  const stripped = stripFlag(args, "--brief");
  if (stripped.values.length > 0) {
    throw new Error("review-workflow-status only accepts --brief");
  }
  return {
    brief: stripped.present
  };
}

function parseSweepArgs(args: string[]): {
  action: "cancel" | "requeue";
  states?: typeof TASK_STATES[number][];
  olderThanHours?: number;
  goalContains?: string;
  workerTarget?: typeof WORKER_TARGETS[number];
  taskIds: string[];
  limit?: number;
  dryRun: boolean;
  brief: boolean;
} {
  const action = args[0];
  if (action !== "cancel" && action !== "requeue") {
    throw new Error("sweep-tasks requires an action: cancel or requeue");
  }

  let states: typeof TASK_STATES[number][] | undefined;
  let olderThanHours: number | undefined;
  let goalContains: string | undefined;
  let workerTarget: typeof WORKER_TARGETS[number] | undefined;
  const taskIds: string[] = [];
  let limit: number | undefined;
  let dryRun = false;
  let brief = false;
  let allowBroad = false;
  let explicitStateFilter = false;

  for (let index = 1; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--state") {
      states = (args[index + 1] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean) as typeof TASK_STATES[number][];
      if (states.some((value) => !TASK_STATES.includes(value))) {
        throw new Error(`--state must only include: ${TASK_STATES.join(", ")}`);
      }
      explicitStateFilter = true;
      index += 1;
      continue;
    }
    if (current === "--older-than-hours") {
      olderThanHours = Number(args[index + 1]);
      if (!Number.isFinite(olderThanHours) || olderThanHours < 0) {
        throw new Error("--older-than-hours must be a non-negative number");
      }
      index += 1;
      continue;
    }
    if (current === "--goal-contains") {
      goalContains = args[index + 1];
      if (!goalContains) {
        throw new Error("--goal-contains requires a value");
      }
      index += 1;
      continue;
    }
    if (current === "--worker-target") {
      const next = args[index + 1];
      if (!next || !WORKER_TARGETS.includes(next as typeof WORKER_TARGETS[number])) {
        throw new Error(`--worker-target must be one of: ${WORKER_TARGETS.join(", ")}`);
      }
      workerTarget = next as typeof WORKER_TARGETS[number];
      index += 1;
      continue;
    }
    if (current === "--task-id") {
      const next = args[index + 1];
      if (!next) {
        throw new Error("--task-id requires a value");
      }
      taskIds.push(next);
      index += 1;
      continue;
    }
    if (current === "--limit") {
      limit = Number(args[index + 1]);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error("--limit must be a positive number");
      }
      index += 1;
      continue;
    }
    if (current === "--all") {
      allowBroad = true;
      continue;
    }
    if (current === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (current === "--brief") {
      brief = true;
      continue;
    }
    throw new Error("sweep-tasks only accepts known filter flags");
  }

  const hasNarrowingFilter = allowBroad
    || explicitStateFilter
    || olderThanHours !== undefined
    || Boolean(goalContains)
    || Boolean(workerTarget)
    || taskIds.length > 0;
  if (!hasNarrowingFilter) {
    throw new Error("sweep-tasks requires a narrowing filter or --all");
  }

  return {
    action,
    states,
    olderThanHours,
    goalContains,
    workerTarget,
    taskIds,
    limit,
    dryRun,
    brief
  };
}

function parseRunDoctorHintArgs(args: string[]): {
  hintId: string;
  apply: boolean;
  brief: boolean;
  includeAllTaskHistory: boolean;
  taskWindowHours?: number;
} {
  const hintId = args[0];
  if (!hintId) {
    throw new Error("run-doctor-hint requires a hint id");
  }

  let apply = false;
  let brief = false;
  let includeAllTaskHistory = false;
  let taskWindowHours: number | undefined;

  for (let index = 1; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--apply") {
      apply = true;
      continue;
    }
    if (current === "--brief") {
      brief = true;
      continue;
    }
    if (current === "--all-tasks") {
      includeAllTaskHistory = true;
      continue;
    }
    if (current === "--task-window-hours") {
      taskWindowHours = Number(args[index + 1]);
      if (!Number.isFinite(taskWindowHours) || taskWindowHours < 0) {
        throw new Error("--task-window-hours must be a non-negative number");
      }
      index += 1;
      continue;
    }
    throw new Error("run-doctor-hint only accepts --apply, --brief, --all-tasks, and --task-window-hours N");
  }

  return {
    hintId,
    apply,
    brief,
    includeAllTaskHistory,
    taskWindowHours
  };
}

function parseRunDoctorHintsArgs(args: string[]): {
  kind?: typeof DOCTOR_COMMAND_HINT_KINDS[number];
  limit?: number;
  apply: boolean;
  allowMultiTaskApply: boolean;
  confirmToken?: string;
  brief: boolean;
  includeAllTaskHistory: boolean;
  taskWindowHours?: number;
} {
  let kind: typeof DOCTOR_COMMAND_HINT_KINDS[number] | undefined;
  let limit: number | undefined;
  let apply = false;
  let allowMultiTaskApply = false;
  let confirmToken: string | undefined;
  let brief = false;
  let includeAllTaskHistory = false;
  let taskWindowHours: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--kind") {
      const next = args[index + 1];
      if (!next || !DOCTOR_COMMAND_HINT_KINDS.includes(next as typeof DOCTOR_COMMAND_HINT_KINDS[number])) {
        throw new Error(`--kind must be one of: ${DOCTOR_COMMAND_HINT_KINDS.join(", ")}`);
      }
      kind = next as typeof DOCTOR_COMMAND_HINT_KINDS[number];
      index += 1;
      continue;
    }
    if (current === "--limit") {
      limit = Number(args[index + 1]);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error("--limit must be a positive number");
      }
      index += 1;
      continue;
    }
    if (current === "--apply") {
      apply = true;
      continue;
    }
    if (current === "--allow-multi-task-apply") {
      allowMultiTaskApply = true;
      continue;
    }
    if (current === "--confirm-token") {
      confirmToken = args[index + 1];
      if (!confirmToken) {
        throw new Error("--confirm-token requires a value");
      }
      index += 1;
      continue;
    }
    if (current === "--brief") {
      brief = true;
      continue;
    }
    if (current === "--all-tasks") {
      includeAllTaskHistory = true;
      continue;
    }
    if (current === "--task-window-hours") {
      taskWindowHours = Number(args[index + 1]);
      if (!Number.isFinite(taskWindowHours) || taskWindowHours < 0) {
        throw new Error("--task-window-hours must be a non-negative number");
      }
      index += 1;
      continue;
    }
    throw new Error(
      "run-doctor-hints only accepts --kind, --limit, --apply, --allow-multi-task-apply, --confirm-token, --brief, --all-tasks, and --task-window-hours N"
    );
  }

  return {
    kind,
    limit,
    apply,
    allowMultiTaskApply,
    confirmToken,
    brief,
    includeAllTaskHistory,
    taskWindowHours
  };
}

function parseOperatorHistoryArgs(args: string[]): {
  brief: boolean;
  limit?: number;
  command?: typeof OPERATOR_RECEIPT_COMMANDS[number];
  applyOnly: boolean;
  dryRunOnly: boolean;
} {
  let brief = false;
  let limit: number | undefined;
  let command: typeof OPERATOR_RECEIPT_COMMANDS[number] | undefined;
  let applyOnly = false;
  let dryRunOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--brief") {
      brief = true;
      continue;
    }
    if (current === "--limit") {
      limit = Number(args[index + 1]);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error("--limit must be a positive number");
      }
      index += 1;
      continue;
    }
    if (current === "--command") {
      const next = args[index + 1];
      if (!next || !OPERATOR_RECEIPT_COMMANDS.includes(next as typeof OPERATOR_RECEIPT_COMMANDS[number])) {
        throw new Error(`--command must be one of: ${OPERATOR_RECEIPT_COMMANDS.join(", ")}`);
      }
      command = next as typeof OPERATOR_RECEIPT_COMMANDS[number];
      index += 1;
      continue;
    }
    if (current === "--apply-only") {
      applyOnly = true;
      continue;
    }
    if (current === "--dry-run-only") {
      dryRunOnly = true;
      continue;
    }
    throw new Error("operator-history only accepts --brief, --limit N, --command NAME, --apply-only, and --dry-run-only");
  }

  if (applyOnly && dryRunOnly) {
    throw new Error("operator-history cannot combine --apply-only with --dry-run-only");
  }

  return {
    brief,
    limit,
    command,
    applyOnly,
    dryRunOnly
  };
}

function parseShowOperatorReceiptArgs(args: string[]): {
  receiptPath?: string;
  latest: boolean;
  taskId?: string;
  command?: typeof OPERATOR_RECEIPT_COMMANDS[number];
  applyOnly: boolean;
  dryRunOnly: boolean;
  brief: boolean;
} {
  let brief = false;
  let latest = false;
  let taskId: string | undefined;
  let command: typeof OPERATOR_RECEIPT_COMMANDS[number] | undefined;
  let applyOnly = false;
  let dryRunOnly = false;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--brief") {
      brief = true;
      continue;
    }
    if (current === "--latest") {
      latest = true;
      continue;
    }
    if (current === "--task-id") {
      taskId = args[index + 1];
      if (!taskId) {
        throw new Error("--task-id requires a value");
      }
      index += 1;
      continue;
    }
    if (current === "--command") {
      const next = args[index + 1];
      if (!next || !OPERATOR_RECEIPT_COMMANDS.includes(next as typeof OPERATOR_RECEIPT_COMMANDS[number])) {
        throw new Error(`--command must be one of: ${OPERATOR_RECEIPT_COMMANDS.join(", ")}`);
      }
      command = next as typeof OPERATOR_RECEIPT_COMMANDS[number];
      index += 1;
      continue;
    }
    if (current === "--apply-only") {
      applyOnly = true;
      continue;
    }
    if (current === "--dry-run-only") {
      dryRunOnly = true;
      continue;
    }
    if (current.startsWith("--")) {
      throw new Error(
        "show-operator-receipt only accepts a receipt path or lookup flags: --latest, --task-id ID, --command NAME, --apply-only, --dry-run-only, and --brief"
      );
    }
    positionals.push(current);
  }

  if (applyOnly && dryRunOnly) {
    throw new Error("show-operator-receipt cannot combine --apply-only with --dry-run-only");
  }

  const receiptPath = positionals[0];
  const modeCount = Number(Boolean(receiptPath)) + Number(latest) + Number(Boolean(taskId));
  if (modeCount === 0) {
    throw new Error("show-operator-receipt requires a receipt path, --latest, or --task-id ID");
  }
  if (modeCount > 1 || positionals.length > 1) {
    throw new Error("show-operator-receipt accepts exactly one lookup mode: a receipt path, --latest, or --task-id ID");
  }
  if (receiptPath && (command || applyOnly || dryRunOnly)) {
    throw new Error("show-operator-receipt path mode does not accept --command, --apply-only, or --dry-run-only");
  }

  return {
    receiptPath,
    latest,
    taskId,
    command,
    applyOnly,
    dryRunOnly,
    brief
  };
}

function usage(): void {
  process.stdout.write(
    [
      "Usage:",
      `  ${CLI_USAGE_PREFIX} health`,
      `  ${CLI_USAGE_PREFIX} run-goal [--repo OWNER/REPO] [--base-branch NAME] [--work-branch NAME] [--dispatch-mode gh_cli|artifacts_only] [--execution-preference remote_only|local_preferred] [--timeout-sec N] [--interval-sec N] [--no-mirror] <goal>`,
      `  ${CLI_USAGE_PREFIX} plan <goal>`,
      `  ${CLI_USAGE_PREFIX} configure-github-repo <owner/repo> [dispatch-mode]`,
      `  ${CLI_USAGE_PREFIX} enqueue <task-id>`,
      `  ${CLI_USAGE_PREFIX} publish-github-mirror <task-id>`,
      `  ${CLI_USAGE_PREFIX} review <task-id> <reviewer> <verdict> [summary]`,
      `  ${CLI_USAGE_PREFIX} run-github-payload <payload-json>`,
      `  ${CLI_USAGE_PREFIX} sync-github-callback <task-id>`,
      `  ${CLI_USAGE_PREFIX} wait-github-callback <task-id> [timeout-sec] [interval-sec]`,
      `  ${CLI_USAGE_PREFIX} reconcile-github-running [timeout-sec] [interval-sec] [--brief]`,
      `  ${CLI_USAGE_PREFIX} recover-running [timeout-sec] [interval-sec] [--requeue-local] [--brief]`,
      `  ${CLI_USAGE_PREFIX} status [task-id] [--brief]`,
      `  ${CLI_USAGE_PREFIX} doctor [--brief] [--all-tasks] [--task-window-hours N]`,
      `  ${CLI_USAGE_PREFIX} review-workflow-status [--brief]`,
      `  ${CLI_USAGE_PREFIX} operator-history [--brief] [--limit N] [--command NAME] [--apply-only] [--dry-run-only]`,
      `  ${CLI_USAGE_PREFIX} show-operator-receipt <receipt-path> [--brief]`,
      `  ${CLI_USAGE_PREFIX} show-operator-receipt --latest [--command NAME] [--apply-only|--dry-run-only] [--brief]`,
      `  ${CLI_USAGE_PREFIX} show-operator-receipt --task-id ID [--command NAME] [--apply-only|--dry-run-only] [--brief]`,
      `  ${CLI_USAGE_PREFIX} run-doctor-hint <hint-id> [--apply] [--brief] [--all-tasks] [--task-window-hours N]`,
      `  ${CLI_USAGE_PREFIX} run-doctor-hints [--kind KIND] [--limit N] [--apply] [--allow-multi-task-apply] [--confirm-token TOKEN] [--brief] [--all-tasks] [--task-window-hours N]`,
      `  ${CLI_USAGE_PREFIX} sweep-tasks <cancel|requeue> [--state a,b] [--older-than-hours N] [--goal-contains TEXT] [--worker-target TARGET] [--task-id ID] [--limit N] [--all] [--dry-run] [--brief]`,
      `  ${CLI_USAGE_PREFIX} dispatch <task-id>`,
      `  ${CLI_USAGE_PREFIX} dispatch-and-wait <task-id> [timeout-sec] [interval-sec]`,
      `  ${CLI_USAGE_PREFIX} dispatch-next`,
      `  ${CLI_USAGE_PREFIX} clear-penalties [worker-target|all]`,
      `  ${CLI_USAGE_PREFIX} complete-from-file <worker-result.json>`
    ].join("\n") + "\n"
  );
}

export async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const orchestrator = new CodexHeadOrchestrator();

  if (!command) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (command === "health") {
    printJson(await orchestrator.smokeAdapters());
    return;
  }

  if (command === "review-workflow-status") {
    const parsed = parseReviewWorkflowStatusArgs(rest);
    const health = await orchestrator.smokeAdapters();
    const workflow = health.github.review_workflow ?? null;
    const localDrift = inspectLocalReviewWorkflowDrift(
      orchestrator.config.app_root,
      workflow,
      health.github.review_workflow_declared_inputs ?? [],
      health.github.review_workflow_supports_review_profile != null
        || (health.github.review_workflow_declared_inputs?.length ?? 0) > 0
    );
    const inspectCommand = workflow ? `gh workflow view ${workflow} --yaml` : null;
    const remoteDeclaredInputs = health.github.review_workflow_declared_inputs ?? [];
    const output = {
      repository: health.github.repository,
      workflow,
      local_workflow_path: localDrift.local_workflow_path,
      git_branch: localDrift.git_branch,
      git_tracking_status: localDrift.git_tracking_status,
      local_git_file_status: localDrift.local_git_file_status,
      local_vs_origin_status: localDrift.local_vs_origin_status,
      local_supports_review_profile: localDrift.local_supports_review_profile,
      local_declared_inputs: localDrift.local_declared_inputs,
      remote_supports_review_profile: health.github.review_workflow_supports_review_profile ?? null,
      remote_declared_inputs: remoteDeclaredInputs,
      missing_on_remote: localDrift.missing_on_remote,
      remote_check_detail: health.github.review_workflow_input_check_detail ?? null,
      inspect_command: inspectCommand,
      sync_action: localDrift.sync_action,
      sync_commands: localDrift.sync_commands
    };
    if (parsed.brief) {
      printText(renderReviewWorkflowStatusBrief(output));
    } else {
      printJson(output);
    }
    return;
  }

  if (command === "run-goal") {
    const parsed = parseRunGoalArgs(rest);
    let workingOrchestrator = orchestrator;
    if (parsed.repository || parsed.executionPreference) {
      const repositoryOverride = parsed.repository
        ? (() => {
          const normalizedRepository = normalizeGitHubRepository(parsed.repository!);
          if (!normalizedRepository) {
            throw new Error("repository must be a valid GitHub OWNER/REPO or GitHub URL");
          }
          const status = orchestrator.github.verifyRepositoryAccess(normalizedRepository);
          if (!status.accessible) {
            throw new Error(`GitHub repository validation failed: ${status.detail}`);
          }
          return status.repository;
        })()
        : orchestrator.config.github.repository;

      if (
        parsed.executionPreference === "remote_only"
        && (parsed.dispatchMode ?? orchestrator.config.github.dispatch_mode) !== "gh_cli"
      ) {
        throw new Error("run-goal --execution-preference remote_only requires --dispatch-mode gh_cli");
      }

      workingOrchestrator = new CodexHeadOrchestrator({
        ...orchestrator.config,
        github: {
          ...orchestrator.config.github,
          enabled: true,
          ...buildRunGoalGitHubOverride(
            repositoryOverride,
            parsed.dispatchMode,
            parsed.executionPreference,
            parsed.repository ? "gh_cli" : orchestrator.config.github.dispatch_mode
          )
        }
      });
    }

    const previewPlan = workingOrchestrator.planGoal(parsed.goal);
    const firstTask = previewPlan.tasks[0];
    if (!firstTask) {
      throw new Error("planner did not produce any tasks");
    }
    const needsGitHubRepository = firstTask.requires_github
      || firstTask.expected_output.kind === "pull_request"
      || firstTask.artifact_policy.mode === "branch_pr";
    if (needsGitHubRepository && workingOrchestrator.config.github.repository === "OWNER/REPO") {
      throw new Error("run-goal needs a real GitHub repository; pass --repo OWNER/REPO or configure-github-repo first");
    }
    if (needsGitHubRepository) {
      const status = workingOrchestrator.github.verifyRepositoryAccess();
      const effectiveDispatchMode = parsed.dispatchMode
        ?? (status.accessible ? "gh_cli" : workingOrchestrator.config.github.dispatch_mode);
      if (effectiveDispatchMode === "gh_cli" && !status.accessible) {
        throw new Error(`GitHub repository validation failed: ${status.detail}`);
      }
      if (
        status.accessible
        && (
          workingOrchestrator.config.github.repository !== status.repository
          || workingOrchestrator.config.github.dispatch_mode !== effectiveDispatchMode
        )
      ) {
        workingOrchestrator = new CodexHeadOrchestrator({
          ...workingOrchestrator.config,
          github: {
            ...workingOrchestrator.config.github,
            repository: status.repository,
            dispatch_mode: effectiveDispatchMode,
            execution_preference: parsed.executionPreference ?? workingOrchestrator.config.github.execution_preference
          }
        });
      }
    }

    printJson(await workingOrchestrator.runGoal(parsed.goal, {
      base_branch: parsed.baseBranch,
      work_branch: parsed.workBranch,
      execution_preference: parsed.executionPreference,
      publish_github_mirror: parsed.publishMirror,
      timeout_sec: parsed.timeoutSec,
      interval_sec: parsed.intervalSec
    }));
    return;
  }

  if (command === "configure-github-repo") {
    const repositoryInput = rest[0];
    const normalizedRepository = normalizeGitHubRepository(repositoryInput);
    if (!normalizedRepository) {
      throw new Error("repository must be a valid GitHub OWNER/REPO or GitHub URL");
    }
    const dispatchMode = rest[1] === "artifacts_only" ? "artifacts_only" : "gh_cli";
    const status = orchestrator.github.verifyRepositoryAccess(normalizedRepository);
    if (!status.accessible) {
      throw new Error(`GitHub repository validation failed: ${status.detail}`);
    }

    const saved = updateGitHubConfig(orchestrator.config.app_root, {
      enabled: true,
      repository: status.repository,
      dispatch_mode: dispatchMode
    });
    printJson({
      config_path: saved.path,
      repository: status.repository,
      repository_url: status.url,
      default_branch: status.default_branch,
      viewer_permission: status.viewer_permission,
      dispatch_mode: saved.config.github.dispatch_mode
    });
    return;
  }

  if (command === "plan") {
    const goal = rest.join(" ").trim();
    if (!goal) {
      throw new Error("goal is required");
    }
    const plan = orchestrator.planGoal(goal);
    orchestrator.savePlannedTasks(plan);
    printJson(plan);
    return;
  }

  if (command === "enqueue") {
    const taskId = rest[0];
    if (!taskId) {
      throw new Error("task id is required");
    }
    printJson(orchestrator.enqueueTask(taskId));
    return;
  }

  if (command === "publish-github-mirror") {
    const taskId = rest[0];
    if (!taskId) {
      throw new Error("task id is required");
    }
    printJson(orchestrator.publishGitHubMirror(taskId));
    return;
  }

  if (command === "review") {
    const [taskId, reviewer, verdict, ...summaryParts] = rest;
    if (!taskId) {
      throw new Error("task id is required");
    }
    if (!reviewer || !WORKER_TARGETS.includes(reviewer as typeof WORKER_TARGETS[number])) {
      throw new Error("reviewer must be a valid worker target");
    }
    if (!verdict || !REVIEW_VERDICTS.includes(verdict as typeof REVIEW_VERDICTS[number])) {
      throw new Error("verdict must be one of approved, changes_requested, commented");
    }
    printJson(orchestrator.recordReview(
      taskId,
      reviewer as typeof WORKER_TARGETS[number],
      verdict as typeof REVIEW_VERDICTS[number],
      summaryParts.join(" ").trim() || undefined
    ));
    return;
  }

  if (command === "run-github-payload") {
    const filePath = rest[0];
    if (!filePath) {
      throw new Error("payload json path is required");
    }
    const execution = await executeGitHubPayloadFile(resolve(filePath));
    printJson(execution);
    if (execution.result.status !== "completed") {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "sync-github-callback") {
    const taskId = rest[0];
    if (!taskId) {
      throw new Error("task id is required");
    }
    printJson(orchestrator.syncGitHubCallback(taskId));
    return;
  }

  if (command === "wait-github-callback") {
    const taskId = rest[0];
    if (!taskId) {
      throw new Error("task id is required");
    }
    const timeoutSec = rest[1] ? Number(rest[1]) : undefined;
    const intervalSec = rest[2] ? Number(rest[2]) : undefined;
    printJson(await orchestrator.waitForGitHubCallback(taskId, timeoutSec, intervalSec));
    return;
  }

  if (command === "reconcile-github-running") {
    const parsed = parseReconcileArgs(rest);
    const result = await orchestrator.reconcileRunningGitHubTasks(parsed.timeoutSec, parsed.intervalSec);
    if (parsed.brief) {
      printText(renderOutcomeBrief(result, "No running GitHub tasks to reconcile."));
      return;
    }
    printJson(result);
    return;
  }

  if (command === "recover-running") {
    const parsed = parseRecoverRunningArgs(rest);
    const result = await orchestrator.recoverRunningTasks({
      timeout_sec: parsed.timeoutSec,
      interval_sec: parsed.intervalSec,
      requeue_local: parsed.requeueLocal
    });
    if (parsed.brief) {
      printText(renderOutcomeBrief(result, "No running tasks to recover."));
      return;
    }
    printJson(result);
    return;
  }

  if (command === "dispatch-next") {
    printJson(await orchestrator.dispatchNext());
    return;
  }

  if (command === "dispatch") {
    const taskId = rest[0];
    if (!taskId) {
      throw new Error("task id is required");
    }
    printJson(await orchestrator.dispatchExistingTask(taskId));
    return;
  }

  if (command === "dispatch-and-wait") {
    const taskId = rest[0];
    if (!taskId) {
      throw new Error("task id is required");
    }
    const timeoutSec = rest[1] ? Number(rest[1]) : undefined;
    const intervalSec = rest[2] ? Number(rest[2]) : undefined;
    printJson(await orchestrator.dispatchAndWait(taskId, timeoutSec, intervalSec));
    return;
  }

  if (command === "clear-penalties") {
    const target = rest[0];
    if (!target || target === "all") {
      printJson(orchestrator.clearRecentWorkerPenalties());
      return;
    }
    if (!WORKER_TARGETS.includes(target as typeof WORKER_TARGETS[number])) {
      throw new Error(`worker target must be one of: ${WORKER_TARGETS.join(", ")}, or "all"`);
    }
    printJson(orchestrator.clearRecentWorkerPenalties([target as typeof WORKER_TARGETS[number]]));
    return;
  }

  if (command === "complete-from-file") {
    const filePath = rest[0];
    if (!filePath) {
      throw new Error("worker result json path is required");
    }
    printJson(orchestrator.completeFromFile(resolve(filePath)));
    return;
  }

  if (command === "status") {
    const parsed = parseStatusArgs(rest);
    const result = parsed.taskId
      ? buildTaskStatusSnapshot(orchestrator.getTask(parsed.taskId), orchestrator.artifactStore)
      : buildTaskStatusSnapshots(orchestrator.listTasks(), orchestrator.artifactStore);
    if (parsed.brief) {
      printText(renderStatusBrief(result));
      return;
    }
    printJson(result);
    return;
  }

  if (command === "doctor") {
    const parsed = parseDoctorArgs(rest);
    const result = await orchestrator.createDoctorReport({
      include_all_task_history: parsed.includeAllTaskHistory,
      task_window_hours: parsed.taskWindowHours
    });
    if (parsed.brief) {
      printText(renderDoctorBrief(result));
      return;
    }
    printJson(result);
    return;
  }

  if (command === "operator-history") {
    const parsed = parseOperatorHistoryArgs(rest);
    const result = orchestrator.listOperatorHistory({
      limit: parsed.limit,
      command: parsed.command,
      apply_only: parsed.applyOnly,
      dry_run_only: parsed.dryRunOnly
    });
    if (parsed.brief) {
      printText(renderOperatorHistoryBrief(result));
      return;
    }
    printJson(result);
    return;
  }

  if (command === "show-operator-receipt") {
    const parsed = parseShowOperatorReceiptArgs(rest);
    const result = parsed.receiptPath
      ? orchestrator.showOperatorReceipt(parsed.receiptPath)
      : parsed.latest
        ? orchestrator.showLatestOperatorReceipt({
          command: parsed.command,
          apply_only: parsed.applyOnly,
          dry_run_only: parsed.dryRunOnly
        })
        : orchestrator.showOperatorReceiptForTask(parsed.taskId ?? "", {
          command: parsed.command,
          apply_only: parsed.applyOnly,
          dry_run_only: parsed.dryRunOnly
        });
    if (parsed.brief) {
      printText(renderOperatorReceiptBrief(result));
      return;
    }
    printJson(result);
    return;
  }

  if (command === "run-doctor-hint") {
    const parsed = parseRunDoctorHintArgs(rest);
    const result = await orchestrator.runDoctorHint(parsed.hintId, {
      apply: parsed.apply,
      include_all_task_history: parsed.includeAllTaskHistory,
      task_window_hours: parsed.taskWindowHours
    });
    if (parsed.brief) {
      printText(renderRunDoctorHintBrief(result));
      return;
    }
    printJson(result);
    return;
  }

  if (command === "run-doctor-hints") {
    const parsed = parseRunDoctorHintsArgs(rest);
    const result = await orchestrator.runDoctorHints({
      kind: parsed.kind,
      limit: parsed.limit,
      apply: parsed.apply,
      allow_multi_task_apply: parsed.allowMultiTaskApply,
      confirm_token: parsed.confirmToken,
      include_all_task_history: parsed.includeAllTaskHistory,
      task_window_hours: parsed.taskWindowHours
    });
    if (parsed.brief) {
      printText(renderRunDoctorHintsBrief(result));
      return;
    }
    printJson(result);
    return;
  }

  if (command === "sweep-tasks") {
    const parsed = parseSweepArgs(rest);
    const result = orchestrator.runSweepTasks({
      action: parsed.action,
      states: parsed.states,
      older_than_hours: parsed.olderThanHours,
      goal_contains: parsed.goalContains,
      worker_target: parsed.workerTarget,
      task_ids: parsed.taskIds,
      limit: parsed.limit,
      dry_run: parsed.dryRun
    });
    if (parsed.brief) {
      printText(renderSweepBrief(result));
      return;
    }
    printJson(result);
    return;
  }

  usage();
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
