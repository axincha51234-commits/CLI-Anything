import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { FileArtifactStore } from "../src/artifacts/fileArtifactStore";
import { GitHubControlPlane } from "../src/github/controlPlane";
import { createTaskSpec } from "../src/schema";
import { createTempDir, createTestConfig, routing } from "./helpers";

test("GitHubControlPlane materializes issue, PR, and payload artifacts", () => {
  const root = createTempDir("codex-head-github-");
  const config = createTestConfig(root);
  const artifactStore = new FileArtifactStore(config.artifacts_dir);
  const github = new GitHubControlPlane(config, artifactStore);
  const task = createTaskSpec({
    goal: "Review this PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "pull_request", format: "markdown", code_change: true },
    requires_github: true
  });

  const dispatch = github.prepareDispatch(task, routing("gemini-cli", "github"));
  assert.equal(existsSync(dispatch.payload_path), true);
  assert.equal(existsSync(dispatch.workflow_inputs_path), true);
  assert.equal(existsSync(dispatch.issue_path), true);
  assert.equal(existsSync(dispatch.pr_path ?? ""), true);
});

test("GitHubControlPlane can verify repository access through gh cli", () => {
  const root = createTempDir("codex-head-github-repo-status-");
  const config = createTestConfig(root);
  config.github.repository = "example/repo";

  const artifactStore = new FileArtifactStore(config.artifacts_dir);
  const github = new GitHubControlPlane(config, artifactStore, {
    findBinary: () => "C:/Program Files/GitHub CLI/gh.exe",
    runCli: (args) => {
      if (args[0] === "auth") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "Logged in to github.com",
          stderr: "",
          durationMs: 1,
          timedOut: false
        };
      }
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({
          nameWithOwner: "example/repo",
          url: "https://github.com/example/repo",
          defaultBranchRef: { name: "main" },
          viewerPermission: "WRITE",
          isPrivate: true
        }),
        stderr: "",
        durationMs: 1,
        timedOut: false
      };
    }
  });

  const status = github.verifyRepositoryAccess("example/repo");
  assert.equal(status.accessible, true);
  assert.equal(status.default_branch, "main");
  assert.equal(status.viewer_permission, "WRITE");
});

test("GitHubControlPlane inspects targeted self-hosted runners from repository metadata", () => {
  const root = createTempDir("codex-head-github-runtime-");
  const config = createTestConfig(root);
  config.github.repository = "example/repo";
  const previousMachineConfig = process.env.CODEX_HEAD_MACHINE_CONFIG;
  process.env.CODEX_HEAD_MACHINE_CONFIG = `${root}\\workers.machine.json`;
  writeFileSync(process.env.CODEX_HEAD_MACHINE_CONFIG, JSON.stringify({}), "utf8");

  try {
    const artifactStore = new FileArtifactStore(config.artifacts_dir);
    const github = new GitHubControlPlane(config, artifactStore, {
      findBinary: () => "C:/Program Files/GitHub CLI/gh.exe",
      runCli: (args) => {
        if (args[0] === "auth") {
          return {
            ok: true,
            exitCode: 0,
            stdout: "Logged in to github.com",
            stderr: "",
            durationMs: 1,
            timedOut: false
          };
        }
        if (args[0] === "api" && args[1] === "repos/example/repo/actions/variables/CODEX_HEAD_RUNS_ON_JSON") {
          return {
            ok: true,
            exitCode: 0,
            stdout: JSON.stringify({
              name: "CODEX_HEAD_RUNS_ON_JSON",
              value: "[\"self-hosted\",\"Windows\",\"codex-head\"]"
            }),
            stderr: "",
            durationMs: 1,
            timedOut: false
          };
        }
        if (args[0] === "api" && args[1] === "repos/example/repo/actions/runners") {
          return {
            ok: true,
            exitCode: 0,
            stdout: JSON.stringify({
              runners: [
                {
                  id: 21,
                  name: "DESKTOP-F7V83BO-codex-head",
                  os: "Windows",
                  status: "online",
                  busy: false,
                  labels: [
                    { name: "self-hosted" },
                    { name: "Windows" },
                    { name: "X64" },
                    { name: "codex-head" }
                  ]
                },
                {
                  id: 22,
                  name: "ubuntu-runner",
                  os: "Linux",
                  status: "online",
                  busy: false,
                  labels: [
                    { name: "self-hosted" },
                    { name: "Linux" }
                  ]
                }
              ]
            }),
            stderr: "",
            durationMs: 1,
            timedOut: false
          };
        }
        throw new Error(`Unexpected gh args: ${args.join(" ")}`);
      }
    });

    const runtime = github.inspectRuntime();
    assert.equal(runtime.machine_config_path, `${root}\\workers.machine.json`);
    assert.equal(runtime.machine_config_exists, true);
    assert.equal(runtime.self_hosted_targeted, true);
    assert.equal(runtime.runs_on_json, "[\"self-hosted\",\"Windows\",\"codex-head\"]");
    assert.deepEqual(runtime.runs_on_labels, ["self-hosted", "Windows", "codex-head"]);
    assert.equal(runtime.matching_runners.length, 1);
    assert.equal(runtime.matching_runners[0]?.name, "DESKTOP-F7V83BO-codex-head");
    assert.equal(runtime.matching_runners[0]?.status, "online");
  } finally {
    if (previousMachineConfig === undefined) {
      delete process.env.CODEX_HEAD_MACHINE_CONFIG;
    } else {
      process.env.CODEX_HEAD_MACHINE_CONFIG = previousMachineConfig;
    }
  }
});

