import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { findInstalledBinary } from "../adapter-registry/commandPolicy";
import type { FileArtifactStore } from "../artifacts/fileArtifactStore";
import type { CodexHeadConfig } from "../config";
import type {
  GitHubMirrorState,
  GitHubMirrorTarget,
  GitHubRunState,
  RoutingDecision,
  TaskSpec,
  WorkerResult
} from "../contracts";
import { extractWorkflowDispatchInputs, inspectLocalReviewWorkflowDrift } from "./reviewWorkflowDrift";

export interface GitHubDispatchInfo {
  workflow_name: string;
  payload_path: string;
  workflow_inputs_path: string;
  issue_path: string;
  pr_path: string | null;
}

export interface GitHubCliRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface GitHubRuntimeStatus {
  enabled: boolean;
  dispatch_mode: CodexHeadConfig["github"]["dispatch_mode"];
  execution_preference: CodexHeadConfig["github"]["execution_preference"];
  auto_recycle_stale_runner: boolean;
  repository: string;
  workflow: string;
  review_workflow: string | null;
  cli_binary: string;
  gh_cli_available: boolean;
  gh_cli_path: string | null;
  gh_authenticated: boolean;
  machine_config_path: string | null;
  machine_config_exists: boolean;
  runs_on_json: string | null;
  runs_on_labels: string[];
  self_hosted_targeted: boolean;
  recycle_script_path: string | null;
  recycle_script_available: boolean;
  matching_runners: Array<{
    id: number;
    name: string;
    os: string;
    status: string;
    busy: boolean;
    labels: string[];
    matches_target_labels: boolean;
  }>;
  runner_lookup_detail: string | null;
  review_workflow_supports_review_profile?: boolean | null;
  review_workflow_input_check_detail?: string | null;
  review_workflow_declared_inputs?: string[] | null;
  review_workflow_missing_dispatch_inputs?: string[] | null;
  review_workflow_local_path?: string | null;
  review_workflow_local_supports_review_profile?: boolean | null;
  review_workflow_local_declared_inputs?: string[] | null;
  review_workflow_git_branch?: string | null;
  review_workflow_git_tracking_status?: string | null;
  review_workflow_local_git_file_status?: string | null;
  review_workflow_local_vs_origin_status?: string | null;
  review_workflow_sync_action?: string | null;
  review_workflow_sync_commands?: string[] | null;
}

export interface GitHubDispatchReceipt {
  workflow_name: string;
  repository: string;
  dispatched_at: string;
  command: string[];
  input_keys: string[];
  requested_review_profile?: TaskSpec["review_profile"] | null;
  dispatched_review_profile?: TaskSpec["review_profile"] | null;
  review_profile_dispatch_mode?: "native" | "legacy_without_input" | null;
  gh_cli_path: string | null;
  gh_authenticated: boolean;
  gh_exit_code: number | null;
  gh_stdout: string;
  gh_stderr: string;
  run: GitHubRunState | null;
  run_lookup: "stdout" | "list" | "unresolved";
}

export interface GitHubCallbackDownload {
  task_id: string;
  repository: string;
  download_dir: string;
  callback_path: string;
  artifact_name: string;
  run_id: number | null;
}

export interface GitHubMirrorPublishReceipt {
  repository: string;
  issue_command: string[] | null;
  issue_stdout: string;
  issue_stderr: string;
  issue_created: boolean;
  pr_command: string[] | null;
  pr_stdout: string;
  pr_stderr: string;
  pr_created: boolean;
  mirror: GitHubMirrorState;
}

export interface GitHubRepositoryStatus {
  repository: string;
  accessible: boolean;
  url: string | null;
  default_branch: string | null;
  viewer_permission: string | null;
  is_private: boolean | null;
  gh_cli_path: string | null;
  gh_authenticated: boolean;
  detail: string;
}

export interface GitHubPullRequestStatus {
  repository: string;
  found: boolean;
  number: number | null;
  url: string | null;
  title: string | null;
  head_branch: string | null;
  base_branch: string | null;
  gh_cli_path: string | null;
  gh_authenticated: boolean;
  detail: string;
}

export interface GitHubBranchStatus {
  repository: string;
  branch: string;
  found: boolean;
  sha: string | null;
  protected: boolean | null;
  gh_cli_path: string | null;
  gh_authenticated: boolean;
  detail: string;
}

export interface GitHubControlPlaneDeps {
  runCli?: (args: string[], options?: { input?: string }) => GitHubCliRunResult;
  findBinary?: (bin: string) => string | null;
  runProcess?: (command: string, args: string[]) => GitHubCliRunResult;
  platform?: NodeJS.Platform;
}

interface GitHubRunListEntry {
  databaseId: number;
  displayTitle?: string;
  event?: string;
  headBranch?: string;
  status?: string;
  conclusion?: string | null;
  url?: string;
  workflowName?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface GitHubActionsVariableResponse {
  name?: string;
  value?: string;
}

interface GitHubRunnerApiEntry {
  id?: number;
  name?: string;
  os?: string;
  status?: string;
  busy?: boolean;
  labels?: Array<{ name?: string }>;
}

interface GitHubRunViewJob {
  name?: string;
  status?: string;
  conclusion?: string | null;
  labels?: string[] | Array<{ name?: string }>;
}

interface GitHubRunViewResponse extends Partial<GitHubRunListEntry> {
  jobs?: GitHubRunViewJob[];
}

interface GitHubQueueDiagnosis {
  task_id: string;
  run_id: number;
  run_url: string | null;
  workflow_name: string;
  status: string;
  queued_for_ms: number;
  self_hosted_targeted: boolean;
  runs_on_labels: string[];
  matching_runners: GitHubRuntimeStatus["matching_runners"];
  queued_jobs: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    labels: string[];
  }>;
  runner_lookup_detail: string | null;
  likely_stalled: boolean;
  reason: string;
  suggested_action: string | null;
}

interface GitHubQueueRecoveryReceipt {
  task_id: string;
  run_id: number;
  attempted_at: string;
  diagnosis_reason: string;
  command: string[];
  executable: string | null;
  skipped: boolean;
  detail: string;
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

function parseRunsOnLabels(rawValue: string | null): string[] {
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean);
    }
  } catch {
    return [];
  }

  return [];
}

function omitReviewProfileInput(workflowInputs: Record<string, string>): Record<string, string> {
  const { review_profile: _ignored, ...rest } = workflowInputs;
  return rest;
}

function isUnexpectedReviewProfileInputError(detail: string): boolean {
  return /Unexpected inputs provided:\s*\[[^\]]*review_profile[^\]]*\]/i.test(detail);
}

