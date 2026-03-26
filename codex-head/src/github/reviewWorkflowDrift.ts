import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export interface LocalReviewWorkflowDrift {
  local_workflow_path: string | null;
  git_branch: string | null;
  git_tracking_status: string | null;
  local_git_file_status: string | null;
  local_vs_origin_status: string | null;
  local_declared_inputs: string[];
  local_supports_review_profile: boolean | null;
  missing_on_remote: string[];
  sync_action: string | null;
  sync_commands: string[];
}

function runGit(repoRoot: string, args: string[]): {
  ok: boolean;
  stdout: string;
} {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8"
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: String(result.stdout ?? "").trim()
  };
}

export function extractWorkflowDispatchInputs(workflowYaml: string): string[] {
  const lines = workflowYaml.split(/\r?\n/);
  let inWorkflowDispatch = false;
  let inInputs = false;
  const inputs: string[] = [];

  for (const line of lines) {
    if (!inWorkflowDispatch) {
      if (/^\s{2}workflow_dispatch:\s*$/.test(line)) {
        inWorkflowDispatch = true;
      }
      continue;
    }

    if (inWorkflowDispatch && !inInputs) {
      if (/^\s{4}inputs:\s*$/.test(line)) {
        inInputs = true;
        continue;
      }
      if (/^\s{2}\S/.test(line)) {
        break;
      }
      continue;
    }

    if (inInputs) {
      const match = line.match(/^\s{6}([A-Za-z0-9_-]+):\s*$/);
      if (match?.[1]) {
        inputs.push(match[1]);
        continue;
      }
      if (/^\s{0,4}\S/.test(line)) {
        break;
      }
    }
  }

  return [...new Set(inputs)];
}

function mapGitFileStatus(code: string | null): string | null {
  if (!code) {
    return "clean";
  }
  const normalized = code.trim();
  if (normalized === "??") {
    return "untracked";
  }
  if (normalized === "M" || normalized === "MM" || normalized === "AM" || normalized === " T") {
    return "modified";
  }
  if (normalized.includes("M")) {
    return "modified";
  }
  if (normalized.includes("A")) {
    return "added";
  }
  if (normalized.includes("D")) {
    return "deleted";
  }
  if (normalized.includes("R")) {
    return "renamed";
  }
  return normalized;
}

function describeGitTrackingStatus(aheadBehind: string | null): string | null {
  if (!aheadBehind) {
    return null;
  }

  const match = aheadBehind.match(/^(\d+)\s+(\d+)$/);
  if (!match) {
    return null;
  }

  const behind = Number(match[1]);
  const ahead = Number(match[2]);

  if (ahead === 0 && behind === 0) {
    return "in sync with origin/main";
  }
  if (ahead > 0 && behind === 0) {
    return `ahead of origin/main by ${ahead} commit(s)`;
  }
  if (ahead === 0 && behind > 0) {
    return `behind origin/main by ${behind} commit(s)`;
  }
  return `diverged from origin/main (${ahead} ahead, ${behind} behind)`;
}

function describeWorkflowOriginStatus(options: {
  committedDiffersFromOrigin: boolean | null;
  workingTreeDiffersFromHead: boolean | null;
}): string | null {
  const { committedDiffersFromOrigin, workingTreeDiffersFromHead } = options;

  if (committedDiffersFromOrigin == null && workingTreeDiffersFromHead == null) {
    return null;
  }
  if (committedDiffersFromOrigin === false && workingTreeDiffersFromHead === false) {
    return "matches origin/main";
  }
  if (committedDiffersFromOrigin === false && workingTreeDiffersFromHead === true) {
    return "uncommitted local changes only; HEAD still matches origin/main";
  }
  if (committedDiffersFromOrigin === true && workingTreeDiffersFromHead === false) {
    return "committed changes differ from origin/main";
  }
  if (committedDiffersFromOrigin === true && workingTreeDiffersFromHead === true) {
    return "committed changes differ from origin/main and working tree also has local edits";
  }
  if (committedDiffersFromOrigin === true) {
    return "committed changes differ from origin/main";
  }
  if (workingTreeDiffersFromHead === true) {
    return "uncommitted local changes only";
  }
  return null;
}

function buildWorkflowSyncCommands(options: {
  workflow: string | null;
  gitBranch: string | null;
  localVsOriginStatus: string | null;
  remoteMissingInputs: string[];
}): string[] {
  if (!options.workflow || options.remoteMissingInputs.length === 0) {
    return [];
  }

  const workflowPath = `.github/workflows/${options.workflow}`;
  const branch = options.gitBranch;
  const commands: string[] = [];

  if (options.localVsOriginStatus === "uncommitted local changes only; HEAD still matches origin/main") {
    commands.push(`git add ${workflowPath}`);
    commands.push(`git commit --only ${workflowPath} -m "Update ${options.workflow} workflow_dispatch inputs"`);
    if (branch) {
      commands.push(`git push origin ${branch}`);
    }
    return commands;
  }

  if (options.localVsOriginStatus?.startsWith("committed changes differ from origin/main")) {
    if (branch) {
      commands.push(`git push origin ${branch}`);
    }
    return commands;
  }

  return commands;
}