test("GitHubControlPlane can dispatch the generic worker workflow through gh cli", () => {
  const root = createTempDir("codex-head-github-live-");
  const config = createTestConfig(root);
  config.github.dispatch_mode = "gh_cli";
  config.github.repository = "example/repo";

  const calls: Array<{ args: string[]; input?: string }> = [];
  const artifactStore = new FileArtifactStore(config.artifacts_dir);
  const github = new GitHubControlPlane(config, artifactStore, {
    findBinary: () => "C:/Program Files/GitHub CLI/gh.exe",
    runCli: (args, options) => {
      calls.push({ args, input: options?.input });
      if (args[0] === "auth") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "Logged in to github.com",
          stderr: "",
          durationMs: 1,
          timedOut: false
        };
      }
      return {
        ok: true,
        exitCode: 0,
        stdout: "https://github.com/example/repo/actions/runs/123",
        stderr: "",
        durationMs: 1,
        timedOut: false
      };
    }
  });

  const task = createTaskSpec({
    goal: "Review this PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false },
    requires_github: true
  });

  const dispatch = github.prepareDispatch(task, routing("gemini-cli", "github"));
  const receipt = github.dispatchWorkflow(task, routing("gemini-cli", "github"), dispatch);
  const workflowCall = calls.find((entry) => entry.args[0] === "workflow");
  assert.ok(workflowCall);
  assert.equal(workflowCall?.args[2], "codex-head-worker.yml");
  assert.deepEqual(JSON.parse(workflowCall?.input ?? "{}"), {
    task_id: task.task_id,
    payload_json: JSON.stringify({
      repository: config.github.repository,
      workflow: "codex-head-worker.yml",
      task,
      routing: routing("gemini-cli", "github")
    })
  });
  assert.equal(receipt.workflow_name, "codex-head-worker.yml");
  assert.equal(receipt.run?.run_id, 123);
  assert.equal(receipt.run_lookup, "stdout");
  assert.equal(existsSync(resolve(config.artifacts_dir, task.task_id, "github-dispatch-receipt.json")), true);
});

test("GitHubControlPlane picks review_workflow inputs for review tasks", () => {
  const root = createTempDir("codex-head-github-review-live-");
  const config = createTestConfig(root);
  config.github.dispatch_mode = "gh_cli";
  config.github.repository = "example/repo";

  const artifactStore = new FileArtifactStore(config.artifacts_dir);
  let workflowInput: Record<string, string> | null = null;
  const github = new GitHubControlPlane(config, artifactStore, {
    findBinary: () => "C:/Program Files/GitHub CLI/gh.exe",
    runCli: (args, options) => {
      if (args[0] === "auth") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "Logged in to github.com",
          stderr: "",
          durationMs: 1,
          timedOut: false
        };
      }
      workflowInput = JSON.parse(options?.input ?? "{}") as Record<string, string>;
      return {
        ok: true,
        exitCode: 0,
        stdout: "https://github.com/example/repo/actions/runs/456",
        stderr: "",
        durationMs: 1,
        timedOut: false
      };
    }
  });

  const task = createTaskSpec({
    goal: "Review the generated patch in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    review_policy: { required_reviewers: ["codex-cli"], require_all: true },
    requires_github: true
  });

  const dispatch = github.prepareDispatch(task, routing("gemini-cli", "github"));
  const storedInputs = JSON.parse(readFileSync(dispatch.workflow_inputs_path, "utf8")) as Record<string, string>;
  assert.equal(dispatch.workflow_name, "codex-head-gemini-review.yml");
  assert.equal(storedInputs.target_repository, "example/repo");
  assert.equal(storedInputs.base_branch, "main");
  assert.equal(storedInputs.execution_target, "gemini-cli");
  assert.equal(storedInputs.prior_result_status, "awaiting_review");

  github.dispatchWorkflow(task, routing("gemini-cli", "github"), dispatch);
  assert.deepEqual(workflowInput, storedInputs);
});

