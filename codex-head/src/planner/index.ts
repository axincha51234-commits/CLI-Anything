import type { HeadPlan, TaskSpec, WorkerTarget } from "../contracts";
import { createTaskSpec } from "../schema";

interface PlannerOptions {
  github_enabled: boolean;
  antigravity_enabled: boolean;
  local_reviewers: WorkerTarget[];
}

function inferWorkerTarget(goal: string, options: PlannerOptions): WorkerTarget {
  const normalized = goal.toLowerCase();
  if (/(issue|pr|pull request|github|workflow|triage)/.test(normalized)) {
    return "gemini-cli";
  }
  if (/(implement|build|fix|refactor|refine|edit|write code)/.test(normalized)) {
    return "claude-code";
  }
  if (/(research|explore|investigate)/.test(normalized)) {
    return options.antigravity_enabled ? "antigravity" : "gemini-cli";
  }
  if (!options.github_enabled && /(review|analyze|analyse|summari[sz]e|report|audit)/.test(normalized)) {
    return "gemini-cli";
  }
  return "codex-cli";
}

function inferExpectedOutput(goal: string, workerTarget: WorkerTarget): TaskSpec["expected_output"] {
  const normalized = goal.toLowerCase();

  if (workerTarget === "claude-code") {
    return { kind: "patch", format: "patch", code_change: true };
  }

  if (/(review|approve|audit|issue|pr|pull request|github|workflow|triage)/.test(normalized)) {
    return { kind: "review", format: "markdown", code_change: false };
  }

  return { kind: "analysis", format: "markdown", code_change: false };
}

function inferTimeoutSec(workerTarget: WorkerTarget, expectsCodeChange: boolean, requiresGitHub: boolean): number {
  if (requiresGitHub) {
    return 300;
  }
  if (expectsCodeChange) {
    return 180;
  }
  if (workerTarget === "antigravity" || workerTarget === "claude-code" || workerTarget === "gemini-cli") {
    return 60;
  }
  return 30;
}

function inferLocalReviewPolicy(primaryWorker: WorkerTarget, options: PlannerOptions): TaskSpec["review_policy"] {
  const requiredReviewers = options.local_reviewers.filter((reviewer) => reviewer !== primaryWorker);
  if (requiredReviewers.length === 0) {
    return { required_reviewers: [], require_all: true };
  }

  return {
    required_reviewers: requiredReviewers,
    require_all: false
  };
}

export class CodexHeadPlanner {
  constructor(
    private readonly methodologyRefs: string[],
    private readonly options: PlannerOptions = {
      github_enabled: false,
      antigravity_enabled: false,
      local_reviewers: ["gemini-cli", "codex-cli"]
    }
  ) {}

  planGoal(goal: string, repo: string): HeadPlan {
    const normalized = goal.toLowerCase();
    const githubShapedGoal = /(issue|pr|pull request|github|workflow|triage)/.test(normalized);
    const workerTarget = inferWorkerTarget(goal, this.options);
    const expectedOutput = inferExpectedOutput(goal, workerTarget);
    const expectsCodeChange = expectedOutput.code_change;
    const requiresGithub = githubShapedGoal && this.options.github_enabled;
    const task: TaskSpec = createTaskSpec({
      goal,
      repo,
      worker_target: workerTarget,
      expected_output: expectedOutput,
      review_policy: expectsCodeChange
        ? (requiresGithub
          ? {
              required_reviewers: ["codex-cli", "gemini-cli"],
              require_all: true
            }
          : inferLocalReviewPolicy(workerTarget, this.options))
        : { required_reviewers: [], require_all: true },
      artifact_policy: expectsCodeChange
        ? { mode: requiresGithub ? "branch_pr" : "patch_artifact", require_lineage: true }
        : { mode: "local_artifact", require_lineage: true },
      timeout_sec: inferTimeoutSec(workerTarget, expectsCodeChange, requiresGithub),
      requires_github: requiresGithub
    });

    return {
      summary: `Codex head planned 1 task for ${workerTarget}`,
      tasks: [task],
      methodology_refs: this.methodologyRefs
    };
  }
}
