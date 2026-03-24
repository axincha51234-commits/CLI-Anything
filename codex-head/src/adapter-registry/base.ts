import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

import type {
  AdapterCapability,
  AdapterHealth,
  TaskRuntimeContext,
  TaskSpec,
  WorkerResult
} from "../contracts";
import type { CommandTemplate, WorkerTemplateConfig } from "../config";
import type { FileArtifactStore } from "../artifacts/fileArtifactStore";
import { findInstalledBinary, interpolateTemplate } from "./commandPolicy";

export interface WorkerExecutionOptions {
  cwd: string;
  artifactStore: FileArtifactStore;
}

export interface WorkerAdapter {
  readonly capability: AdapterCapability;
  healthCheck(): Promise<AdapterHealth>;
  execute(task: TaskSpec, runtime: TaskRuntimeContext, options: WorkerExecutionOptions): Promise<WorkerResult>;
}

function summarize(task: TaskSpec, stdout: string): string {
  const trimmed = stdout.trim();
  return trimmed.length > 0
    ? trimmed.slice(0, 500)
    : `${task.worker_target} completed ${task.expected_output.kind}`;
}

export function buildTaskPrompt(task: TaskSpec, runtime: TaskRuntimeContext): string {
  const lines = [
    "You are a subordinate worker operating under Codex Head.",
    "Codex Head remains the only planner, router, and synthesis authority.",
    "The task specification is fully summarized below, so do not try to read it from disk unless the task explicitly asks for artifact inspection.",
    "Codex Head will capture your stdout as the worker artifact unless the task explicitly requires a code artifact.",
    `Goal: ${task.goal}`,
    `Expected output kind: ${task.expected_output.kind}`,
    `Expected output format: ${task.expected_output.format}`,
    `Code change required: ${task.expected_output.code_change ? "yes" : "no"}`,
    `Allowed tools declared by head: ${task.allowed_tools.join(", ") || "none"}`,
    `Review policy: ${task.review_policy.required_reviewers.length > 0
      ? `${task.review_policy.required_reviewers.join(", ")} (require_all=${String(task.review_policy.require_all)})`
      : "no required reviewers"}`,
    `Artifact policy: ${task.artifact_policy.mode} (require_lineage=${String(task.artifact_policy.require_lineage)})`
  ];

  if (task.input_artifacts.length > 0) {
    lines.push(`Input artifacts: ${task.input_artifacts.join(", ")}`);
  }

  if (task.expected_output.code_change) {
    lines.push("Return only a unified diff patch or patch-like artifact that can be stored as lineage.");
  } else if (task.expected_output.format === "json") {
    lines.push("Return JSON only, with no markdown fences and no extra commentary.");
  } else if (task.expected_output.kind === "review") {
    lines.push("Return a concise review with a clear verdict and supporting notes.");
  } else {
    lines.push("Return only the final requested content with no extra framing.");
  }

  lines.push("Do not delegate to another worker.");
  lines.push("Do not tell another agent to run shell commands.");
  lines.push("Do not mutate repository state unless the task explicitly requires a code artifact.");
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" | ");
}

function resolveExecutionCommand(executable: string): {
  executable: string;
  use_cmd_wrapper: boolean;
} {
  const detected = findInstalledBinary(executable);
  let resolved = detected ?? executable;
  if (process.platform === "win32" && !/\.[^\\/]+$/i.test(resolved)) {
    const cmdCompanion = `${resolved}.cmd`;
    const batCompanion = `${resolved}.bat`;
    if (existsSync(cmdCompanion)) {
      resolved = cmdCompanion;
    } else if (existsSync(batCompanion)) {
      resolved = batCompanion;
    }
  }

  return {
    executable: resolved,
    use_cmd_wrapper: process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)
  };
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function terminateChildProcess(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  if (process.platform === "win32" && typeof child.pid === "number") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    return;
  }

  child.kill("SIGTERM");
}

function buildCmdCommandLine(executable: string, args: string[]): string {
  return `"${[quoteForCmd(executable), ...args.map((arg) => quoteForCmd(arg))].join(" ")}"`;
}

export abstract class BaseWorkerAdapter implements WorkerAdapter {
  constructor(
    public readonly capability: AdapterCapability,
    protected readonly templateConfig: WorkerTemplateConfig
  ) {}

  protected resolveLocalTemplate(): CommandTemplate | undefined {
    return this.templateConfig.local ?? undefined;
  }

  async healthCheck(): Promise<AdapterHealth> {
    if (!this.templateConfig.enabled) {
      return {
        worker_target: this.capability.worker_target,
        healthy: false,
        reason: "disabled",
        detected_binary: null
      };
    }

    const detected = findInstalledBinary(this.templateConfig.binary);
    if (!detected) {
      return {
        worker_target: this.capability.worker_target,
        healthy: false,
        reason: "missing_binary",
        detected_binary: null
      };
    }

    return {
      worker_target: this.capability.worker_target,
      healthy: true,
      reason: "ok",
      detected_binary: detected
    };
  }