test("GitHubControlPlane can download a callback artifact for a task id", () => {
  const root = createTempDir("codex-head-github-download-");
  const config = createTestConfig(root);
  config.github.repository = "example/repo";

  const calls: string[][] = [];
  const artifactStore = new FileArtifactStore(config.artifacts_dir);
  const github = new GitHubControlPlane(config, artifactStore, {
    findBinary: () => "C:/Program Files/GitHub CLI/gh.exe",
    runCli: (args) => {
      calls.push(args);
      if (args[0] === "auth") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "Logged in to github.com",
          stderr: "",
          durationMs: 1,
          timedOut: false
        };
      }

      const downloadDir = args[args.indexOf("--dir") + 1];
      const artifactDir = resolve(downloadDir, "codex-head-worker-callback-task-123");
      require("node:fs").mkdirSync(artifactDir, { recursive: true });
      require("node:fs").writeFileSync(
        resolve(artifactDir, "github-callback.json"),
        JSON.stringify({
          task_id: "task-123",
          worker_target: "codex-cli",
          status: "completed",
          review_verdict: null,
          summary: "Downloaded callback",
          artifacts: [],
          patch_ref: null,
          log_ref: null,
          cost: 0,
          duration_ms: 0,
          next_action: "none",
          review_notes: []
        }, null, 2),
        "utf8"
      );
      return {
        ok: true,
        exitCode: 0,
        stdout: "downloaded",
        stderr: "",
        durationMs: 1,
        timedOut: false
      };
    }
  });

  const download = github.downloadCallbackArtifact("task-123", { run_id: 789 });
  assert.equal(download.artifact_name, "codex-head-worker-callback-task-123");
  assert.equal(download.run_id, 789);
  assert.equal(calls.find((entry) => entry[0] === "run" && entry[1] === "download")?.[2], "789");
  assert.equal(download.callback_path, resolve(config.artifacts_dir, "task-123", "github-callback.json"));
  assert.equal(existsSync(download.callback_path), true);
  assert.equal(
    JSON.parse(readFileSync(download.callback_path, "utf8") as string).summary,
    "Downloaded callback"
  );
});

test("GitHubControlPlane enriches callback download failures with queued self-hosted diagnosis", () => {
  const root = createTempDir("codex-head-github-download-queued-");
  const config = createTestConfig(root);
  config.github.repository = "example/repo";
  const previousMachineConfig = process.env.CODEX_HEAD_MACHINE_CONFIG;
  delete process.env.CODEX_HEAD_MACHINE_CONFIG;

  try {
    const artifactStore = new FileArtifactStore(config.artifacts_dir);
    const github = new GitHubControlPlane(config, artifactStore, {
      findBinary: () => "C:/Program Files/GitHub CLI/gh.exe",
      runCli: (args) => {
        if (args[0] === "auth") {
          return {
            ok: true,
            exitCode: 0,
            stdout: "Logged in to github.com",
            stderr: "",
            durationMs: 1,
            timedOut: false
          };
        }
        if (args[0] === "api" && args[1] === "repos/example/repo/actions/variables/CODEX_HEAD_RUNS_ON_JSON") {
          return {
            ok: true,
            exitCode: 0,
            stdout: JSON.stringify({
              name: "CODEX_HEAD_RUNS_ON_JSON",
              value: "[\"self-hosted\",\"Windows\",\"codex-head\"]"
            }),
            stderr: "",
            durationMs: 1,
            timedOut: false
          };
        }
        if (args[0] === "api" && args[1] === "repos/example/repo/actions/runners") {
          return {
            ok: true,
            exitCode: 0,
            stdout: JSON.stringify({
              runners: [
                {
                  id: 21,
                  name: "DESKTOP-F7V83BO-codex-head",
                  os: "Windows",
                  status: "online",
                  busy: false,
                  labels: [
                    { name: "self-hosted" },
                    { name: "Windows" },
                    { name: "X64" },
                    { name: "codex-head" }
                  ]
                }
              ]
            }),
            stderr: "",
            durationMs: 1,
            timedOut: false
          };
        }
        if (args[0] === "run" && args[1] === "view") {
          return {
            ok: true,
            exitCode: 0,
            stdout: JSON.stringify({
              databaseId: 991,
              status: "queued",
              conclusion: null,
              url: "https://github.com/example/repo/actions/runs/991",
              workflowName: "codex-head-worker.yml",
              updatedAt: new Date().toISOString(),
              jobs: [
                {
                  name: "worker",
                  status: "queued",
                  conclusion: null,
                  labels: ["self-hosted", "Windows", "codex-head"]
                }
              ]
            }),
            stderr: "",
            durationMs: 1,
            timedOut: false
          };
        }
        if (args[0] === "run" && args[1] === "download") {
          return {
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: "artifact not found",
            durationMs: 1,
            timedOut: false
          };
        }
        throw new Error(`Unexpected gh args: ${args.join(" ")}`);
      }
    });

    assert.throws(
      () => github.downloadCallbackArtifact("task-queued-download", { run_id: 991 }),
      /artifact not found|stale broker session|github-queue-diagnosis\.json/i
    );

    const diagnosisPath = resolve(config.artifacts_dir, "task-queued-download", "github-queue-diagnosis.json");
    assert.equal(existsSync(diagnosisPath), true);
  } finally {
    if (previousMachineConfig === undefined) {
      delete process.env.CODEX_HEAD_MACHINE_CONFIG;
    } else {
      process.env.CODEX_HEAD_MACHINE_CONFIG = previousMachineConfig;
    }
  }
});

