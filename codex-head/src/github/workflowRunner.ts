import { readFileSync } from "node:fs";

import { createDefaultRegistry, type AdapterRegistry } from "../adapter-registry";
import { FileArtifactStore } from "../artifacts/fileArtifactStore";
import { loadConfig, type CodexHeadConfig } from "../config";
import type {
  RoutingDecision,
  TaskRuntimeContext,
  TaskSpec,
  WorkerResult
} from "../contracts";
import { validateTaskSpec } from "../schema";

export interface GitHubDispatchPayload {
  repository: string;
  workflow: string;
  task: TaskSpec;
  routing: RoutingDecision;
}

export interface GitHubPayloadExecution {
  payload: GitHubDispatchPayload;
  result: WorkerResult;
  callback_path: string;
}

function ensureObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function ensureString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function validateRoutingDecision(input: unknown): RoutingDecision {
  const routing = ensureObject(input, "routing");
  const mode = ensureString(routing.mode, "routing.mode");
  if (mode !== "local" && mode !== "github") {
    throw new Error("routing.mode must be local or github");
  }

  return {
    worker_target: ensureString(routing.worker_target, "routing.worker_target") as RoutingDecision["worker_target"],
    mode,
    reason: ensureString(routing.reason, "routing.reason"),
    fallback_from: routing.fallback_from === null
      ? null
      : routing.fallback_from === undefined
        ? null
        : ensureString(routing.fallback_from, "routing.fallback_from") as RoutingDecision["fallback_from"]
  };
}

export function validateGitHubDispatchPayload(input: unknown): GitHubDispatchPayload {
  const payload = ensureObject(input, "github payload");
  return {
    repository: ensureString(payload.repository, "repository"),
    workflow: ensureString(payload.workflow, "workflow"),
    task: validateTaskSpec(payload.task),
    routing: validateRoutingDecision(payload.routing)
  };
}

function buildRuntime(task: TaskSpec, artifactStore: FileArtifactStore, payloadPath: string): TaskRuntimeContext {
  const taskFile = artifactStore.writeJson(task.task_id, "task-input.json", task);
  return {
    task_file: taskFile,
    task_goal: task.goal,
    task_prompt: [
      "You are running under Codex Head from a GitHub worker workflow.",
      `Read the task specification from ${taskFile}.`,
      `Use the current working directory as the repository root for ${task.repo}.`,
      "Return only the requested deliverable.",
      "Never delegate to another worker and never emit commands for another worker to execute."
    ].join("\n"),
    artifact_dir: artifactStore.getTaskDir(task.task_id),
    github_payload: payloadPath
  };
}

export async function executeGitHubPayload(
  payload: GitHubDispatchPayload,
  config: CodexHeadConfig = loadConfig(process.cwd()),
  registry: AdapterRegistry = createDefaultRegistry(config)
): Promise<GitHubPayloadExecution> {
  const artifactStore = new FileArtifactStore(config.artifacts_dir);
  const runtime = buildRuntime(payload.task, artifactStore, artifactStore.writeJson(
    payload.task.task_id,
    "github-dispatch.json",
    payload
  ));
  const adapter = registry.get(payload.routing.worker_target);
  const result = await adapter.execute(payload.task, runtime, {
    artifactStore,
    cwd: config.workspace_root
  });
  const callbackPath = artifactStore.writeJson(payload.task.task_id, "github-callback.json", result);

  return {
    payload,
    result,
    callback_path: callbackPath
  };
}

export async function executeGitHubPayloadFile(
  payloadFile: string,
  config: CodexHeadConfig = loadConfig(process.cwd()),
  registry: AdapterRegistry = createDefaultRegistry(config)
): Promise<GitHubPayloadExecution> {
  const payload = validateGitHubDispatchPayload(JSON.parse(readFileSync(payloadFile, "utf8")) as unknown);
  return executeGitHubPayload(payload, config, registry);
}