function parseJsonOrNull<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizeLabelCollection(value: GitHubRunViewJob["labels"]): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => typeof entry === "string" ? entry : entry?.name ?? "")
    .map((label) => label.trim())
    .filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRunRefFromStdout(stdout: string, workflowName: string): GitHubRunState | null {
  const trimmed = stdout.trim();
  const match = trimmed.match(/actions\/runs\/(\d+)/i);
  if (!match) {
    return null;
  }

  const runId = Number(match[1]);
  if (!Number.isFinite(runId)) {
    return null;
  }

  const runUrl = trimmed.split(/\r?\n/).find((line) => /actions\/runs\/\d+/i.test(line.trim()))?.trim() ?? null;
  return {
    run_id: runId,
    run_url: runUrl,
    workflow_name: workflowName,
    status: "requested",
    conclusion: null,
    updated_at: Date.now()
  };
}

function parseGitHubUrl(stdout: string): string | null {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^https:\/\/github\.com\//i.test(line))
    ?? null;
}

function parseIssueNumber(url: string | null): number | null {
  if (!url) {
    return null;
  }
  const match = url.match(/\/issues\/(\d+)/i);
  return match ? Number(match[1]) : null;
}

function parsePullRequestNumber(url: string | null): number | null {
  if (!url) {
    return null;
  }
  const match = url.match(/\/pull\/(\d+)/i);
  return match ? Number(match[1]) : null;
}

function defaultRunCli(cliBinary: string, args: string[], options: { input?: string } = {}): GitHubCliRunResult {
  const startedAt = Date.now();
  const result = spawnSync(cliBinary, args, {
    encoding: "utf8",
    input: options.input
  });
  return {
    ok: result.status === 0 && !result.error,
    exitCode: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: result.error ? `${String(result.stderr ?? "")}\n${result.error.message}`.trim() : String(result.stderr ?? ""),
    durationMs: Date.now() - startedAt,
    timedOut: Boolean(result.signal)
  };
}

export class GitHubControlPlane {
  private readonly runCli: (args: string[], options?: { input?: string }) => GitHubCliRunResult;
  private readonly findBinary: (bin: string) => string | null;
  private readonly runProcess: (command: string, args: string[]) => GitHubCliRunResult;
  private readonly platform: NodeJS.Platform;

  constructor(
    private readonly config: CodexHeadConfig,
    private readonly artifactStore: FileArtifactStore,
    deps: GitHubControlPlaneDeps = {}
  ) {
    this.runCli = deps.runCli ?? ((args, options) => defaultRunCli(this.config.github.cli_binary, args, options));
    this.findBinary = deps.findBinary ?? findInstalledBinary;
    this.runProcess = deps.runProcess ?? ((command, args) => defaultRunCli(command, args));
    this.platform = deps.platform ?? process.platform;
  }

  isEnabled(): boolean {
    return this.config.github.enabled;
  }

  shouldDispatchLive(): boolean {
    return this.config.github.enabled && this.config.github.dispatch_mode === "gh_cli";
  }

  inspectRuntime(): GitHubRuntimeStatus {
    const ghCliPath = this.findBinary(this.config.github.cli_binary);
    const ghCliAvailable = Boolean(ghCliPath);
    const auth = ghCliAvailable ? this.runCli(["auth", "status"]) : null;
    const recycleScriptPath = join(this.config.app_root, "scripts", "recycle-self-hosted-runner.ps1");
    const machineConfigCandidate = process.env.CODEX_HEAD_MACHINE_CONFIG?.trim()
      || join(this.config.app_root, "config", "workers.machine.json");
    const machineConfigPath = machineConfigCandidate && existsSync(machineConfigCandidate)
      ? machineConfigCandidate
      : null;
    let runsOnJson: string | null = null;
    let runsOnLabels: string[] = [];
    let matchingRunners: GitHubRuntimeStatus["matching_runners"] = [];
    let runnerLookupDetail: string | null = null;
    let reviewWorkflowSupportsReviewProfile: boolean | null = null;
    let reviewWorkflowInputCheckDetail: string | null = null;
    let reviewWorkflowDeclaredInputs: string[] | null = null;
    let reviewWorkflowMissingDispatchInputs: string[] | null = null;

    if (
      this.config.github.enabled
      && ghCliAvailable
      && auth?.ok
      && this.config.github.repository
      && this.config.github.repository !== "OWNER/REPO"
    ) {
      try {
        const variableResult = this.runCli([
          "api",
          `repos/${this.config.github.repository}/actions/variables/CODEX_HEAD_RUNS_ON_JSON`
        ]);

        if (variableResult.ok) {
          const parsedVariable = parseJsonOrNull<GitHubActionsVariableResponse>(variableResult.stdout || "");
          if (parsedVariable) {
            runsOnJson = typeof parsedVariable.value === "string" ? parsedVariable.value : null;
            runsOnLabels = parseRunsOnLabels(runsOnJson);
          } else {
            runnerLookupDetail = "unable to parse CODEX_HEAD_RUNS_ON_JSON response";
          }
        } else {
          runnerLookupDetail = variableResult.stderr.trim() || variableResult.stdout.trim() || "unable to query CODEX_HEAD_RUNS_ON_JSON";
        }
      } catch (error) {
        runnerLookupDetail = error instanceof Error ? error.message : String(error);
      }

      if (runsOnLabels.includes("self-hosted")) {
        try {
          const runnersResult = this.runCli([
            "api",
            `repos/${this.config.github.repository}/actions/runners`
          ]);

          if (runnersResult.ok) {
            const parsedRunners = parseJsonOrNull<{ runners?: GitHubRunnerApiEntry[] }>(runnersResult.stdout || "");
            if (parsedRunners) {
              const targetLabels = runsOnLabels.map((label) => label.toLowerCase());
              matchingRunners = (parsedRunners.runners ?? [])
                .map((runner) => {
                  const labels = (runner.labels ?? [])
                    .map((label) => label.name?.trim() ?? "")
                    .filter(Boolean);
                  const normalizedLabels = labels.map((label) => label.toLowerCase());
                  const matchesTargetLabels = targetLabels.every((label) => normalizedLabels.includes(label));
                  return {
                    id: Number(runner.id ?? 0),
                    name: String(runner.name ?? ""),
                    os: String(runner.os ?? ""),
                    status: String(runner.status ?? "unknown"),
                    busy: Boolean(runner.busy),
                    labels,
                    matches_target_labels: matchesTargetLabels
                  };
                })
                .filter((runner) => runner.name.length > 0 && runner.matches_target_labels);
            } else {
              runnerLookupDetail = "unable to parse self-hosted runner response";
            }
          } else {
            runnerLookupDetail = runnersResult.stderr.trim() || runnersResult.stdout.trim() || "unable to query self-hosted runners";
          }
        } catch (error) {
          runnerLookupDetail = error instanceof Error ? error.message : String(error);
        }
      }

      if (this.config.github.review_workflow) {
        try {
          const workflowViewResult = this.runCli([
            "workflow",
            "view",
            this.config.github.review_workflow,
            "-R",
            this.config.github.repository,
            "--yaml"
          ]);

          if (workflowViewResult.ok) {
            const workflowYaml = workflowViewResult.stdout || "";
            reviewWorkflowDeclaredInputs = extractWorkflowDispatchInputs(workflowYaml);
            reviewWorkflowSupportsReviewProfile = reviewWorkflowDeclaredInputs.includes("review_profile");
            if (!reviewWorkflowSupportsReviewProfile) {
              reviewWorkflowMissingDispatchInputs = ["review_profile"];
              reviewWorkflowInputCheckDetail =
                `Remote review workflow ${this.config.github.review_workflow} does not declare workflow_dispatch input review_profile.`;
            } else {
              reviewWorkflowMissingDispatchInputs = [];
            }
          } else {
            reviewWorkflowInputCheckDetail = workflowViewResult.stderr.trim()
              || workflowViewResult.stdout.trim()
              || `Unable to inspect remote workflow ${this.config.github.review_workflow}.`;
          }
        } catch (error) {
          reviewWorkflowInputCheckDetail = error instanceof Error ? error.message : String(error);
        }
      }
    }

    const localReviewWorkflowDrift = inspectLocalReviewWorkflowDrift(
      this.config.app_root,
      this.config.github.review_workflow,
      reviewWorkflowDeclaredInputs ?? []
    );

    return {
      enabled: this.config.github.enabled,
      dispatch_mode: this.config.github.dispatch_mode,
      execution_preference: this.config.github.execution_preference,
      auto_recycle_stale_runner: this.config.github.auto_recycle_stale_runner,
      repository: this.config.github.repository,
      workflow: this.config.github.workflow,
      review_workflow: this.config.github.review_workflow,
      cli_binary: this.config.github.cli_binary,
      gh_cli_available: ghCliAvailable,
      gh_cli_path: ghCliPath,
      gh_authenticated: Boolean(auth?.ok),
      machine_config_path: machineConfigPath,
      machine_config_exists: Boolean(machineConfigPath),
      runs_on_json: runsOnJson,
      runs_on_labels: runsOnLabels,
      self_hosted_targeted: runsOnLabels.includes("self-hosted"),
      recycle_script_path: recycleScriptPath,
      recycle_script_available: existsSync(recycleScriptPath),
      matching_runners: matchingRunners,
      runner_lookup_detail: runnerLookupDetail,
      review_workflow_supports_review_profile: reviewWorkflowSupportsReviewProfile,
      review_workflow_input_check_detail: reviewWorkflowInputCheckDetail,
      review_workflow_declared_inputs: reviewWorkflowDeclaredInputs,
      review_workflow_missing_dispatch_inputs: reviewWorkflowMissingDispatchInputs,
      review_workflow_local_path: localReviewWorkflowDrift.local_workflow_path,
      review_workflow_local_supports_review_profile: localReviewWorkflowDrift.local_supports_review_profile,
      review_workflow_local_declared_inputs: localReviewWorkflowDrift.local_declared_inputs,
      review_workflow_git_branch: localReviewWorkflowDrift.git_branch,
      review_workflow_git_tracking_status: localReviewWorkflowDrift.git_tracking_status,
      review_workflow_local_git_file_status: localReviewWorkflowDrift.local_git_file_status,
      review_workflow_local_vs_origin_status: localReviewWorkflowDrift.local_vs_origin_status,
      review_workflow_sync_action: localReviewWorkflowDrift.sync_action,
      review_workflow_sync_commands: localReviewWorkflowDrift.sync_commands
    };
  }