function buildWorkflowSyncAction(options: {
  workflow: string | null;
  gitBranch: string | null;
  localVsOriginStatus: string | null;
  remoteMissingInputs: string[];
}): string | null {
  const { workflow, gitBranch, localVsOriginStatus, remoteMissingInputs } = options;
  if (!workflow || remoteMissingInputs.length === 0) {
    return null;
  }

  if (localVsOriginStatus && localVsOriginStatus !== "matches origin/main") {
    if (localVsOriginStatus === "uncommitted local changes only; HEAD still matches origin/main") {
      return `Commit and push .github/workflows/${workflow} from ${gitBranch ?? "the current branch"} so review_profile is accepted during workflow_dispatch and research/code-assist routing works live.`;
    }
    if (localVsOriginStatus.startsWith("committed changes differ from origin/main")) {
      return `Push .github/workflows/${workflow} from ${gitBranch ?? "the current branch"} so review_profile is accepted during workflow_dispatch and research/code-assist routing works live.`;
    }
  }

  return `Push or sync .github/workflows/${workflow} to the GitHub default branch so review_profile is accepted during workflow_dispatch and research/code-assist routing works live.`;
}

export function inspectLocalReviewWorkflowDrift(
  appRoot: string,
  workflow: string | null,
  remoteDeclaredInputs: string[] = []
): LocalReviewWorkflowDrift {
  if (!workflow) {
    return {
      local_workflow_path: null,
      git_branch: null,
      git_tracking_status: null,
      local_git_file_status: null,
      local_vs_origin_status: null,
      local_declared_inputs: [],
      local_supports_review_profile: null,
      missing_on_remote: [],
      sync_action: null,
      sync_commands: []
    };
  }

  const repoRoot = resolve(appRoot, "..");
  const localWorkflowPath = resolve(repoRoot, ".github", "workflows", workflow);
  const localWorkflowYaml = existsSync(localWorkflowPath)
    ? readFileSync(localWorkflowPath, "utf8")
    : null;
  const localDeclaredInputs = localWorkflowYaml
    ? extractWorkflowDispatchInputs(localWorkflowYaml)
    : [];

  const gitBranchResult = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const gitBranch = gitBranchResult.ok ? gitBranchResult.stdout : null;
  const trackingResult = runGit(repoRoot, ["rev-list", "--left-right", "--count", "origin/main...HEAD"]);
  const gitTrackingStatus = trackingResult.ok
    ? describeGitTrackingStatus(trackingResult.stdout)
    : null;

  const relativeWorkflowPath = relative(repoRoot, localWorkflowPath);
  const gitStatusResult = existsSync(localWorkflowPath)
    ? runGit(repoRoot, ["status", "--short", "--", relativeWorkflowPath])
    : { ok: false, stdout: "" };
  const localGitFileStatus = existsSync(localWorkflowPath)
    ? mapGitFileStatus(gitStatusResult.ok && gitStatusResult.stdout ? gitStatusResult.stdout.slice(0, 2) : null)
    : null;

  const headDiffResult = existsSync(localWorkflowPath)
    ? spawnSync("git", ["-C", repoRoot, "diff", "--quiet", "HEAD", "--", relativeWorkflowPath], {
      encoding: "utf8"
    })
    : null;
  const originCommittedDiffResult = existsSync(localWorkflowPath)
    ? spawnSync("git", ["-C", repoRoot, "diff", "--quiet", "origin/main..HEAD", "--", relativeWorkflowPath], {
      encoding: "utf8"
    })
    : null;
  const localVsOriginStatus = existsSync(localWorkflowPath)
    ? describeWorkflowOriginStatus({
      committedDiffersFromOrigin: originCommittedDiffResult?.status === 1 ? true : originCommittedDiffResult?.status === 0 ? false : null,
      workingTreeDiffersFromHead: headDiffResult?.status === 1 ? true : headDiffResult?.status === 0 ? false : null
    })
    : null;

  const missingOnRemote = localDeclaredInputs.filter((input) => !remoteDeclaredInputs.includes(input));
  const syncCommands = buildWorkflowSyncCommands({
    workflow,
    gitBranch,
    localVsOriginStatus,
    remoteMissingInputs: missingOnRemote
  });
  const syncAction = buildWorkflowSyncAction({
    workflow,
    gitBranch,
    localVsOriginStatus,
    remoteMissingInputs: missingOnRemote
  });

  return {
    local_workflow_path: existsSync(localWorkflowPath) ? localWorkflowPath : null,
    git_branch: gitBranch,
    git_tracking_status: gitTrackingStatus,
    local_git_file_status: localGitFileStatus,
    local_vs_origin_status: localVsOriginStatus,
    local_declared_inputs: localDeclaredInputs,
    local_supports_review_profile: localWorkflowYaml ? localDeclaredInputs.includes("review_profile") : null,
    missing_on_remote: missingOnRemote,
    sync_action: syncAction,
    sync_commands: syncCommands
  };
}