test("GitHubControlPlane can publish issue and PR mirrors through gh cli", () => {
  const root = createTempDir("codex-head-github-mirror-");
  const config = createTestConfig(root);
  config.github.repository = "example/repo";

  const calls: string[][] = [];
  const artifactStore = new FileArtifactStore(config.artifacts_dir);
  const github = new GitHubControlPlane(config, artifactStore, {
    findBinary: () => "C:/Program Files/GitHub CLI/gh.exe",
    runCli: (args) => {
      calls.push(args);
      if (args[0] === "auth") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "Logged in to github.com",
          stderr: "",
          durationMs: 1,
          timedOut: false
        };
      }
      if (args[0] === "issue") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "https://github.com/example/repo/issues/123",
          stderr: "",
          durationMs: 1,
          timedOut: false
        };
      }
      if (args[0] === "pr") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "https://github.com/example/repo/pull/456",
          stderr: "",
          durationMs: 1,
          timedOut: false
        };
      }
      throw new Error(`Unexpected gh args: ${args.join(" ")}`);
    }
  });

  const task = createTaskSpec({
    goal: "Open a PR mirror for this task",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "pull_request", format: "markdown", code_change: true },
    artifact_policy: { mode: "branch_pr", require_lineage: true },
    requires_github: true
  });

  const dispatch = github.prepareDispatch(task, routing("gemini-cli", "github"));
  const receipt = github.publishMirror(task, dispatch);
  assert.equal(receipt.mirror.issue?.number, 123);
  assert.equal(receipt.mirror.pull_request?.number, 456);
  assert.equal(receipt.issue_created, true);
  assert.equal(receipt.pr_created, true);
  assert.equal(calls.some((entry) => entry[0] === "issue" && entry[1] === "create"), true);
  assert.equal(calls.some((entry) => entry[0] === "pr" && entry[1] === "create"), true);
});

test("GitHubControlPlane resolves and waits for a workflow run by task id", async () => {
  const root = createTempDir("codex-head-github-wait-");
  const config = createTestConfig(root);
  config.github.repository = "example/repo";

  const artifactStore = new FileArtifactStore(config.artifacts_dir);
  let viewCalls = 0;
  const github = new GitHubControlPlane(config, artifactStore, {
    findBinary: () => "C:/Program Files/GitHub CLI/gh.exe",
    runCli: (args) => {
      if (args[0] === "auth") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "Logged in to github.com",
          stderr: "",
          durationMs: 1,
          timedOut: false
        };
      }

      if (args[0] === "run" && args[1] === "list") {
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify([{
            databaseId: 456,
            displayTitle: "codex-head task task-456",
            event: "workflow_dispatch",
            headBranch: "main",
            status: "in_progress",
            conclusion: null,
            url: "https://github.com/example/repo/actions/runs/456",
            workflowName: "codex-head-worker.yml",
            createdAt: "2026-03-21T12:00:00Z",
            updatedAt: "2026-03-21T12:00:01Z"
          }]),
          stderr: "",
          durationMs: 1,
          timedOut: false
        };
      }

      if (args[0] === "run" && args[1] === "view") {
        viewCalls += 1;
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            databaseId: 456,
            workflowName: "codex-head-worker.yml",
            url: "https://github.com/example/repo/actions/runs/456",
            status: viewCalls === 1 ? "in_progress" : "completed",
            conclusion: viewCalls === 1 ? null : "success",
            updatedAt: "2026-03-21T12:00:02Z"
          }),
          stderr: "",
          durationMs: 1,
          timedOut: false
        };
      }

      throw new Error(`Unexpected gh args: ${args.join(" ")}`);
    }
  });

  const task = createTaskSpec({
    task_id: "task-456",
    goal: "Review this PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false },
    requires_github: true
  });

  const run = github.resolveTaskRun(task);
  assert.equal(run?.run_id, 456);

  const completed = await github.waitForRunCompletion(task.task_id, run!.run_id, 1000, 1);
  assert.equal(completed.status, "completed");
  assert.equal(completed.conclusion, "success");
});