  verifyRepositoryAccess(repository = this.config.github.repository): GitHubRepositoryStatus {
    const runtime = this.inspectRuntime();
    if (!runtime.enabled) {
      return {
        repository,
        accessible: false,
        url: null,
        default_branch: null,
        viewer_permission: null,
        is_private: null,
        gh_cli_path: runtime.gh_cli_path,
        gh_authenticated: runtime.gh_authenticated,
        detail: "GitHub control plane is disabled"
      };
    }
    if (!runtime.gh_cli_available) {
      return {
        repository,
        accessible: false,
        url: null,
        default_branch: null,
        viewer_permission: null,
        is_private: null,
        gh_cli_path: runtime.gh_cli_path,
        gh_authenticated: runtime.gh_authenticated,
        detail: `GitHub repository validation requires ${this.config.github.cli_binary} to be installed`
      };
    }
    if (!runtime.gh_authenticated) {
      return {
        repository,
        accessible: false,
        url: null,
        default_branch: null,
        viewer_permission: null,
        is_private: null,
        gh_cli_path: runtime.gh_cli_path,
        gh_authenticated: runtime.gh_authenticated,
        detail: `GitHub repository validation requires ${this.config.github.cli_binary} authentication`
      };
    }
    if (!repository || repository === "OWNER/REPO") {
      return {
        repository,
        accessible: false,
        url: null,
        default_branch: null,
        viewer_permission: null,
        is_private: null,
        gh_cli_path: runtime.gh_cli_path,
        gh_authenticated: runtime.gh_authenticated,
        detail: "GitHub repository validation requires a real OWNER/REPO value"
      };
    }

    const args = [
      "repo",
      "view",
      repository,
      "--json",
      "nameWithOwner,url,defaultBranchRef,viewerPermission,isPrivate"
    ];
    const result = this.runCli(args);
    if (!result.ok) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.exitCode)}`;
      return {
        repository,
        accessible: false,
        url: null,
        default_branch: null,
        viewer_permission: null,
        is_private: null,
        gh_cli_path: runtime.gh_cli_path,
        gh_authenticated: runtime.gh_authenticated,
        detail
      };
    }

    const parsed = JSON.parse(result.stdout || "{}") as {
      nameWithOwner?: string;
      url?: string;
      defaultBranchRef?: { name?: string } | null;
      viewerPermission?: string | null;
      isPrivate?: boolean | null;
    };
    return {
      repository: parsed.nameWithOwner ?? repository,
      accessible: true,
      url: parsed.url ?? null,
      default_branch: parsed.defaultBranchRef?.name ?? null,
      viewer_permission: parsed.viewerPermission ?? null,
      is_private: parsed.isPrivate ?? null,
      gh_cli_path: runtime.gh_cli_path,
      gh_authenticated: runtime.gh_authenticated,
      detail: "ok"
    };
  }

  findLatestPullRequest(repository = this.config.github.repository): GitHubPullRequestStatus {
    const runtime = this.inspectRuntime();
    if (!runtime.enabled) {
      return {
        repository,
        found: false,
        number: null,
        url: null,
        title: null,
        head_branch: null,
        base_branch: null,
        gh_cli_path: runtime.gh_cli_path,
        gh_authenticated: runtime.gh_authenticated,
        detail: "GitHub control plane is disabled"
      };
    }
    if (!runtime.gh_cli_available) {
      return {
        repository,
        found: false,
        number: null,
        url: null,
        title: null,
        head_branch: null,
        base_branch: null,
        gh_cli_path: runtime.gh_cli_path,
        gh_authenticated: runtime.gh_authenticated,
        detail: `GitHub pull request lookup requires ${this.config.github.cli_binary} to be installed`
      };
    }
    if (!runtime.gh_authenticated) {
      return {
        repository,
        found: false,
        number: null,
        url: null,
        title: null,
        head_branch: null,
        base_branch: null,
        gh_cli_path: runtime.gh_cli_path,
        gh_authenticated: runtime.gh_authenticated,
        detail: `GitHub pull request lookup requires ${this.config.github.cli_binary} authentication`
      };
    }
    if (!repository || repository === "OWNER/REPO") {
      return {
        repository,
        found: false,
        number: null,
        url: null,
        title: null,
        head_branch: null,
        base_branch: null,
        gh_cli_path: runtime.gh_cli_path,
        gh_authenticated: runtime.gh_authenticated,
        detail: "GitHub pull request lookup requires a real OWNER/REPO value"
      };
    }

    const args = [
      "pr",
      "list",
      "--repo",
      repository,
      "--state",
      "open",
      "--limit",
      "1",
      "--json",
      "number,url,title,headRefName,baseRefName"
    ];
    const result = this.runCli(args);
    if (!result.ok) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.exitCode)}`;
      return {
        repository,
        found: false,
        number: null,
        url: null,
        title: null,
        head_branch: null,
        base_branch: null,
        gh_cli_path: runtime.gh_cli_path,
        gh_authenticated: runtime.gh_authenticated,
        detail
      };
    }

    const parsed = parseJsonOrNull<Array<{
      number?: number;
      url?: string | null;
      title?: string | null;
      headRefName?: string | null;
      baseRefName?: string | null;
    }>>(result.stdout) ?? [];
    const latest = Array.isArray(parsed) ? parsed[0] : null;
    if (!latest) {
      return {
        repository,
        found: false,
        number: null,
        url: null,
        title: null,
        head_branch: null,
        base_branch: null,
        gh_cli_path: runtime.gh_cli_path,
        gh_authenticated: runtime.gh_authenticated,
        detail: `No open pull request is available in ${repository}`
      };
    }

    return {
      repository,
      found: true,
      number: latest.number ?? null,
      url: latest.url ?? null,
      title: latest.title ?? null,
      head_branch: latest.headRefName ?? null,
      base_branch: latest.baseRefName ?? null,
      gh_cli_path: runtime.gh_cli_path,
      gh_authenticated: runtime.gh_authenticated,
      detail: "ok"
    };
  }

  findRemoteBranch(
    branch: string,
    repository = this.config.github.repository
  ): GitHubBranchStatus {
    const runtime = this.inspectRuntime();
    if (!runtime.enabled) {
      return {
        repository,
        branch,
        found: false,
        sha: null,
        protected: null,
        gh_cli_path: runtime.gh_cli_path,
        gh_authenticated: runtime.gh_authenticated,
        detail: "GitHub control plane is disabled"
      };
    }
    if (!runtime.gh_cli_available) {
      return {
        repository,
        branch,
        found: false,
        sha: null,
        protected: null,
        gh_cli_path: runtime.gh_cli_path,
        gh_authenticated: runtime.gh_authenticated,
        detail: `GitHub branch lookup requires ${this.config.github.cli_binary} to be installed`
      };
    }
    if (!runtime.gh_authenticated) {
      return {
        repository,
        branch,
        found: false,
        sha: null,
        protected: null,
        gh_cli_path: runtime.gh_cli_path,
        gh_authenticated: runtime.gh_authenticated,
        detail: `GitHub branch lookup requires ${this.config.github.cli_binary} authentication`
      };
    }
    if (!repository || repository === "OWNER/REPO") {
      return {
        repository,
        branch,
        found: false,
        sha: null,
        protected: null,
        gh_cli_path: runtime.gh_cli_path,
        gh_authenticated: runtime.gh_authenticated,
        detail: "GitHub branch lookup requires a real OWNER/REPO value"
      };
    }

    const encodedBranch = encodeURIComponent(branch);
    const result = this.runCli([
      "api",
      `repos/${repository}/branches/${encodedBranch}`
    ]);
    if (!result.ok) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.exitCode)}`;
      return {
        repository,
        branch,
        found: false,
        sha: null,
        protected: null,
        gh_cli_path: runtime.gh_cli_path,
        gh_authenticated: runtime.gh_authenticated,
        detail: /404|not found/i.test(detail)
          ? `Remote branch '${branch}' was not found in ${repository}`
          : detail
      };
    }

    const parsed = parseJsonOrNull<{
      name?: string;
      protected?: boolean | null;
      commit?: { sha?: string | null } | null;
    }>(result.stdout) ?? {};
    return {
      repository,
      branch: parsed.name ?? branch,
      found: true,
      sha: parsed.commit?.sha ?? null,
      protected: typeof parsed.protected === "boolean" ? parsed.protected : null,
      gh_cli_path: runtime.gh_cli_path,
      gh_authenticated: runtime.gh_authenticated,
      detail: "ok"
    };
  }

  prepareDispatch(task: TaskSpec, routing: RoutingDecision): GitHubDispatchInfo {
    const workflowName = this.selectWorkflow(task);
    const payload = {
      repository: this.config.github.repository,
      workflow: workflowName,
      task,
      routing
    };
    const workflowInputs = this.buildWorkflowInputs(task, routing, workflowName, payload);

    const issuePath = this.artifactStore.writeText(
      task.task_id,
      "github-issue.md",
      [
        "# Codex Head Task Mirror",
        "",
        `- task_id: ${task.task_id}`,
        `- worker_target: ${routing.worker_target}`,
        `- repo: ${task.repo}`,
        `- branch: ${task.work_branch}`,
        `- goal: ${task.goal}`
      ].join("\n")
    );

    const prPath = task.expected_output.code_change
      ? this.artifactStore.writeText(
          task.task_id,
          "github-pr.md",
          `# PR Draft\n\nTask ${task.task_id}\n\nGoal: ${task.goal}\n`
        )
      : null;

    const payloadPath = this.artifactStore.writeJson(task.task_id, "github-dispatch.json", payload);
    const workflowInputsPath = this.artifactStore.writeJson(task.task_id, "github-worker-inputs.json", workflowInputs);

    return {
      workflow_name: workflowName,
      payload_path: payloadPath,
      workflow_inputs_path: workflowInputsPath,
      issue_path: issuePath,
      pr_path: prPath
    };
  }

  publishMirror(
    task: TaskSpec,
    dispatch: GitHubDispatchInfo,
    existingMirror: GitHubMirrorState | null = null
  ): GitHubMirrorPublishReceipt {
    const runtime = this.inspectRuntime();
    if (!runtime.enabled) {
      throw new Error("GitHub control plane is disabled");
    }
    if (!runtime.gh_cli_available) {
      throw new Error(`GitHub mirror publish requires ${this.config.github.cli_binary} to be installed`);
    }
    if (!runtime.gh_authenticated) {
      throw new Error(`GitHub mirror publish requires ${this.config.github.cli_binary} authentication`);
    }
    if (!this.config.github.repository || this.config.github.repository === "OWNER/REPO") {
      throw new Error("GitHub mirror publish requires github.repository to be configured");
    }

    const issueTitle = `Codex Head task ${task.task_id}: ${task.goal}`;
    const prTitle = `Codex Head: ${task.goal}`;
    let issue = existingMirror?.issue ?? null;
    let pullRequest = existingMirror?.pull_request ?? null;
    let issueError = existingMirror?.issue_error ?? null;
    let pullRequestError = existingMirror?.pull_request_error ?? null;
    let issueCommand: string[] | null = null;
    let prCommand: string[] | null = null;
    let issueStdout = "";
    let issueStderr = "";
    let prStdout = "";
    let prStderr = "";
    let issueCreated = false;
    let prCreated = false;

    if (!issue) {
      issueCommand = [
        this.config.github.cli_binary,
        "issue",
        "create",
        "--repo",
        this.config.github.repository,
        "--title",
        issueTitle,
        "--body-file",
        dispatch.issue_path
      ];
      const result = this.runCli(issueCommand.slice(1));
      issueStdout = result.stdout.trim();
      issueStderr = result.stderr.trim();
      if (!result.ok) {
        const detail = issueStderr || issueStdout || `exit code ${String(result.exitCode)}`;
        throw new Error(`GitHub issue mirror publish failed: ${detail}`);
      }

      const issueUrl = parseGitHubUrl(issueStdout);
      issue = {
        number: parseIssueNumber(issueUrl),
        url: issueUrl ?? "",
        title: issueTitle
      };
      issueError = null;
      issueCreated = true;
    }

    const shouldPublishPullRequest = Boolean(dispatch.pr_path)
      && (task.artifact_policy.mode === "branch_pr" || task.expected_output.kind === "pull_request");
    if (shouldPublishPullRequest && !pullRequest && dispatch.pr_path) {
      prCommand = [
        this.config.github.cli_binary,
        "pr",
        "create",
        "--repo",
        this.config.github.repository,
        "--base",
        task.base_branch,
        "--head",
        task.work_branch,
        "--title",
        prTitle,
        "--body-file",
        dispatch.pr_path,
        "--draft"
      ];
      const result = this.runCli(prCommand.slice(1));
      prStdout = result.stdout.trim();
      prStderr = result.stderr.trim();
      if (result.ok) {
        const prUrl = parseGitHubUrl(prStdout);
        pullRequest = {
          number: parsePullRequestNumber(prUrl),
          url: prUrl ?? "",
          title: prTitle
        };
        pullRequestError = null;
        prCreated = true;
      } else {
        pullRequestError = prStderr || prStdout || `exit code ${String(result.exitCode)}`;
      }
    }

    const mirror: GitHubMirrorState = {
      issue,
      pull_request: pullRequest,
      issue_error: issueError,
      pull_request_error: pullRequestError,
      updated_at: Date.now()
    };

    return {
      repository: this.config.github.repository,
      issue_command: issueCommand,
      issue_stdout: issueStdout,
      issue_stderr: issueStderr,
      issue_created: issueCreated,
      pr_command: prCommand,
      pr_stdout: prStdout,
      pr_stderr: prStderr,
      pr_created: prCreated,
      mirror
    };
  }

  dispatchWorkflow(task: TaskSpec, routing: RoutingDecision, dispatch: GitHubDispatchInfo): GitHubDispatchReceipt {
    const runtime = this.inspectRuntime();
    if (!runtime.enabled) {
      throw new Error("GitHub control plane is disabled");
    }
    if (!this.shouldDispatchLive()) {
      throw new Error("GitHub live dispatch is not enabled");
    }
    if (!runtime.gh_cli_available) {
      throw new Error(`GitHub live dispatch requires ${this.config.github.cli_binary} to be installed`);
    }
    if (!runtime.gh_authenticated) {
      throw new Error(`GitHub live dispatch requires ${this.config.github.cli_binary} authentication`);
    }
    if (!this.config.github.repository || this.config.github.repository === "OWNER/REPO") {
      throw new Error("GitHub live dispatch requires github.repository to be configured");
    }

    const payload = {
      repository: this.config.github.repository,
      workflow: dispatch.workflow_name,
      task,
      routing
    };
    const requestedReviewProfile = task.review_profile ?? "standard";
    let workflowInputs = this.buildWorkflowInputs(task, routing, dispatch.workflow_name, payload);
    let reviewProfileDispatchMode: GitHubDispatchReceipt["review_profile_dispatch_mode"] =
      dispatch.workflow_name === this.config.github.review_workflow && workflowInputs.review_profile
        ? "native"
        : null;

    if (
      dispatch.workflow_name === this.config.github.review_workflow
      && runtime.review_workflow_supports_review_profile === false
      && workflowInputs.review_profile
    ) {
      workflowInputs = omitReviewProfileInput(workflowInputs);
      reviewProfileDispatchMode = "legacy_without_input";
      this.artifactStore.writeJson(task.task_id, "github-workflow-inputs.json", workflowInputs);
    }

    const args = [
      "workflow",
      "run",
      dispatch.workflow_name,
      "--repo",
      this.config.github.repository,
      "--ref",
      task.base_branch,
      "--json"
    ];
    let result = this.runCli(args, {
      input: JSON.stringify(workflowInputs)
    });

    const initialDispatchDetail = `${result.stderr.trim()} ${result.stdout.trim()}`.trim();
    if (
      !result.ok
      && dispatch.workflow_name === this.config.github.review_workflow
      && workflowInputs.review_profile
      && isUnexpectedReviewProfileInputError(initialDispatchDetail)
    ) {
      workflowInputs = omitReviewProfileInput(workflowInputs);
      reviewProfileDispatchMode = "legacy_without_input";
      this.artifactStore.writeJson(task.task_id, "github-workflow-inputs.json", workflowInputs);
      result = this.runCli(args, {
        input: JSON.stringify(workflowInputs)
      });
    }

    const receipt: GitHubDispatchReceipt = {
      workflow_name: dispatch.workflow_name,
      repository: this.config.github.repository,
      dispatched_at: new Date().toISOString(),
      command: [this.config.github.cli_binary, ...args],
      input_keys: Object.keys(workflowInputs),
      requested_review_profile: dispatch.workflow_name === this.config.github.review_workflow
        ? requestedReviewProfile
        : null,
      dispatched_review_profile: dispatch.workflow_name === this.config.github.review_workflow
        ? ((workflowInputs.review_profile as TaskSpec["review_profile"] | undefined) ?? null)
        : null,
      review_profile_dispatch_mode: reviewProfileDispatchMode,
      gh_cli_path: runtime.gh_cli_path,
      gh_authenticated: runtime.gh_authenticated,
      gh_exit_code: result.exitCode,
      gh_stdout: result.stdout.trim(),
      gh_stderr: result.stderr.trim(),
      run: null,
      run_lookup: "unresolved"
    };

    if (!result.ok) {
      this.artifactStore.writeJson(task.task_id, "github-dispatch-receipt.json", receipt);
      const detail = receipt.gh_stderr || receipt.gh_stdout || `exit code ${String(receipt.gh_exit_code)}`;
      throw new Error(`GitHub workflow dispatch failed: ${detail}`);
    }

    const directRun = parseRunRefFromStdout(receipt.gh_stdout, dispatch.workflow_name);
    if (directRun) {
      receipt.run = directRun;
      receipt.run_lookup = "stdout";
    } else {
      const listedRun = this.resolveTaskRun(task, dispatch.workflow_name);
      if (listedRun) {
        receipt.run = listedRun;
        receipt.run_lookup = "list";
      }
    }

    this.artifactStore.writeJson(task.task_id, "github-dispatch-receipt.json", receipt);
    return receipt;
  }

  resolveTaskRun(task: TaskSpec, workflowName?: string): GitHubRunState | null {
    const runtime = this.inspectRuntime();
    if (!runtime.enabled || !runtime.gh_cli_available || !runtime.gh_authenticated) {
      return null;
    }
    if (!this.config.github.repository || this.config.github.repository === "OWNER/REPO") {
      return null;
    }

    const selectedWorkflow = workflowName ?? this.selectWorkflow(task);
    const args = [
      "run",
      "list",
      "--repo",
      this.config.github.repository,
      "--workflow",
      selectedWorkflow,
      "--branch",
      task.base_branch,
      "--event",
      "workflow_dispatch",
      "--limit",
      "20",
      "--json",
      "databaseId,displayTitle,event,headBranch,status,conclusion,url,workflowName,createdAt,updatedAt"
    ];
    const result = this.runCli(args);
    if (!result.ok) {
      return null;
    }

    let runs: GitHubRunListEntry[];
    try {
      runs = JSON.parse(result.stdout || "[]") as GitHubRunListEntry[];
    } catch {
      return null;
    }

    const exactTitle = `codex-head task ${task.task_id}`;
    const matched = runs
      .filter((run) =>
        run.workflowName === selectedWorkflow
        && run.event === "workflow_dispatch"
        && run.headBranch === task.base_branch
        && (
          run.displayTitle === exactTitle
          || run.displayTitle?.includes(task.task_id)
          || false
        )
      )
      .sort((left, right) => {
        const leftTime = Date.parse(left.createdAt ?? "") || 0;
        const rightTime = Date.parse(right.createdAt ?? "") || 0;
        return rightTime - leftTime;
      })[0];

    if (!matched || !Number.isFinite(matched.databaseId)) {
      return null;
    }

    return {
      run_id: matched.databaseId,
      run_url: matched.url ?? null,
      workflow_name: matched.workflowName ?? selectedWorkflow,
      status: matched.status ?? "requested",
      conclusion: matched.conclusion ?? null,
      updated_at: Date.parse(matched.updatedAt ?? matched.createdAt ?? "") || Date.now()
    };
  }

  inspectRun(taskId: string, runId: number): GitHubRunState {
    const runtime = this.inspectRuntime();
    if (!runtime.enabled) {
      throw new Error("GitHub control plane is disabled");
    }
    if (!runtime.gh_cli_available) {
      throw new Error(`GitHub run inspection requires ${this.config.github.cli_binary} to be installed`);
    }
    if (!runtime.gh_authenticated) {
      throw new Error(`GitHub run inspection requires ${this.config.github.cli_binary} authentication`);
    }
    if (!this.config.github.repository || this.config.github.repository === "OWNER/REPO") {
      throw new Error("GitHub run inspection requires github.repository to be configured");
    }

    const args = [
      "run",
      "view",
      String(runId),
      "--repo",
      this.config.github.repository,
      "--json",
      "databaseId,status,conclusion,url,workflowName,updatedAt"
    ];
    const result = this.runCli(args);
    this.artifactStore.writeJson(taskId, "github-run-view.json", {
      run_id: runId,
      repository: this.config.github.repository,
      command: [this.config.github.cli_binary, ...args],
      gh_exit_code: result.exitCode,
      gh_stdout: result.stdout.trim(),
      gh_stderr: result.stderr.trim()
    });
    if (!result.ok) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.exitCode)}`;
      throw new Error(`GitHub run status lookup failed: ${detail}`);
    }

    const parsed = JSON.parse(result.stdout || "{}") as Partial<GitHubRunListEntry>;
    return {
      run_id: Number(parsed.databaseId ?? runId),
      run_url: parsed.url ?? null,
      workflow_name: parsed.workflowName ?? "unknown",
      status: parsed.status ?? "unknown",
      conclusion: parsed.conclusion ?? null,
      updated_at: Date.parse(parsed.updatedAt ?? "") || Date.now()
    };
  }

  diagnoseQueuedRunIfPresent(taskId: string, runId: number, queuedForMs = 0): GitHubQueueDiagnosis | null {
    try {
      const runState = this.inspectRun(taskId, runId);
      if (runState.status.trim().toLowerCase() !== "queued") {
        return null;
      }
      return this.diagnoseQueuedRun(taskId, runId, runState, queuedForMs);
    } catch {
      return null;
    }
  }

  async waitForRunCompletion(taskId: string, runId: number, timeoutMs = 300_000, intervalMs = 5_000): Promise<GitHubRunState> {
    const runtime = this.inspectRuntime();
    if (!runtime.enabled) {
      throw new Error("GitHub control plane is disabled");
    }
    if (!runtime.gh_cli_available) {
      throw new Error(`GitHub run wait requires ${this.config.github.cli_binary} to be installed`);
    }
    if (!runtime.gh_authenticated) {
      throw new Error(`GitHub run wait requires ${this.config.github.cli_binary} authentication`);
    }
    if (!this.config.github.repository || this.config.github.repository === "OWNER/REPO") {
      throw new Error("GitHub run wait requires github.repository to be configured");
    }

    let deadline = Date.now() + Math.max(1, timeoutMs);
    let monitoredSince = Date.now();
    let recycleAttempted = false;
    let recycleSucceeded = false;
    const queueDiagnosisThresholdMs = Math.min(60_000, Math.max(intervalMs * 3, Math.floor(timeoutMs / 3)));
    let lastState: GitHubRunState | null = null;
    let lastQueueDiagnosis: GitHubQueueDiagnosis | null = null;
    while (Date.now() <= deadline) {
      lastState = this.inspectRun(taskId, runId);
      if (lastState.status === "queued" && Date.now() - monitoredSince >= queueDiagnosisThresholdMs) {
        lastQueueDiagnosis = this.diagnoseQueuedRun(taskId, runId, lastState, Date.now() - monitoredSince);
        if (lastQueueDiagnosis.likely_stalled) {
          if (!recycleAttempted && this.shouldAutoRecycleQueuedStall(lastQueueDiagnosis)) {
            const recycleReceipt = this.attemptQueuedStallRecovery(taskId, runId, lastQueueDiagnosis);
            recycleAttempted = true;
            if (recycleReceipt.ok) {
              recycleSucceeded = true;
              monitoredSince = Date.now();
              const recycleGraceMs = Math.min(
                30_000,
                Math.max(intervalMs * 4, queueDiagnosisThresholdMs * 2, 1_000)
              );
              deadline = Math.max(deadline, monitoredSince + recycleGraceMs);
              lastQueueDiagnosis = null;
              continue;
            }
            throw new Error(
              `GitHub run ${runId} appears stuck in queued state for task ${taskId}: ${lastQueueDiagnosis.reason}`
              + this.renderQueueDiagnosisHint(taskId, lastQueueDiagnosis)
              + this.renderQueueRecoveryHint(taskId, recycleReceipt)
            );
          }
          throw new Error(
            `GitHub run ${runId} appears stuck in queued state for task ${taskId}: ${lastQueueDiagnosis.reason}`
            + this.renderQueueDiagnosisHint(taskId, lastQueueDiagnosis)
            + (recycleSucceeded ? this.renderQueueEscalationHint(taskId) : "")
          );
        }
      }
      if (lastState.status === "completed") {
        return lastState;
      }

      await sleep(Math.max(1, intervalMs));
    }

    if (lastState?.status === "queued") {
      lastQueueDiagnosis = lastQueueDiagnosis
        ?? this.diagnoseQueuedRun(taskId, runId, lastState, Date.now() - monitoredSince);
    }

    throw new Error(
      `Timed out waiting for GitHub callback for task ${taskId} after ${Math.ceil(timeoutMs / 1000)}s`
      + (lastState ? ` (last status: ${lastState.status})` : "")
      + (lastQueueDiagnosis ? ` (${lastQueueDiagnosis.reason})${this.renderQueueDiagnosisHint(taskId, lastQueueDiagnosis)}` : "")
      + (recycleSucceeded ? this.renderQueueEscalationHint(taskId) : "")
    );
  }

  downloadCallbackArtifact(taskId: string, options: { run_id?: number | null } = {}): GitHubCallbackDownload {
    const runtime = this.inspectRuntime();
    if (!runtime.enabled) {
      throw new Error("GitHub control plane is disabled");
    }
    if (!runtime.gh_cli_available) {
      throw new Error(`GitHub callback sync requires ${this.config.github.cli_binary} to be installed`);
    }
    if (!runtime.gh_authenticated) {
      throw new Error(`GitHub callback sync requires ${this.config.github.cli_binary} authentication`);
    }
    if (!this.config.github.repository || this.config.github.repository === "OWNER/REPO") {
      throw new Error("GitHub callback sync requires github.repository to be configured");
    }

    const downloadDir = join(this.artifactStore.getTaskDir(taskId), "github-download");
    rmSync(downloadDir, { recursive: true, force: true });
    mkdirSync(downloadDir, { recursive: true });

    const artifactNames = [
      `codex-head-github-callback-${taskId}`,
      `codex-head-worker-callback-${taskId}`
    ];
    const args = [
      "run",
      "download"
    ];
    if (options.run_id !== undefined && options.run_id !== null) {
      args.push(String(options.run_id));
    }
    args.push(
      "--repo",
      this.config.github.repository,
      "--dir",
      downloadDir,
      ...artifactNames.flatMap((name) => ["--name", name])
    );
    const result = this.runCli(args);
    const receiptPath = this.artifactStore.writeJson(taskId, "github-callback-download.json", {
      task_id: taskId,
      repository: this.config.github.repository,
      run_id: options.run_id ?? null,
      command: [this.config.github.cli_binary, ...args],
      gh_cli_path: runtime.gh_cli_path,
      gh_authenticated: runtime.gh_authenticated,
      gh_exit_code: result.exitCode,
      gh_stdout: result.stdout.trim(),
      gh_stderr: result.stderr.trim()
    });

    if (!result.ok) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.exitCode)}`;
      const queueDiagnosis = options.run_id !== undefined && options.run_id !== null
        ? this.diagnoseQueuedRunIfPresent(taskId, options.run_id)
        : null;
      throw new Error(
        `GitHub callback download failed: ${detail}`
        + (queueDiagnosis ? this.renderQueueDiagnosisHint(taskId, queueDiagnosis) : "")
        + (this.hasSuccessfulQueueRecycle(taskId) ? this.renderQueueEscalationHint(taskId) : "")
      );
    }

    const callbackPath = this.findDownloadedCallback(downloadDir);
    if (!callbackPath) {
      throw new Error(`GitHub callback download succeeded but no github-callback.json was found. See ${receiptPath}`);
    }
    const stableCallbackPath = this.buildCompletionEnvelope(taskId);
    copyFileSync(callbackPath, stableCallbackPath);

    const artifactName = artifactNames.find((name) => existsSync(join(downloadDir, name, "github-callback.json")))
      ?? artifactNames.find((name) => existsSync(join(downloadDir, "github-callback.json")))
      ?? "unknown";

    return {
      task_id: taskId,
      repository: this.config.github.repository,
      download_dir: downloadDir,
      callback_path: stableCallbackPath,
      artifact_name: artifactName,
      run_id: options.run_id ?? null
    };
  }

  buildCompletionEnvelope(result: Pick<WorkerResult, "task_id"> | string): string {
    const taskId = typeof result === "string" ? result : result.task_id;
    return join(this.artifactStore.getTaskDir(taskId), "github-callback.json");
  }

  private diagnoseQueuedRun(
    taskId: string,
    runId: number,
    runState: GitHubRunState,
    queuedForMs: number
  ): GitHubQueueDiagnosis {
    const runtime = this.inspectRuntime();
    let runView: GitHubRunViewResponse | null = null;

    if (runtime.enabled && runtime.gh_cli_available && runtime.gh_authenticated && this.config.github.repository !== "OWNER/REPO") {
      const args = [
        "run",
        "view",
        String(runId),
        "--repo",
        this.config.github.repository,
        "--json",
        "databaseId,status,conclusion,url,workflowName,updatedAt,jobs"
      ];
      const result = this.runCli(args);
      if (result.ok) {
        runView = parseJsonOrNull<GitHubRunViewResponse>(result.stdout || "");
      }
    }

    const queuedJobs = (runView?.jobs ?? [])
      .filter((job) => (job.status ?? "").trim().toLowerCase() === "queued")
      .map((job) => ({
        name: String(job.name ?? "unknown"),
        status: String(job.status ?? "unknown"),
        conclusion: job.conclusion ?? null,
        labels: normalizeLabelCollection(job.labels)
      }));

    const recycleScript = join(this.config.app_root, "scripts", "recycle-self-hosted-runner.ps1");
    const matchingRunners = runtime.matching_runners;
    const allOffline = matchingRunners.length > 0 && matchingRunners.every((runner) => runner.status.toLowerCase() !== "online");
    const allBusy = matchingRunners.length > 0 && matchingRunners.every((runner) => runner.busy);

    let likelyStalled = false;
    let reason = "GitHub run is still queued.";

    if (!runtime.self_hosted_targeted) {
      reason = "GitHub run is queued, but the configured workflow does not currently target self-hosted labels.";
    } else if (runtime.runner_lookup_detail) {
      likelyStalled = true;
      reason = `GitHub self-hosted runner lookup was inconclusive: ${runtime.runner_lookup_detail}`;
    } else if (matchingRunners.length === 0) {
      likelyStalled = true;
      reason = `No self-hosted runner currently matches labels ${runtime.runs_on_labels.join(", ")}.`;
    } else if (allOffline) {
      likelyStalled = true;
      reason = "Matching self-hosted runners are currently offline.";
    } else if (allBusy) {
      likelyStalled = true;
      reason = "Matching self-hosted runners are all busy.";
    } else {
      likelyStalled = true;
      reason = "The run is still queued even though a matching self-hosted runner appears online and idle; a stale broker session is likely.";
    }

    const diagnosis: GitHubQueueDiagnosis = {
      task_id: taskId,
      run_id: runId,
      run_url: runView?.url ?? runState.run_url,
      workflow_name: runView?.workflowName ?? runState.workflow_name,
      status: runView?.status ?? runState.status,
      queued_for_ms: queuedForMs,
      self_hosted_targeted: runtime.self_hosted_targeted,
      runs_on_labels: runtime.runs_on_labels,
      matching_runners: matchingRunners,
      queued_jobs: queuedJobs,
      runner_lookup_detail: runtime.runner_lookup_detail,
      likely_stalled: likelyStalled,
      reason,
      suggested_action: likelyStalled && existsSync(recycleScript)
        ? `Consider running ${recycleScript} before retrying the GitHub wait path.`
        : null
    };

    this.artifactStore.writeJson(taskId, "github-queue-diagnosis.json", diagnosis);
    return diagnosis;
  }

  private shouldAutoRecycleQueuedStall(diagnosis: GitHubQueueDiagnosis): boolean {
    return this.config.github.auto_recycle_stale_runner
      && diagnosis.likely_stalled
      && /stale broker session/i.test(diagnosis.reason);
  }

  private attemptQueuedStallRecovery(
    taskId: string,
    runId: number,
    diagnosis: GitHubQueueDiagnosis
  ): GitHubQueueRecoveryReceipt {
    const recycleScript = join(this.config.app_root, "scripts", "recycle-self-hosted-runner.ps1");
    const executable = this.findBinary("powershell.exe")
      ?? this.findBinary("powershell")
      ?? this.findBinary("pwsh")
      ?? null;

    let receipt: GitHubQueueRecoveryReceipt;

    if (this.platform !== "win32") {
      receipt = {
        task_id: taskId,
        run_id: runId,
        attempted_at: new Date().toISOString(),
        diagnosis_reason: diagnosis.reason,
        command: [],
        executable: null,
        skipped: true,
        detail: "Automatic recycle is currently only supported on Windows self-hosted runners.",
        ok: false,
        exit_code: null,
        stdout: "",
        stderr: ""
      };
    } else if (!existsSync(recycleScript)) {
      receipt = {
        task_id: taskId,
        run_id: runId,
        attempted_at: new Date().toISOString(),
        diagnosis_reason: diagnosis.reason,
        command: [],
        executable: null,
        skipped: true,
        detail: `Recycle script was not found at ${recycleScript}.`,
        ok: false,
        exit_code: null,
        stdout: "",
        stderr: ""
      };
    } else if (!executable) {
      receipt = {
        task_id: taskId,
        run_id: runId,
        attempted_at: new Date().toISOString(),
        diagnosis_reason: diagnosis.reason,
        command: [],
        executable: null,
        skipped: true,
        detail: "PowerShell is required to recycle the self-hosted runner automatically.",
        ok: false,
        exit_code: null,
        stdout: "",
        stderr: ""
      };
    } else {
      const args = [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        recycleScript,
        "-Repository",
        this.config.github.repository
      ];
      const result = this.runProcess(executable, args);
      receipt = {
        task_id: taskId,
        run_id: runId,
        attempted_at: new Date().toISOString(),
        diagnosis_reason: diagnosis.reason,
        command: [executable, ...args],
        executable,
        skipped: false,
        detail: result.ok
          ? "Automatic self-hosted runner recycle completed successfully."
          : result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.exitCode)}`,
        ok: result.ok,
        exit_code: result.exitCode,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim()
      };
    }

    this.artifactStore.writeJson(taskId, "github-queue-recycle.json", receipt);
    return receipt;
  }

  private renderQueueDiagnosisHint(taskId: string, diagnosis: Pick<GitHubQueueDiagnosis, "suggested_action">): string {
    const parts = [
      diagnosis.suggested_action,
      `See ${join(this.artifactStore.getTaskDir(taskId), "github-queue-diagnosis.json")}.`
    ].filter((value): value is string => Boolean(value && value.trim()));
    return parts.length > 0 ? ` ${parts.join(" ")}` : "";
  }

  private renderQueueRecoveryHint(taskId: string, receipt: Pick<GitHubQueueRecoveryReceipt, "detail">): string {
    return ` Automatic recycle attempt failed: ${receipt.detail} See ${join(this.artifactStore.getTaskDir(taskId), "github-queue-recycle.json")}.`;
  }

  private hasSuccessfulQueueRecycle(taskId: string): boolean {
    const recyclePath = join(this.artifactStore.getTaskDir(taskId), "github-queue-recycle.json");
    if (!existsSync(recyclePath)) {
      return false;
    }

    try {
      const parsed = JSON.parse(readFileSync(recyclePath, "utf8")) as { ok?: boolean };
      return parsed.ok === true;
    } catch {
      return false;
    }
  }

  private renderQueueEscalationHint(taskId: string): string {
    return ` Automatic stale-runner recovery was already attempted and manual intervention is now required. See ${join(this.artifactStore.getTaskDir(taskId), "github-queue-recycle.json")}.`;
  }

  private selectWorkflow(task: TaskSpec): string {
    if (task.expected_output.kind === "review" && this.config.github.review_workflow) {
      return this.config.github.review_workflow;
    }
    return this.config.github.workflow;
  }

  private buildWorkflowInputs(
    task: TaskSpec,
    routing: RoutingDecision,
    workflowName: string,
    payload: {
      repository: string;
      workflow: string;
      task: TaskSpec;
      routing: RoutingDecision;
    }
  ): Record<string, string> {
    if (this.config.github.review_workflow && workflowName === this.config.github.review_workflow) {
      return {
        task_id: task.task_id,
        target_repository: this.config.github.repository,
        base_branch: task.base_branch,
        work_branch: task.work_branch,
        execution_target: routing.fallback_from ?? task.worker_target,
        review_profile: task.review_profile ?? "standard",
        review_policy: JSON.stringify(task.review_policy),
        expected_output: JSON.stringify(task.expected_output),
        prior_result_status: "awaiting_review"
      };
    }

    return {
      task_id: task.task_id,
      payload_json: JSON.stringify(payload)
    };
  }

  private findDownloadedCallback(rootDir: string): string | null {
    const entries = readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(rootDir, entry.name);
      if (entry.isFile() && entry.name === "github-callback.json") {
        return fullPath;
      }
      if (entry.isDirectory()) {
        const nested = this.findDownloadedCallback(fullPath);
        if (nested) {
          return nested;
        }
      }
      if (!entry.isFile() && !entry.isDirectory() && statSync(fullPath).isDirectory()) {
        const nested = this.findDownloadedCallback(fullPath);
        if (nested) {
          return nested;
        }
      }
    }
    return null;
  }
}