  async execute(
    task: TaskSpec,
    runtime: TaskRuntimeContext,
    options: WorkerExecutionOptions
  ): Promise<WorkerResult> {
    const template = this.resolveLocalTemplate();
    if (!template) {
      return {
        task_id: task.task_id,
        worker_target: this.capability.worker_target,
        status: "failed",
        review_verdict: null,
        summary: `No local command template is configured for ${this.capability.worker_target}`,
        artifacts: [],
        patch_ref: null,
        log_ref: null,
        cost: 0,
        duration_ms: 0,
        next_action: "manual",
        review_notes: ["Configure a local template before enabling live execution."]
      };
    }

    const { executable, args, env } = interpolateTemplate(template, {
      task_file: runtime.task_file,
      task_goal: runtime.task_goal,
      task_prompt: runtime.task_prompt || buildTaskPrompt(task, runtime),
      artifact_dir: runtime.artifact_dir,
      github_payload: runtime.github_payload
    });

    const spawnCommand = resolveExecutionCommand(executable);
    const startedAt = Date.now();
    const result = await new Promise<{
      ok: boolean;
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    }>((resolve) => {
      const child = spawnCommand.use_cmd_wrapper
        ? (() => {
            return spawn(
              process.env.ComSpec || "cmd.exe",
              [
                "/d",
                "/s",
                "/c",
                buildCmdCommandLine(spawnCommand.executable, args)
              ],
              {
                cwd: options.cwd,
                env: {
                  ...process.env,
                  ...env
                },
                shell: false,
                windowsVerbatimArguments: true,
                stdio: ["ignore", "pipe", "pipe"]
              }
            );
          })()
        : spawn(spawnCommand.executable, args, {
            cwd: options.cwd,
            env: {
              ...process.env,
              ...env
            },
            shell: false,
            stdio: ["ignore", "pipe", "pipe"]
          });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const finish = (value: {
        ok: boolean;
        stdout: string;
        stderr: string;
        exitCode: number | null;
        timedOut: boolean;
      }) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        terminateChildProcess(child);
      }, Math.max(1, task.timeout_sec) * 1000);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (error: Error) => {
        clearTimeout(timer);
        finish({
          ok: false,
          stdout,
          stderr: stderr ? `${stderr}\n${error.message}` : error.message,
          exitCode: null,
          timedOut
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        finish({
          ok: code === 0 && !timedOut,
          stdout,
          stderr,
          exitCode: code,
          timedOut
        });
      });
    });

    const logs = options.artifactStore.recordCommandOutput(
      task.task_id,
      `${this.capability.worker_target}-local`,
      result.stdout,
      result.stderr
    );

    if (!result.ok) {
      return {
        task_id: task.task_id,
        worker_target: this.capability.worker_target,
        status: result.timedOut ? "retryable" : "failed",
        review_verdict: null,
        summary: result.timedOut
          ? `${this.capability.worker_target} timed out after ${task.timeout_sec}s`
          : `${this.capability.worker_target} failed with exit code ${result.exitCode ?? "unknown"}`,
        artifacts: [],
        patch_ref: null,
        log_ref: logs.combinedPath,
        cost: 0,
        duration_ms: Date.now() - startedAt,
        next_action: result.timedOut ? "retry" : "manual",
        review_notes: result.stderr ? [result.stderr.trim()] : []
      };
    }

    const artifacts: string[] = [];
    let patchRef: string | null = null;
    if (task.expected_output.code_change) {
      patchRef = options.artifactStore.writeText(
        task.task_id,
        "worker-output.patch",
        result.stdout || `# ${task.worker_target} completed ${task.goal}\n`
      );
      artifacts.push(patchRef);
    } else {
      const extension = task.expected_output.format === "json" ? "json" : "md";
      const content = task.expected_output.format === "json"
        ? (result.stdout || JSON.stringify({ summary: summarize(task, result.stdout) }, null, 2))
        : (result.stdout || summarize(task, result.stdout));
      artifacts.push(options.artifactStore.writeText(task.task_id, `worker-output.${extension}`, content));
    }

    return {
      task_id: task.task_id,
      worker_target: this.capability.worker_target,
      status: task.review_policy.required_reviewers.length > 0 ? "awaiting_review" : "completed",
      review_verdict: null,
      summary: summarize(task, result.stdout),
      artifacts,
      patch_ref: patchRef,
      log_ref: logs.combinedPath,
      cost: 0,
      duration_ms: Date.now() - startedAt,
      next_action: task.review_policy.required_reviewers.length > 0 ? "review" : "none",
      review_notes: []
    };
  }
}