test("GitHubControlPlane diagnoses a queued self-hosted stall with a concrete message", async () => {
  const root = createTempDir("codex-head-github-queued-stall-");
  const config = createTestConfig(root);
  config.github.repository = "example/repo";
  const previousMachineConfig = process.env.CODEX_HEAD_MACHINE_CONFIG;
  delete process.env.CODEX_HEAD_MACHINE_CONFIG;

  try {
    const artifactStore = new FileArtifactStore(config.artifacts_dir);
    const github = new GitHubControlPlane(config, artifactStore, {
      findBinary: () => "C:/Program Files/GitHub CLI/gh.exe",
      runCli: (args) => {
        if (args[0] === "auth") {
          return {
            ok: true,
            exitCode: 0,
            stdout: "Logged in to github.com",
            stderr: "",
            durationMs: 1,
            timedOut: false
          };
        }
        if (args[0] === "api" && args[1] === "repos/example/repo/actions/variables/CODEX_HEAD_RUNS_ON_JSON") {
          return {
            ok: true,
            exitCode: 0,
            stdout: JSON.stringify({
              name: "CODEX_HEAD_RUNS_ON_JSON",
              value: "[\"self-hosted\",\"Windows\",\"codex-head\"]"
            }),
            stderr: "",
            durationMs: 1,
            timedOut: false
          };
        }
        if (args[0] === "api" && args[1] === "repos/example/repo/actions/runners") {
          return {
            ok: true,
            exitCode: 0,
            stdout: JSON.stringify({
              runners: [
                {
                  id: 21,
                  name: "DESKTOP-F7V83BO-codex-head",
                  os: "Windows",
                  status: "online",
                  busy: false,
                  labels: [
                    { name: "self-hosted" },
                    { name: "Windows" },
                    { name: "X64" },
                    { name: "codex-head" }
                  ]
                }
              ]
            }),
            stderr: "",
            durationMs: 1,
            timedOut: false
          };
        }
        if (args[0] === "run" && args[1] === "view") {
          return {
            ok: true,
            exitCode: 0,
            stdout: JSON.stringify({
              databaseId: 987,
              status: "queued",
              conclusion: null,
              url: "https://github.com/example/repo/actions/runs/987",
              workflowName: "codex-head-worker.yml",
              updatedAt: new Date().toISOString(),
              jobs: [
                {
                  name: "worker",
                  status: "queued",
                  conclusion: null,
                  labels: ["self-hosted", "Windows", "codex-head"]
                }
              ]
            }),
            stderr: "",
            durationMs: 1,
            timedOut: false
          };
        }
        throw new Error(`Unexpected gh args: ${args.join(" ")}`);
      }
    });

    await assert.rejects(
      () => github.waitForRunCompletion("task-queued", 987, 200, 25),
      /stuck in queued state|stale broker session/i
    );

    const diagnosisPath = resolve(config.artifacts_dir, "task-queued", "github-queue-diagnosis.json");
    assert.equal(existsSync(diagnosisPath), true);
    const diagnosis = JSON.parse(readFileSync(diagnosisPath, "utf8")) as {
      likely_stalled: boolean;
      queued_jobs: Array<{ name: string }>;
      matching_runners: Array<{ name: string }>;
    };
    assert.equal(diagnosis.likely_stalled, true);
    assert.equal(diagnosis.queued_jobs[0]?.name, "worker");
    assert.equal(diagnosis.matching_runners[0]?.name, "DESKTOP-F7V83BO-codex-head");
  } finally {
    if (previousMachineConfig === undefined) {
      delete process.env.CODEX_HEAD_MACHINE_CONFIG;
    } else {
      process.env.CODEX_HEAD_MACHINE_CONFIG = previousMachineConfig;
    }
  }
});

test("GitHub workflow file exists", () => {
  const workflowPath = resolve(process.cwd(), "../.github/workflows/codex-head-worker.yml");
  assert.equal(existsSync(workflowPath), true);
});
