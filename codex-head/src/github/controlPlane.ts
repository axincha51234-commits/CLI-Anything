import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
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
  repository: string;
  workflow: string;
  review_workflow: string | null;
  cli_binary: string;
  gh_cli_available: boolean;
  gh_cli_path: string | null;
  gh_authenticated: boolean;
}

export interface GitHubDispatchReceipt {
  workflow_name: string;
  repository: string;
  dispatched_at: string;
  command: string[];
  input_keys: string[];
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

export interface GitHubControlPlaneDeps {
  runCli?: (args: string[], options?: { input?: string }) => GitHubCliRunResult;
  findBinary?: (bin: string) => string | null;
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

  constructor(
    private readonly config: CodexHeadConfig,
    private readonly artifactStore: FileArtifactStore,
    deps: GitHubControlPlaneDeps = {}
  ) {
    this.runCli = deps.runCli ?? ((args, options) => defaultRunCli(this.config.github.cli_binary, args, options));
    this.findBinary = deps.findBinary ?? findInstalledBinary;
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

    return {
      enabled: this.config.github.enabled,
      dispatch_mode: this.config.github.dispatch_mode,
      repository: this.config.github.repository,
      workflow: this.config.github.workflow,
      review_workflow: this.config.github.review_workflow,
      cli_binary: this.config.github.cli_binary,
      gh_cli_available: ghCliAvailable,
      gh_cli_path: ghCliPath,
      gh_authenticated: Boolean(auth?.ok)
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
    const workflowInputs = this.buildWorkflowInputs(task, routing, dispatch.workflow_name, payload);
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
    const result = this.runCli(args, {
      input: JSON.stringify(workflowInputs)
    });

    const receipt: GitHubDispatchReceipt = {
      workflow_name: dispatch.workflow_name,
      repository: this.config.github.repository,
      dispatched_at: new Date().toISOString(),
      command: [this.config.github.cli_binary, ...args],
      input_keys: Object.keys(workflowInputs),
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

    const deadline = Date.now() + Math.max(1, timeoutMs);
    let lastState: GitHubRunState | null = null;
    while (Date.now() <= deadline) {
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
      lastState = {
        run_id: Number(parsed.databaseId ?? runId),
        run_url: parsed.url ?? null,
        workflow_name: parsed.workflowName ?? "unknown",
        status: parsed.status ?? "unknown",
        conclusion: parsed.conclusion ?? null,
        updated_at: Date.parse(parsed.updatedAt ?? "") || Date.now()
      };
      if (lastState.status === "completed") {
        return lastState;
      }

      await sleep(Math.max(1, intervalMs));
    }

    throw new Error(
      `Timed out waiting for GitHub callback for task ${taskId} after ${Math.ceil(timeoutMs / 1000)}s`
      + (lastState ? ` (last status: ${lastState.status})` : "")
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
      throw new Error(`GitHub callback download failed: ${detail}`);
    }

    const callbackPath = this.findDownloadedCallback(downloadDir);
    if (!callbackPath) {
      throw new Error(`GitHub callback download succeeded but no github-callback.json was found. See ${receiptPath}`);
    }

    const artifactName = artifactNames.find((name) => existsSync(join(downloadDir, name, "github-callback.json")))
      ?? artifactNames.find((name) => existsSync(join(downloadDir, "github-callback.json")))
      ?? "unknown";

    return {
      task_id: taskId,
      repository: this.config.github.repository,
      download_dir: downloadDir,
      callback_path: callbackPath,
      artifact_name: artifactName,
      run_id: options.run_id ?? null
    };
  }

  buildCompletionEnvelope(result: WorkerResult): string {
    return join(this.artifactStore.getTaskDir(result.task_id), "github-callback.json");
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
