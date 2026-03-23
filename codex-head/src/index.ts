import { resolve } from "node:path";

import {
  renderDoctorBrief,
  renderOutcomeBrief,
  renderRunDoctorHintBrief,
  renderRunDoctorHintsBrief,
  renderStatusBrief,
  renderSweepBrief
} from "./brief";
import { normalizeGitHubRepository, updateGitHubConfig } from "./config";
import { REVIEW_VERDICTS, TASK_STATES, WORKER_TARGETS } from "./contracts";
import { DOCTOR_COMMAND_HINT_KINDS } from "./doctor";
import { executeGitHubPayloadFile } from "./github/workflowRunner";
import { CodexHeadOrchestrator } from "./orchestrator";
import { buildTaskStatusSnapshot, buildTaskStatusSnapshots } from "./status";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printText(value: string): void {
  process.stdout.write(`${value}\n`);
}

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
  dispatchMode?: "artifacts_only" | "gh_cli";
  timeoutSec?: number;
  intervalSec?: number;
  publishMirror: boolean;
} {
  const goalParts: string[] = [];
  let repository: string | undefined;
  let dispatchMode: "artifacts_only" | "gh_cli" | undefined;
  let timeoutSec: number | undefined;
  let intervalSec: number | undefined;
  let publishMirror = true;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--repo") {
      repository = args[index + 1];
      index += 1;
      continue;
    }
    if (current === "--dispatch-mode") {
      const next = args[index + 1];
      dispatchMode = next === "artifacts_only" ? "artifacts_only" : "gh_cli";
      index += 1;
      continue;
    }
    if (current === "--timeout-sec") {
      timeoutSec = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (current === "--interval-sec") {
      intervalSec = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (current === "--no-mirror") {
      publishMirror = false;
      continue;
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
    dispatchMode,
    timeoutSec,
    intervalSec,
    publishMirror
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
  brief: boolean;
  includeAllTaskHistory: boolean;
  taskWindowHours?: number;
} {
  let kind: typeof DOCTOR_COMMAND_HINT_KINDS[number] | undefined;
  let limit: number | undefined;
  let apply = false;
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
      "run-doctor-hints only accepts --kind, --limit, --apply, --brief, --all-tasks, and --task-window-hours N"
    );
  }

  return {
    kind,
    limit,
    apply,
    brief,
    includeAllTaskHistory,
    taskWindowHours
  };
}

function usage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  node dist/src/index.js health",
      "  node dist/src/index.js run-goal [--repo OWNER/REPO] [--dispatch-mode gh_cli|artifacts_only] [--timeout-sec N] [--interval-sec N] [--no-mirror] <goal>",
      "  node dist/src/index.js plan <goal>",
      "  node dist/src/index.js configure-github-repo <owner/repo> [dispatch-mode]",
      "  node dist/src/index.js enqueue <task-id>",
      "  node dist/src/index.js publish-github-mirror <task-id>",
      "  node dist/src/index.js review <task-id> <reviewer> <verdict> [summary]",
      "  node dist/src/index.js run-github-payload <payload-json>",
      "  node dist/src/index.js sync-github-callback <task-id>",
      "  node dist/src/index.js wait-github-callback <task-id> [timeout-sec] [interval-sec]",
      "  node dist/src/index.js reconcile-github-running [timeout-sec] [interval-sec] [--brief]",
      "  node dist/src/index.js recover-running [timeout-sec] [interval-sec] [--requeue-local] [--brief]",
      "  node dist/src/index.js status [task-id] [--brief]",
      "  node dist/src/index.js doctor [--brief] [--all-tasks] [--task-window-hours N]",
      "  node dist/src/index.js run-doctor-hint <hint-id> [--apply] [--brief] [--all-tasks] [--task-window-hours N]",
      "  node dist/src/index.js run-doctor-hints [--kind KIND] [--limit N] [--apply] [--brief] [--all-tasks] [--task-window-hours N]",
      "  node dist/src/index.js sweep-tasks <cancel|requeue> [--state a,b] [--older-than-hours N] [--goal-contains TEXT] [--worker-target TARGET] [--task-id ID] [--limit N] [--all] [--dry-run] [--brief]",
      "  node dist/src/index.js dispatch <task-id>",
      "  node dist/src/index.js dispatch-and-wait <task-id> [timeout-sec] [interval-sec]",
      "  node dist/src/index.js dispatch-next",
      "  node dist/src/index.js clear-penalties [worker-target|all]",
      "  node dist/src/index.js complete-from-file <worker-result.json>"
    ].join("\n") + "\n"
  );
}

async function main(): Promise<void> {
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

  if (command === "run-goal") {
    const parsed = parseRunGoalArgs(rest);
    let workingOrchestrator = orchestrator;
    if (parsed.repository) {
      const normalizedRepository = normalizeGitHubRepository(parsed.repository);
      if (!normalizedRepository) {
        throw new Error("repository must be a valid GitHub OWNER/REPO or GitHub URL");
      }
      const status = orchestrator.github.verifyRepositoryAccess(normalizedRepository);
      if (!status.accessible) {
        throw new Error(`GitHub repository validation failed: ${status.detail}`);
      }
      updateGitHubConfig(orchestrator.config.app_root, {
        enabled: true,
        repository: status.repository,
        dispatch_mode: parsed.dispatchMode ?? "gh_cli"
      });
      workingOrchestrator = new CodexHeadOrchestrator();
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
            dispatch_mode: effectiveDispatchMode
          }
        });
      }
    }

    printJson(await workingOrchestrator.runGoal(parsed.goal, {
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
    printJson(await executeGitHubPayloadFile(resolve(filePath)));
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
    const result = orchestrator.sweepTasks({
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
