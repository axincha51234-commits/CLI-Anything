const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

import type { WorkerTarget } from "./contracts";

export interface CommandTemplate {
  name: string;
  executable: string;
  args: string[];
}

export interface WorkerTemplateConfig {
  enabled: boolean;
  binary: string;
  health?: CommandTemplate;
  local?: CommandTemplate;
}

export interface GitHubConfig {
  enabled: boolean;
  repository: string;
  workflow: string;
  review_workflow: string | null;
  dispatch_mode: "artifacts_only" | "gh_cli";
  cli_binary: string;
}

export interface CodexHeadConfig {
  app_root: string;
  workspace_root: string;
  artifacts_dir: string;
  database_path: string;
  methodology_refs: string[];
  feature_flags: Record<string, boolean>;
  command_templates: Record<WorkerTarget, WorkerTemplateConfig>;
  github: GitHubConfig;
}

type ExternalConfig = Omit<Partial<CodexHeadConfig>, "github" | "command_templates"> & {
  github?: Partial<GitHubConfig>;
  feature_flags?: Record<string, boolean>;
  command_templates?: Partial<Record<WorkerTarget, Partial<WorkerTemplateConfig>>>;
  featureFlags?: Record<string, boolean>;
  commandTemplates?: Partial<Record<WorkerTarget, Partial<WorkerTemplateConfig>>>;
};

const DEFAULT_GITHUB_REPOSITORY = "OWNER/REPO";

function resolveRepoRoot(appRoot: string): string {
  return path.resolve(appRoot, "..");
}

export function normalizeGitHubRepository(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    return trimmed.replace(/\.git$/i, "");
  }

  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  const sshMatch = trimmed.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  return null;
}

function detectGitHubRepository(repoRoot: string): string {
  const envRepository = normalizeGitHubRepository(process.env.GITHUB_REPOSITORY);
  if (envRepository) {
    return envRepository;
  }

  const gitRemote = spawnSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
    encoding: "utf8"
  });
  const remoteRepository = normalizeGitHubRepository(String(gitRemote.stdout ?? ""));
  return remoteRepository ?? DEFAULT_GITHUB_REPOSITORY;
}

export function resolveConfigPath(appRoot: string, configPath?: string): string {
  return configPath
    ?? process.env.CODEX_HEAD_CONFIG
    ?? path.join(appRoot, "config", "workers.local.json");
}

function readExternalConfig(finalPath: string): ExternalConfig {
  if (!fs.existsSync(finalPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(finalPath, "utf8")) as ExternalConfig;
}

export function createDefaultConfig(appRoot: string): CodexHeadConfig {
  const repoRoot = resolveRepoRoot(appRoot);
  const runtimeDir = path.join(appRoot, "runtime");

  return {
    app_root: appRoot,
    workspace_root: repoRoot,
    artifacts_dir: path.join(runtimeDir, "artifacts"),
    database_path: path.join(runtimeDir, "codex-head.sqlite"),
    methodology_refs: [
      path.join(repoRoot, "cli-anything-plugin", "HARNESS.md"),
      path.join(repoRoot, "codex-skill", "SKILL.md")
    ],
    feature_flags: {
      antigravity: false
    },
    command_templates: {
      "claude-code": {
        enabled: true,
        binary: "claude",
        health: {
          name: "claude-version",
          executable: "claude",
          args: ["--version"]
        },
        local: {
          name: "claude-task",
          executable: "claude",
          args: ["-p", "--permission-mode", "plan", "--output-format", "text", "{{task_prompt}}"]
        }
      },
      "codex-cli": {
        enabled: true,
        binary: "codex",
        health: {
          name: "codex-version",
          executable: "codex",
          args: ["--version"]
        },
        local: {
          name: "codex-task",
          executable: "codex",
          args: ["exec", "--skip-git-repo-check", "-s", "read-only", "--color", "never", "{{task_prompt}}"]
        }
      },
      "gemini-cli": {
        enabled: true,
        binary: "gemini",
        health: {
          name: "gemini-version",
          executable: "gemini",
          args: ["--version"]
        },
        local: {
          name: "gemini-task",
          executable: "gemini",
          args: ["-p", "{{task_prompt}}", "--approval-mode", "plan", "--output-format", "text"]
        }
      },
      antigravity: {
        enabled: false,
        binary: "antigravity",
        health: {
          name: "antigravity-version",
          executable: "antigravity",
          args: ["--version"]
        }
      }
    },
    github: {
      enabled: false,
      repository: detectGitHubRepository(repoRoot),
      workflow: "codex-head-worker.yml",
      review_workflow: "codex-head-gemini-review.yml",
      dispatch_mode: "artifacts_only",
      cli_binary: "gh"
    }
  };
}

function mergeCommandTemplate(
  base: WorkerTemplateConfig,
  override?: Partial<WorkerTemplateConfig>
): WorkerTemplateConfig {
  if (!override) {
    return { ...base };
  }

  return {
    enabled: override.enabled ?? base.enabled,
    binary: override.binary ?? base.binary,
    health: override.health ?? base.health,
    local: override.local ?? base.local
  };
}

export function mergeConfig(
  base: CodexHeadConfig,
  override: Partial<CodexHeadConfig>
): CodexHeadConfig {
  return {
    ...base,
    ...override,
    methodology_refs: override.methodology_refs ?? base.methodology_refs,
    feature_flags: {
      ...base.feature_flags,
      ...(override.feature_flags ?? {})
    },
    command_templates: {
      "claude-code": mergeCommandTemplate(
        base.command_templates["claude-code"],
        override.command_templates?.["claude-code"]
      ),
      "codex-cli": mergeCommandTemplate(
        base.command_templates["codex-cli"],
        override.command_templates?.["codex-cli"]
      ),
      "gemini-cli": mergeCommandTemplate(
        base.command_templates["gemini-cli"],
        override.command_templates?.["gemini-cli"]
      ),
      antigravity: mergeCommandTemplate(
        base.command_templates.antigravity,
        override.command_templates?.antigravity
      )
    },
    github: {
      ...base.github,
      ...(override.github ?? {})
    }
  };
}

function normalizeExternalConfig(parsed: ExternalConfig): Partial<CodexHeadConfig> {
  return {
    ...parsed,
    feature_flags: parsed.feature_flags ?? parsed.featureFlags,
    command_templates: (parsed.command_templates ?? parsed.commandTemplates) as Partial<CodexHeadConfig["command_templates"]> | undefined
  } as Partial<CodexHeadConfig>;
}

export function loadConfig(appRoot: string, configPath?: string): CodexHeadConfig {
  const base = createDefaultConfig(appRoot);
  const finalPath = resolveConfigPath(appRoot, configPath);
  if (!fs.existsSync(finalPath)) {
    return base;
  }

  const parsed = readExternalConfig(finalPath);
  return mergeConfig(base, normalizeExternalConfig(parsed));
}

export function updateGitHubConfig(
  appRoot: string,
  githubOverride: Partial<GitHubConfig>,
  configPath?: string
): { path: string; config: CodexHeadConfig } {
  const finalPath = resolveConfigPath(appRoot, configPath);
  const parsed = readExternalConfig(finalPath);
  const next: ExternalConfig = {
    ...parsed,
    github: {
      ...(parsed.github ?? {}),
      ...githubOverride
    }
  };

  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.writeFileSync(finalPath, JSON.stringify(next, null, 2), "utf8");
  return {
    path: finalPath,
    config: loadConfig(appRoot, finalPath)
  };
}
