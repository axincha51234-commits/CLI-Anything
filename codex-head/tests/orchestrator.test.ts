import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { AdapterRegistry } from "../src/adapter-registry";
import { GitHubControlPlane } from "../src/github/controlPlane";
import { createTaskSpec } from "../src/schema";
import {
  createAppWithRegistry,
  createTestConfig,
  createHealthyHealth,
  createTempDir,
  FakeAdapter,
  makeCapability,
  routing
} from "./helpers";

test("Codex head orchestrates local execution, GitHub review, and synthesis", async () => {
  const root = createTempDir("codex-head-integration-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async (task, runtime) => ({
      task_id: task.task_id,
      worker_target: task.worker_target,
      status: "awaiting_review",
      summary: "Patch prepared by Claude Code",
      artifacts: [runtime.task_file],
      patch_ref: runtime.task_file,
      log_ref: null,
      cost: 0,
      duration_ms: 250,
      next_action: "review",
      review_notes: []
    })
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async (task, runtime) => ({
      task_id: task.task_id,
      worker_target: task.worker_target,
      status: "completed",
      summary: `Codex synthesized ${task.goal}`,
      artifacts: [runtime.task_file],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 100,
      next_action: "none",
      review_notes: []
    })
  ));

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("GitHub review should not run locally");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const orchestrator = createAppWithRegistry(root, registry);

  const implementation = orchestrator.submitTask(createTaskSpec({
    goal: "Implement the orchestrator slice",
    repo: root,
    worker_target: "claude-code",
    expected_output: { kind: "patch", format: "patch", code_change: true },
    review_policy: { required_reviewers: ["codex-cli", "gemini-cli"], require_all: true }
  }));
  orchestrator.enqueueTask(implementation.task.task_id);

  const implementationOutcome = await orchestrator.dispatchNext();
  assert.equal(implementationOutcome?.state, "awaiting_review");
  const implementationRecord = orchestrator.getTask(implementation.task.task_id);
  assert.equal(implementationRecord.state, "awaiting_review");

  const reviewTask = orchestrator.submitTask(createTaskSpec({
    goal: "Review the generated patch in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    input_artifacts: [implementationRecord.result?.patch_ref ?? ""],
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  }));
  orchestrator.enqueueTask(reviewTask.task.task_id);

  const reviewOutcome = await orchestrator.dispatchNext();
  assert.equal(reviewOutcome?.state, "running");
  const payloadPath = `${root}/artifacts/${reviewTask.task.task_id}/github-dispatch.json`;
  assert.equal(existsSync(payloadPath), true);

  const completedReview = orchestrator.acceptWorkerResult({
    task_id: reviewTask.task.task_id,
    worker_target: "gemini-cli",
    status: "completed",
    summary: "Gemini approved the PR",
    artifacts: [payloadPath],
    patch_ref: null,
    log_ref: null,
    cost: 0,
    duration_ms: 50,
    next_action: "none",
    review_notes: ["LGTM"]
  }, routing("gemini-cli", "github"));
  assert.equal(completedReview.state, "completed");

  const synthesisTask = orchestrator.submitTask(createTaskSpec({
    goal: "Synthesize final verdict",
    repo: root,
    worker_target: "codex-cli",
    input_artifacts: [implementationRecord.result?.patch_ref ?? "", payloadPath],
    expected_output: { kind: "report", format: "markdown", code_change: false }
  }));
  orchestrator.enqueueTask(synthesisTask.task.task_id);

  const synthesisOutcome = await orchestrator.dispatchNext();
  assert.equal(synthesisOutcome?.state, "completed");
});

test("planner-generated tasks can be enqueued before dispatch", async () => {
  const root = createTempDir("codex-head-plan-enqueue-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("GitHub review should not run locally");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const orchestrator = createAppWithRegistry(root, registry);
  const plan = orchestrator.planGoal("Review the latest PR in GitHub", root);
  const [record] = orchestrator.savePlannedTasks(plan);
  assert.equal(record.state, "planned");

  const queued = orchestrator.enqueueTask(record.task.task_id);
  assert.equal(queued.state, "queued");

  const outcome = await orchestrator.dispatchNext();
  assert.equal(outcome?.state, "running");
});

test("runGoal plans, enqueues, mirrors, and reconciles a GitHub task automatically", async () => {
  const root = createTempDir("codex-head-run-goal-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("GitHub review should not run locally");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const config = createTestConfig(root);
  config.github.dispatch_mode = "gh_cli";
  config.github.repository = "example/repo";
  const orchestrator = createAppWithRegistry(root, registry, config);

  let publishedTaskId = "";
  let waitedTaskId = "";
  (orchestrator as any).github = {
    prepareDispatch: (task: any) => ({
      workflow_name: "codex-head-gemini-review.yml",
      payload_path: `${root}/${task.task_id}-dispatch.json`,
      workflow_inputs_path: `${root}/${task.task_id}-inputs.json`,
      issue_path: `${root}/${task.task_id}-issue.md`,
      pr_path: null
    }),
    publishMirror: (task: any) => {
      publishedTaskId = task.task_id;
      return {
        repository: "example/repo",
        issue_command: ["gh", "issue", "create"],
        issue_stdout: "https://github.com/example/repo/issues/123",
        issue_stderr: "",
        issue_created: true,
        pr_command: null,
        pr_stdout: "",
        pr_stderr: "",
        pr_created: false,
        mirror: {
          issue: {
            number: 123,
            url: "https://github.com/example/repo/issues/123",
            title: `Codex Head task ${task.task_id}: ${task.goal}`
          },
          pull_request: null,
          issue_error: null,
          pull_request_error: null,
          updated_at: Date.now()
        }
      };
    },
    shouldDispatchLive: () => true,
    dispatchWorkflow: (task: any) => ({
      workflow_name: "codex-head-gemini-review.yml",
      repository: "example/repo",
      dispatched_at: new Date().toISOString(),
      command: ["gh", "workflow", "run"],
      input_keys: ["task_id"],
      gh_cli_path: "gh",
      gh_authenticated: true,
      gh_exit_code: 0,
      gh_stdout: "https://github.com/example/repo/actions/runs/987",
      gh_stderr: "",
      run: {
        run_id: 987,
        run_url: "https://github.com/example/repo/actions/runs/987",
        workflow_name: "codex-head-gemini-review.yml",
        status: "requested",
        conclusion: null,
        updated_at: Date.now()
      },
      run_lookup: "stdout"
    }),
    waitForRunCompletion: async (taskId: string) => {
      waitedTaskId = taskId;
      return {
        run_id: 987,
        run_url: "https://github.com/example/repo/actions/runs/987",
        workflow_name: "codex-head-gemini-review.yml",
        status: "completed",
        conclusion: "success",
        updated_at: Date.now()
      };
    },
    downloadCallbackArtifact: (taskId: string) => {
      const callbackPath = orchestrator.artifactStore.writeJson(taskId, "run-goal-callback.json", {
        task_id: taskId,
        worker_target: "gemini-cli",
        status: "completed",
        review_verdict: "commented",
        summary: "Automatic run-goal completed",
        artifacts: [],
        patch_ref: null,
        log_ref: null,
        cost: 0,
        duration_ms: 0,
        next_action: "review",
        review_notes: []
      });
      return {
        task_id: taskId,
        repository: "example/repo",
        download_dir: root,
        callback_path: callbackPath,
        artifact_name: "codex-head-github-callback",
        run_id: 987
      };
    },
    resolveTaskRun: () => null
  };

  const result = await orchestrator.runGoal("Review the latest PR in GitHub", {
    publish_github_mirror: true,
    timeout_sec: 1,
    interval_sec: 1
  });

  assert.equal(result.plan.tasks.length, 1);
  assert.equal(result.mirror?.detail.includes("Published GitHub issue mirror"), true);
  assert.equal(result.outcome.state, "completed");
  assert.equal(result.task.state, "completed");
  assert.equal(result.task.github_mirror?.issue?.number, 123);
  assert.equal(result.task.github_run?.run_id, 987);
  assert.equal(publishedTaskId, result.task.task.task_id);
  assert.equal(waitedTaskId, result.task.task.task_id);
});

test("runGoal can keep GitHub mirrors while executing a GitHub-shaped task locally in local-preferred mode", async () => {
  const root = createTempDir("codex-head-run-goal-hybrid-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async (task, runtime) => ({
      task_id: task.task_id,
      worker_target: "gemini-cli",
      status: "completed",
      review_verdict: "commented",
      summary: "Local Gemini review completed",
      artifacts: [runtime.task_file],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 25,
      next_action: "none",
      review_notes: []
    })
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const config = createTestConfig(root);
  config.github.repository = "example/repo";
  config.github.execution_preference = "local_preferred";
  const orchestrator = createAppWithRegistry(root, registry, config);

  let dispatchCalled = false;
  let mirrorRoutingMode = "";
  (orchestrator as any).github = {
    prepareDispatch: (_task: any, routingInput: any) => {
      mirrorRoutingMode = routingInput.mode;
      return {
        workflow_name: "codex-head-gemini-review.yml",
        payload_path: `${root}/dispatch.json`,
        workflow_inputs_path: `${root}/inputs.json`,
        issue_path: `${root}/issue.md`,
        pr_path: null
      };
    },
    publishMirror: (task: any) => ({
      repository: "example/repo",
      issue_command: ["gh", "issue", "create"],
      issue_stdout: "https://github.com/example/repo/issues/456",
      issue_stderr: "",
      issue_created: true,
      pr_command: null,
      pr_stdout: "",
      pr_stderr: "",
      pr_created: false,
      mirror: {
        issue: {
          number: 456,
          url: "https://github.com/example/repo/issues/456",
          title: `Codex Head task ${task.task_id}: ${task.goal}`
        },
        pull_request: null,
        issue_error: null,
        pull_request_error: null,
        updated_at: Date.now()
      }
    }),
    shouldDispatchLive: () => true,
    dispatchWorkflow: () => {
      dispatchCalled = true;
      throw new Error("should not dispatch to GitHub");
    }
  };

  const result = await orchestrator.runGoal("Review the latest PR in GitHub", {
    publish_github_mirror: true
  });

  assert.equal(result.mirror?.detail.includes("Published GitHub issue mirror"), true);
  assert.equal(result.outcome.state, "completed");
  assert.equal(result.outcome.routing.mode, "local");
  assert.equal(result.outcome.routing.worker_target, "gemini-cli");
  assert.equal(result.task.state, "completed");
  assert.equal(result.task.github_mirror?.issue?.number, 456);
  assert.equal(mirrorRoutingMode, "local");
  assert.equal(dispatchCalled, false);
});

test("GitHub live dispatch fails fast when gh authentication is missing", async () => {
  const root = createTempDir("codex-head-live-dispatch-fail-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("GitHub review should not run locally");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const config = createTestConfig(root);
  config.github.dispatch_mode = "gh_cli";
  config.github.repository = "example/repo";
  const orchestrator = createAppWithRegistry(root, registry, config);
  (orchestrator as any).github = new GitHubControlPlane(config, orchestrator.artifactStore, {
    findBinary: () => "C:/Program Files/GitHub CLI/gh.exe",
    runCli: (args) => args[0] === "auth"
      ? {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "authentication required",
          durationMs: 1,
          timedOut: false
        }
      : {
          ok: true,
          exitCode: 0,
          stdout: "unexpected workflow dispatch",
          stderr: "",
          durationMs: 1,
          timedOut: false
        }
  });

  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Review the latest PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  }));
  orchestrator.enqueueTask(task.task.task_id);

  const outcome = await orchestrator.dispatchNext();
  assert.equal(outcome?.state, "failed");
  assert.match(outcome?.detail ?? "", /requires gh authentication/i);
  assert.equal(orchestrator.getTask(task.task.task_id).state, "failed");
});

test("local-preferred GitHub tasks can fall through from failed local execution into GitHub dispatch", async () => {
  const root = createTempDir("codex-head-hybrid-local-to-github-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async (task) => ({
      task_id: task.task_id,
      worker_target: "gemini-cli",
      status: "failed",
      review_verdict: null,
      summary: "Gemini local execution failed",
      artifacts: [],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 10,
      next_action: "manual",
      review_notes: ["quota exhausted"]
    })
  ));

  const config = createTestConfig(root);
  config.github.execution_preference = "local_preferred";
  config.github.repository = "example/repo";
  config.command_templates["codex-cli"].local = undefined;
  config.command_templates["claude-code"].local = undefined;
  const orchestrator = createAppWithRegistry(root, registry, config);

  (orchestrator as any).github = {
    prepareDispatch: (task: any) => ({
      workflow_name: "codex-head-gemini-review.yml",
      payload_path: `${root}/${task.task_id}-dispatch.json`,
      workflow_inputs_path: `${root}/${task.task_id}-inputs.json`,
      issue_path: `${root}/${task.task_id}-issue.md`,
      pr_path: null
    }),
    shouldDispatchLive: () => false
  };

  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Review the latest PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  }));
  orchestrator.enqueueTask(task.task.task_id);

  const outcome = await orchestrator.dispatchNext();
  assert.equal(outcome?.state, "running");
  assert.equal(outcome?.routing.mode, "github");
  assert.equal(outcome?.routing.worker_target, "gemini-cli");

  const attempts = JSON.parse(
    readFileSync(`${root}/artifacts/${task.task.task_id}/execution-attempts.json`, "utf8")
  ) as {
    attempts: Array<{ routing: { mode: string } }>;
  };
  assert.equal(attempts.attempts.length, 1);
  assert.equal(attempts.attempts[0]?.routing.mode, "local");
});

test("syncGitHubCallback downloads and ingests a callback artifact into task state", async () => {
  const root = createTempDir("codex-head-sync-callback-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("GitHub review should not run locally");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const config = createTestConfig(root);
  config.github.repository = "example/repo";
  const orchestrator = createAppWithRegistry(root, registry, config);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Review the latest PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  }));

  orchestrator.enqueueTask(task.task.task_id);
  const dispatchOutcome = await orchestrator.dispatchNext();
  assert.equal(dispatchOutcome?.state, "running");

  const callbackPath = orchestrator.artifactStore.writeJson(task.task.task_id, "downloaded-callback.json", {
    task_id: task.task.task_id,
    worker_target: "gemini-cli",
    status: "completed",
    review_verdict: "commented",
    summary: "GitHub callback downloaded and ingested",
    artifacts: [],
    patch_ref: null,
    log_ref: null,
    cost: 0,
    duration_ms: 0,
    next_action: "review",
    review_notes: []
  });

  (orchestrator as any).github = {
    resolveTaskRun: () => null,
    downloadCallbackArtifact: () => ({
      task_id: task.task.task_id,
      repository: "example/repo",
      download_dir: root,
      callback_path: callbackPath,
      artifact_name: "codex-head-github-callback"
    })
  };

  const syncOutcome = orchestrator.syncGitHubCallback(task.task.task_id);
  assert.equal(syncOutcome.state, "completed");
  assert.equal(orchestrator.getTask(task.task.task_id).state, "completed");
});

test("syncGitHubCallback surfaces queued self-hosted diagnosis when callback download is not ready", async () => {
  const root = createTempDir("codex-head-sync-callback-queued-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("GitHub review should not run locally");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const config = createTestConfig(root);
  config.github.repository = "example/repo";
  const orchestrator = createAppWithRegistry(root, registry, config);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Review the latest PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  }));

  orchestrator.enqueueTask(task.task.task_id);
  const dispatchOutcome = await orchestrator.dispatchNext();
  assert.equal(dispatchOutcome?.state, "running");

  (orchestrator as any).github = {
    resolveTaskRun: () => ({
      run_id: 987,
      run_url: "https://github.com/example/repo/actions/runs/987",
      workflow_name: "codex-head-gemini-review.yml",
      status: "queued",
      conclusion: null,
      updated_at: Date.now()
    }),
    downloadCallbackArtifact: () => {
      throw new Error("GitHub callback download failed: no callback artifact is available yet");
    },
    diagnoseQueuedRunIfPresent: () => {
      orchestrator.artifactStore.writeJson(task.task.task_id, "github-queue-diagnosis.json", {
        task_id: task.task.task_id,
        run_id: 987,
        reason: "Matching self-hosted runners are all busy.",
        suggested_action: "Consider recycling the self-hosted runner before retrying."
      });
      return {
        reason: "Matching self-hosted runners are all busy.",
        suggested_action: "Consider recycling the self-hosted runner before retrying."
      };
    }
  };

  assert.throws(
    () => orchestrator.syncGitHubCallback(task.task.task_id),
    /all busy|recycling the self-hosted runner|github-queue-diagnosis\.json/i
  );
});

test("waitForGitHubCallback waits on a resolved run and ingests the callback", async () => {
  const root = createTempDir("codex-head-wait-callback-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("GitHub review should not run locally");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const config = createTestConfig(root);
  config.github.repository = "example/repo";
  const orchestrator = createAppWithRegistry(root, registry, config);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Review the latest PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  }));

  orchestrator.enqueueTask(task.task.task_id);
  const dispatchOutcome = await orchestrator.dispatchNext();
  assert.equal(dispatchOutcome?.state, "running");

  const callbackPath = orchestrator.artifactStore.writeJson(task.task.task_id, "waited-callback.json", {
    task_id: task.task.task_id,
    worker_target: "gemini-cli",
    status: "completed",
    review_verdict: "commented",
    summary: "GitHub callback waited and ingested",
    artifacts: [],
    patch_ref: null,
    log_ref: null,
    cost: 0,
    duration_ms: 0,
    next_action: "review",
    review_notes: []
  });

  (orchestrator as any).github = {
    resolveTaskRun: () => ({
      run_id: 456,
      run_url: "https://github.com/example/repo/actions/runs/456",
      workflow_name: "codex-head-gemini-review.yml",
      status: "requested",
      conclusion: null,
      updated_at: Date.now()
    }),
    waitForRunCompletion: async () => ({
      run_id: 456,
      run_url: "https://github.com/example/repo/actions/runs/456",
      workflow_name: "codex-head-gemini-review.yml",
      status: "completed",
      conclusion: "success",
      updated_at: Date.now()
    }),
    downloadCallbackArtifact: () => ({
      task_id: task.task.task_id,
      repository: "example/repo",
      download_dir: root,
      callback_path: callbackPath,
      artifact_name: "codex-head-github-callback",
      run_id: 456
    })
  };

  const waited = await orchestrator.waitForGitHubCallback(task.task.task_id, 1, 1);
  assert.equal(waited.state, "completed");
  assert.equal(orchestrator.getTask(task.task.task_id).state, "completed");
  assert.equal(orchestrator.getTask(task.task.task_id).github_run?.run_id, 456);
});

test("recoverRunningTasks resolves a GitHub run through the real control plane binding", async () => {
  const root = createTempDir("codex-head-recover-gh-binding-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("GitHub review should not run locally");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const config = createTestConfig(root);
  config.github.repository = "example/repo";
  const orchestrator = createAppWithRegistry(root, registry, config);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Review the latest PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  }));

  orchestrator.enqueueTask(task.task.task_id);
  const dispatchOutcome = await orchestrator.dispatchNext();
  assert.equal(dispatchOutcome?.state, "running");

  (orchestrator as any).github = new GitHubControlPlane(config, orchestrator.artifactStore, {
    findBinary: () => "C:/Program Files/GitHub CLI/gh.exe",
    runCli: (args) => {
      if (args[0] === "auth") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "Logged in",
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
            databaseId: 654,
            displayTitle: `codex-head task ${task.task.task_id}`,
            event: "workflow_dispatch",
            headBranch: task.task.base_branch,
            status: "completed",
            conclusion: "success",
            url: "https://github.com/example/repo/actions/runs/654",
            workflowName: config.github.review_workflow,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }]),
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
            databaseId: 654,
            status: "completed",
            conclusion: "success",
            url: "https://github.com/example/repo/actions/runs/654",
            workflowName: config.github.review_workflow,
            updatedAt: new Date().toISOString()
          }),
          stderr: "",
          durationMs: 1,
          timedOut: false
        };
      }
      if (args[0] === "run" && args[1] === "download") {
        const downloadDir = args[args.indexOf("--dir") + 1]!;
        mkdirSync(downloadDir, { recursive: true });
        writeFileSync(
          `${downloadDir}\\github-callback.json`,
          JSON.stringify({
            task_id: task.task.task_id,
            worker_target: "gemini-cli",
            status: "completed",
            review_verdict: "commented",
            summary: "Recovered GitHub task completed",
            artifacts: [],
            patch_ref: null,
            log_ref: null,
            cost: 0,
            duration_ms: 0,
            next_action: "review",
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
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    }
  });

  const recovered = await orchestrator.recoverRunningTasks({ timeout_sec: 1, interval_sec: 1 });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.status, "reconciled");
  assert.equal(orchestrator.getTask(task.task.task_id).state, "completed");
  assert.equal(orchestrator.getTask(task.task.task_id).github_run?.run_id, 654);
});

test("recoverRunningTasks preserves queued wait detail when fallback sync also fails", async () => {
  const root = createTempDir("codex-head-recover-gh-queued-detail-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("GitHub review should not run locally");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const config = createTestConfig(root);
  config.github.repository = "example/repo";
  const orchestrator = createAppWithRegistry(root, registry, config);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Review the latest PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  }));

  orchestrator.enqueueTask(task.task.task_id);
  const dispatchOutcome = await orchestrator.dispatchNext();
  assert.equal(dispatchOutcome?.state, "running");

  (orchestrator as any).github = {
    resolveTaskRun: () => ({
      run_id: 321,
      run_url: "https://github.com/example/repo/actions/runs/321",
      workflow_name: "codex-head-gemini-review.yml",
      status: "queued",
      conclusion: null,
      updated_at: Date.now()
    }),
    waitForRunCompletion: async () => {
      orchestrator.artifactStore.writeJson(task.task.task_id, "github-queue-diagnosis.json", {
        task_id: task.task.task_id,
        run_id: 321,
        reason: "The run is still queued even though a matching self-hosted runner appears online and idle; a stale broker session is likely.",
        suggested_action: "Consider recycling the self-hosted runner before retrying."
      });
      orchestrator.artifactStore.writeJson(task.task.task_id, "github-queue-recycle.json", {
        task_id: task.task.task_id,
        run_id: 321,
        ok: true,
        skipped: false,
        detail: "Automatic self-hosted runner recycle completed successfully."
      });
      throw new Error(
        `GitHub run 321 appears stuck in queued state for task ${task.task.task_id}: `
        + "The run is still queued even though a matching self-hosted runner appears online and idle; a stale broker session is likely."
      );
    },
    downloadCallbackArtifact: () => {
      throw new Error("GitHub callback download failed: no callback artifact is available yet");
    },
    diagnoseQueuedRunIfPresent: () => ({
      reason: "The run is still queued even though a matching self-hosted runner appears online and idle; a stale broker session is likely.",
      suggested_action: "Consider recycling the self-hosted runner before retrying."
    })
  };

  const recovered = await orchestrator.recoverRunningTasks({ timeout_sec: 1, interval_sec: 1 });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.status, "failed");
  assert.match(recovered[0]?.detail ?? "", /stuck in queued state/i);
  assert.match(recovered[0]?.detail ?? "", /Fallback callback sync also failed/i);
  assert.match(recovered[0]?.detail ?? "", /github-queue-diagnosis\.json/i);
  assert.match(recovered[0]?.detail ?? "", /manual intervention is now required/i);
  assert.match(recovered[0]?.detail ?? "", /github-queue-recycle\.json/i);
  assert.equal(recovered[0]?.operator?.manual_intervention_required, true);
  assert.match(recovered[0]?.operator?.summary ?? "", /manual intervention is now required/i);
  assert.equal(
    recovered[0]?.operator?.actions.some((value) => /inspect .*github-queue-recycle\.json/i.test(value)),
    true
  );

  const record = orchestrator.getTask(task.task.task_id);
  assert.equal(record.state, "failed");
  assert.match(record.last_error ?? "", /Fallback callback sync also failed/i);
  assert.match(record.last_error ?? "", /manual intervention is now required/i);
});

test("recoverRunningTasks fails unresolved GitHub tasks when no run or callback can be found", async () => {
  const root = createTempDir("codex-head-recover-gh-failed-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("GitHub review should not run locally");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const config = createTestConfig(root);
  config.github.repository = "OWNER/REPO";
  const orchestrator = createAppWithRegistry(root, registry, config);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Review the latest PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  }));

  orchestrator.enqueueTask(task.task.task_id);
  const dispatchOutcome = await orchestrator.dispatchNext();
  assert.equal(dispatchOutcome?.state, "running");

  const recovered = await orchestrator.recoverRunningTasks({ timeout_sec: 1, interval_sec: 1 });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.status, "failed");
  assert.match(recovered[0]?.detail ?? "", /requires github\.repository to be configured|does not have a resolved GitHub workflow run yet/i);
  assert.equal(recovered[0]?.operator?.manual_intervention_required, false);
  assert.equal(
    recovered[0]?.operator?.actions.some((value) => /set github\.repository or dispatch the task again/i.test(value)),
    true
  );

  const record = orchestrator.getTask(task.task.task_id);
  assert.equal(record.state, "failed");
  assert.equal(record.result?.worker_target, "gemini-cli");
  assert.equal(existsSync(`${root}/artifacts/${task.task.task_id}/recovery-result.json`), true);
});

test("publishGitHubMirror persists GitHub mirror metadata on the task", () => {
  const root = createTempDir("codex-head-publish-mirror-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const config = createTestConfig(root);
  config.github.repository = "example/repo";
  const orchestrator = createAppWithRegistry(root, registry, config);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Open a PR mirror for this task",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "pull_request", format: "markdown", code_change: true },
    artifact_policy: { mode: "branch_pr", require_lineage: true },
    requires_github: true
  }));

  (orchestrator as any).github = {
    prepareDispatch: () => ({
      workflow_name: "codex-head-worker.yml",
      payload_path: `${root}/github-dispatch.json`,
      workflow_inputs_path: `${root}/github-worker-inputs.json`,
      issue_path: `${root}/github-issue.md`,
      pr_path: `${root}/github-pr.md`
    }),
    publishMirror: () => ({
      repository: "example/repo",
      issue_command: ["gh", "issue", "create"],
      issue_stdout: "https://github.com/example/repo/issues/123",
      issue_stderr: "",
      issue_created: true,
      pr_command: ["gh", "pr", "create"],
      pr_stdout: "https://github.com/example/repo/pull/456",
      pr_stderr: "",
      pr_created: true,
      mirror: {
        issue: {
          number: 123,
          url: "https://github.com/example/repo/issues/123",
          title: `Codex Head task ${task.task.task_id}: ${task.task.goal}`
        },
        pull_request: {
          number: 456,
          url: "https://github.com/example/repo/pull/456",
          title: `Codex Head: ${task.task.goal}`
        },
        issue_error: null,
        pull_request_error: null,
        updated_at: Date.now()
      }
    })
  };

  const outcome = orchestrator.publishGitHubMirror(task.task.task_id);
  assert.equal(outcome.state, "planned");
  const record = orchestrator.getTask(task.task.task_id);
  assert.equal(record.github_mirror?.issue?.number, 123);
  assert.equal(record.github_mirror?.pull_request?.number, 456);
});

test("dispatchAndWait dispatches a GitHub task and reconciles its callback in one call", async () => {
  const root = createTempDir("codex-head-dispatch-and-wait-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("GitHub review should not run locally");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const config = createTestConfig(root);
  config.github.dispatch_mode = "gh_cli";
  config.github.repository = "example/repo";
  const orchestrator = createAppWithRegistry(root, registry, config);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Review the latest PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  }));

  orchestrator.enqueueTask(task.task.task_id);
  const callbackPath = orchestrator.artifactStore.writeJson(task.task.task_id, "dispatch-and-wait-callback.json", {
    task_id: task.task.task_id,
    worker_target: "gemini-cli",
    status: "completed",
    review_verdict: "commented",
    summary: "Dispatch and wait completed",
    artifacts: [],
    patch_ref: null,
    log_ref: null,
    cost: 0,
    duration_ms: 0,
    next_action: "review",
    review_notes: []
  });

  (orchestrator as any).github = {
    prepareDispatch: () => ({
      workflow_name: "codex-head-gemini-review.yml",
      payload_path: `${root}/dispatch.json`,
      workflow_inputs_path: `${root}/inputs.json`,
      issue_path: `${root}/issue.md`,
      pr_path: null
    }),
    shouldDispatchLive: () => true,
    dispatchWorkflow: () => ({
      workflow_name: "codex-head-gemini-review.yml",
      repository: "example/repo",
      dispatched_at: new Date().toISOString(),
      command: ["gh", "workflow", "run"],
      input_keys: ["task_id"],
      gh_cli_path: "gh",
      gh_authenticated: true,
      gh_exit_code: 0,
      gh_stdout: "https://github.com/example/repo/actions/runs/789",
      gh_stderr: "",
      run: {
        run_id: 789,
        run_url: "https://github.com/example/repo/actions/runs/789",
        workflow_name: "codex-head-gemini-review.yml",
        status: "requested",
        conclusion: null,
        updated_at: Date.now()
      },
      run_lookup: "stdout"
    }),
    waitForRunCompletion: async () => ({
      run_id: 789,
      run_url: "https://github.com/example/repo/actions/runs/789",
      workflow_name: "codex-head-gemini-review.yml",
      status: "completed",
      conclusion: "success",
      updated_at: Date.now()
    }),
    downloadCallbackArtifact: () => ({
      task_id: task.task.task_id,
      repository: "example/repo",
      download_dir: root,
      callback_path: callbackPath,
      artifact_name: "codex-head-github-callback",
      run_id: 789
    })
  };

  const outcome = await orchestrator.dispatchAndWait(task.task.task_id, 1, 1);
  assert.equal(outcome.state, "completed");
  assert.equal(orchestrator.getTask(task.task.task_id).github_run?.run_id, 789);
});

test("dispatchAndWait returns the prepared GitHub dispatch when live dispatch is disabled", async () => {
  const root = createTempDir("codex-head-dispatch-and-wait-artifacts-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("GitHub review should not run locally");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const config = createTestConfig(root);
  config.github.dispatch_mode = "artifacts_only";
  config.github.repository = "example/repo";
  const orchestrator = createAppWithRegistry(root, registry, config);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Review the latest PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  }));

  orchestrator.enqueueTask(task.task.task_id);
  const outcome = await orchestrator.dispatchAndWait(task.task.task_id, 1, 1);
  assert.equal(outcome.state, "running");
  assert.match(outcome.detail, /Prepared GitHub payload/i);
  assert.equal(orchestrator.getTask(task.task.task_id).state, "running");
  assert.equal(orchestrator.getTask(task.task.task_id).github_run, null);
});

test("reconcileRunningGitHubTasks processes running GitHub tasks in batch", async () => {
  const root = createTempDir("codex-head-reconcile-running-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("GitHub review should not run locally");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const config = createTestConfig(root);
  config.github.repository = "example/repo";
  const orchestrator = createAppWithRegistry(root, registry, config);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Review the latest PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  }));

  orchestrator.enqueueTask(task.task.task_id);
  const dispatchOutcome = await orchestrator.dispatchNext();
  assert.equal(dispatchOutcome?.state, "running");

  const callbackPath = orchestrator.artifactStore.writeJson(task.task.task_id, "reconciled-callback.json", {
    task_id: task.task.task_id,
    worker_target: "gemini-cli",
    status: "completed",
    review_verdict: "commented",
    summary: "Batch reconcile completed",
    artifacts: [],
    patch_ref: null,
    log_ref: null,
    cost: 0,
    duration_ms: 0,
    next_action: "review",
    review_notes: []
  });

  (orchestrator as any).github = {
    resolveTaskRun: () => ({
      run_id: 321,
      run_url: "https://github.com/example/repo/actions/runs/321",
      workflow_name: "codex-head-gemini-review.yml",
      status: "requested",
      conclusion: null,
      updated_at: Date.now()
    }),
    waitForRunCompletion: async () => ({
      run_id: 321,
      run_url: "https://github.com/example/repo/actions/runs/321",
      workflow_name: "codex-head-gemini-review.yml",
      status: "completed",
      conclusion: "success",
      updated_at: Date.now()
    }),
    downloadCallbackArtifact: () => ({
      task_id: task.task.task_id,
      repository: "example/repo",
      download_dir: root,
      callback_path: callbackPath,
      artifact_name: "codex-head-github-callback",
      run_id: 321
    })
  };

  const reconciled = await orchestrator.reconcileRunningGitHubTasks(1, 1);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.status, "reconciled");
  assert.equal(reconciled[0]?.operator?.manual_intervention_required, false);
  assert.equal(reconciled[0]?.operator?.summary, null);
  assert.deepEqual(reconciled[0]?.operator?.actions, []);
  assert.equal(orchestrator.getTask(task.task.task_id).state, "completed");
});

test("reconcileRunningGitHubTasks surfaces operator guidance for queued self-hosted stalls", async () => {
  const root = createTempDir("codex-head-reconcile-gh-queued-detail-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("GitHub review should not run locally");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const config = createTestConfig(root);
  config.github.repository = "example/repo";
  const orchestrator = createAppWithRegistry(root, registry, config);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Review the latest PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  }));

  orchestrator.enqueueTask(task.task.task_id);
  const dispatchOutcome = await orchestrator.dispatchNext();
  assert.equal(dispatchOutcome?.state, "running");

  (orchestrator as any).github = {
    resolveTaskRun: () => ({
      run_id: 432,
      run_url: "https://github.com/example/repo/actions/runs/432",
      workflow_name: "codex-head-gemini-review.yml",
      status: "queued",
      conclusion: null,
      updated_at: Date.now()
    }),
    waitForRunCompletion: async () => {
      orchestrator.artifactStore.writeJson(task.task.task_id, "github-queue-diagnosis.json", {
        task_id: task.task.task_id,
        run_id: 432,
        reason: "The run is still queued even though a matching self-hosted runner appears online and idle; a stale broker session is likely.",
        suggested_action: "Consider recycling the self-hosted runner before retrying."
      });
      orchestrator.artifactStore.writeJson(task.task.task_id, "github-queue-recycle.json", {
        task_id: task.task.task_id,
        run_id: 432,
        ok: true,
        skipped: false,
        detail: "Automatic self-hosted runner recycle completed successfully."
      });
      throw new Error(
        `GitHub run 432 appears stuck in queued state for task ${task.task.task_id}: `
        + "The run is still queued even though a matching self-hosted runner appears online and idle; a stale broker session is likely. "
        + `Automatic stale-runner recovery was already attempted and manual intervention is now required. See ${root}\\artifacts\\${task.task.task_id}\\github-queue-recycle.json.`
      );
    },
    diagnoseQueuedRunIfPresent: () => ({
      reason: "The run is still queued even though a matching self-hosted runner appears online and idle; a stale broker session is likely.",
      suggested_action: "Consider recycling the self-hosted runner before retrying."
    })
  };

  const reconciled = await orchestrator.reconcileRunningGitHubTasks(1, 1);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.status, "error");
  assert.match(reconciled[0]?.detail ?? "", /stuck in queued state/i);
  assert.equal(reconciled[0]?.operator?.manual_intervention_required, true);
  assert.match(reconciled[0]?.operator?.summary ?? "", /manual intervention is now required/i);
  assert.equal(
    reconciled[0]?.operator?.actions.some((value) => /inspect .*github-queue-recycle\.json/i.test(value)),
    true
  );
});

test("reconcileRunningGitHubTasks recommends repository setup when the GitHub run cannot be resolved", async () => {
  const root = createTempDir("codex-head-reconcile-gh-unresolved-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("GitHub review should not run locally");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const config = createTestConfig(root);
  config.github.repository = "OWNER/REPO";
  const orchestrator = createAppWithRegistry(root, registry, config);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Review the latest PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  }));

  orchestrator.enqueueTask(task.task.task_id);
  const dispatchOutcome = await orchestrator.dispatchNext();
  assert.equal(dispatchOutcome?.state, "running");

  const reconciled = await orchestrator.reconcileRunningGitHubTasks(1, 1);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.status, "error");
  assert.match(reconciled[0]?.detail ?? "", /requires github\.repository to be configured|does not have a resolved GitHub workflow run yet/i);
  assert.equal(reconciled[0]?.operator?.manual_intervention_required, false);
  assert.equal(
    reconciled[0]?.operator?.actions.some((value) => /set github\.repository or dispatch the task again/i.test(value)),
    true
  );
});

test("recoverRunningTasks marks interrupted local tasks as failed", async () => {
  const root = createTempDir("codex-head-recover-local-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    { worker_target: "antigravity", healthy: false, reason: "disabled", detected_binary: null },
    async () => {
      throw new Error("should not execute");
    }
  ));

  const orchestrator = createAppWithRegistry(root, registry);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Summarize the current orchestration state",
    repo: root,
    worker_target: "codex-cli"
  }));

  orchestrator.enqueueTask(task.task.task_id);
  orchestrator.taskStore.claimTask(task.task.task_id);

  const recovered = await orchestrator.recoverRunningTasks();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.status, "failed");
  assert.match(recovered[0]?.detail ?? "", /Recovered interrupted local task/i);
  assert.equal(recovered[0]?.operator?.manual_intervention_required, false);
  assert.equal(
    recovered[0]?.operator?.actions.some((value) => /rerun it manually|inspect the interrupted local task/i.test(value)),
    true
  );

  const record = orchestrator.getTask(task.task.task_id);
  assert.equal(record.state, "failed");
  assert.equal(record.result?.worker_target, "codex-cli");
  assert.equal(existsSync(`${root}/artifacts/${task.task.task_id}/recovery-result.json`), true);
});

test("recoverRunningTasks can requeue interrupted local tasks", async () => {
  const root = createTempDir("codex-head-recover-requeue-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    { worker_target: "antigravity", healthy: false, reason: "disabled", detected_binary: null },
    async () => {
      throw new Error("should not execute");
    }
  ));

  const orchestrator = createAppWithRegistry(root, registry);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Summarize the current orchestration state",
    repo: root,
    worker_target: "codex-cli"
  }));

  orchestrator.enqueueTask(task.task.task_id);
  orchestrator.taskStore.claimTask(task.task.task_id);

  const recovered = await orchestrator.recoverRunningTasks({ requeue_local: true });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.status, "requeued");
  assert.equal(
    recovered[0]?.operator?.actions.some((value) => /dispatch the requeued local task/i.test(value)),
    true
  );

  const record = orchestrator.getTask(task.task.task_id);
  assert.equal(record.state, "queued");
  assert.equal(record.last_error, null);
});

test("sweepTasks can dry-run cancel selected backlog tasks without mutating state", async () => {
  const root = createTempDir("codex-head-sweep-dry-run-");
  const registry = new AdapterRegistry();
  const orchestrator = createAppWithRegistry(root, registry);

  const queuedTask = orchestrator.submitTask(createTaskSpec({
    task_id: "task-sweep-queued",
    goal: "Summarize the current orchestration state",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  }));
  orchestrator.enqueueTask(queuedTask.task.task_id);

  const failedTask = orchestrator.submitTask(createTaskSpec({
    task_id: "task-sweep-failed",
    goal: "Summarize the current orchestration state",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  }));
  orchestrator.enqueueTask(failedTask.task.task_id);
  orchestrator.taskStore.claimTask(failedTask.task.task_id);
  orchestrator.taskStore.finish(
    failedTask.task.task_id,
    "failed",
    {
      task_id: failedTask.task.task_id,
      worker_target: "gemini-cli",
      status: "failed",
      review_verdict: null,
      summary: "Task failed",
      artifacts: [],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 0,
      next_action: "manual",
      review_notes: []
    },
    routing("gemini-cli", "local"),
    "Task failed"
  );

  const result = orchestrator.sweepTasks({
    action: "cancel",
    states: ["queued", "failed"],
    goal_contains: "summarize",
    dry_run: true
  });

  assert.equal(result.matched, 2);
  assert.equal(result.changed, 2);
  assert.deepEqual(result.tasks.map((entry) => entry.task_id), ["task-sweep-queued", "task-sweep-failed"]);
  assert.equal(orchestrator.getTask("task-sweep-queued").state, "queued");
  assert.equal(orchestrator.getTask("task-sweep-failed").state, "failed");
});

test("sweepTasks can requeue planned and failed tasks while skipping unsupported states", async () => {
  const root = createTempDir("codex-head-sweep-requeue-");
  const registry = new AdapterRegistry();
  const orchestrator = createAppWithRegistry(root, registry);

  const plannedTask = orchestrator.submitTask(createTaskSpec({
    task_id: "task-sweep-planned",
    goal: "Retry planned task",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  }));

  const failedTask = orchestrator.submitTask(createTaskSpec({
    task_id: "task-sweep-failed-requeue",
    goal: "Retry failed task",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  }));
  orchestrator.enqueueTask(failedTask.task.task_id);
  orchestrator.taskStore.claimTask(failedTask.task.task_id);
  orchestrator.taskStore.finish(
    failedTask.task.task_id,
    "failed",
    {
      task_id: failedTask.task.task_id,
      worker_target: "gemini-cli",
      status: "failed",
      review_verdict: null,
      summary: "Task failed",
      artifacts: [],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 0,
      next_action: "manual",
      review_notes: []
    },
    routing("gemini-cli", "local"),
    "Task failed"
  );

  const queuedTask = orchestrator.submitTask(createTaskSpec({
    task_id: "task-sweep-queued-skip",
    goal: "Already queued task",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  }));
  orchestrator.enqueueTask(queuedTask.task.task_id);

  const result = orchestrator.sweepTasks({
    action: "requeue",
    task_ids: [
      plannedTask.task.task_id,
      failedTask.task.task_id,
      queuedTask.task.task_id
    ]
  });

  assert.equal(result.matched, 3);
  assert.equal(result.changed, 2);
  assert.equal(orchestrator.getTask(plannedTask.task.task_id).state, "queued");
  assert.equal(orchestrator.getTask(failedTask.task.task_id).state, "queued");
  assert.equal(orchestrator.getTask(queuedTask.task.task_id).state, "queued");
  assert.equal(
    result.tasks.find((entry) => entry.task_id === queuedTask.task.task_id)?.reason.includes("cannot be requeued"),
    true
  );
});

test("runDoctorHint defaults to dry-run and applies the selected structured sweep hint", async () => {
  const root = createTempDir("codex-head-run-doctor-hint-");
  const registry = new AdapterRegistry();
  const orchestrator = createAppWithRegistry(root, registry);

  const queuedTask = orchestrator.submitTask(createTaskSpec({
    task_id: "task-doctor-hint-queued",
    goal: "Summarize the current orchestration state",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  }));
  orchestrator.enqueueTask(queuedTask.task.task_id);

  const dryRun = await orchestrator.runDoctorHint("queued-backlog-1");
  assert.equal(dryRun.hint.id, "queued-backlog-1");
  assert.equal(dryRun.result.dry_run, true);
  assert.equal(dryRun.result.changed, 1);
  assert.equal(orchestrator.getTask(queuedTask.task.task_id).state, "queued");

  const applied = await orchestrator.runDoctorHint("queued-backlog-1", { apply: true });
  assert.equal(applied.result.dry_run, false);
  assert.equal(applied.result.changed, 1);
  assert.equal(orchestrator.getTask(queuedTask.task.task_id).state, "canceled");
});

test("runDoctorHint fails fast when the requested hint id does not exist", async () => {
  const root = createTempDir("codex-head-run-doctor-hint-missing-");
  const registry = new AdapterRegistry();
  const orchestrator = createAppWithRegistry(root, registry);

  await assert.rejects(
    () => orchestrator.runDoctorHint("missing-hint"),
    /doctor hint missing-hint was not found/i
  );
});

test("fallback execution accepts the actual routed worker target", async () => {
  const root = createTempDir("codex-head-fallback-worker-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    { worker_target: "claude-code", healthy: false, reason: "missing_binary", detected_binary: null },
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async (_task, runtime) => ({
      task_id: runtime.task_file.includes("task-input") ? JSON.parse(require("node:fs").readFileSync(runtime.task_file, "utf8")).task_id : "",
      worker_target: "codex-cli",
      status: "completed",
      summary: "Fallback adapter completed the task",
      artifacts: [runtime.task_file],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 25,
      next_action: "none",
      review_notes: []
    })
  ));

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const orchestrator = createAppWithRegistry(root, registry);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Implement a fallback-safe fix",
    repo: root,
    worker_target: "claude-code",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  }));

  orchestrator.enqueueTask(task.task.task_id);
  const outcome = await orchestrator.dispatchNext();
  assert.equal(outcome?.state, "completed");
  assert.equal(outcome?.routing.worker_target, "codex-cli");

  const record = orchestrator.getTask(task.task.task_id);
  assert.equal(record.result?.worker_target, "codex-cli");
  assert.equal(record.routing?.worker_target, "codex-cli");
  assert.equal(record.routing?.fallback_from, "claude-code");
});

test("local execution automatically falls back to the next healthy worker after a runtime failure", async () => {
  const root = createTempDir("codex-head-runtime-fallback-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async (task) => ({
      task_id: task.task_id,
      worker_target: "codex-cli",
      status: "failed",
      summary: "codex-cli failed with exit code 255",
      artifacts: [],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 10,
      next_action: "manual",
      review_notes: ["The network path was not found."]
    })
  ));

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async (task, runtime) => ({
      task_id: task.task_id,
      worker_target: "gemini-cli",
      status: "completed",
      summary: "Gemini fallback completed the task",
      artifacts: [runtime.task_file],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 15,
      next_action: "none",
      review_notes: []
    })
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    { worker_target: "antigravity", healthy: false, reason: "disabled", detected_binary: null },
    async () => {
      throw new Error("should not execute");
    }
  ));

  const orchestrator = createAppWithRegistry(root, registry);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Summarize the current orchestration state",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  }));

  orchestrator.enqueueTask(task.task.task_id);
  const outcome = await orchestrator.dispatchNext();
  assert.equal(outcome?.state, "completed");
  assert.equal(outcome?.routing.worker_target, "gemini-cli");
  assert.equal(outcome?.routing.fallback_from, "codex-cli");

  const record = orchestrator.getTask(task.task.task_id);
  assert.equal(record.result?.worker_target, "gemini-cli");
  assert.equal(record.routing?.worker_target, "gemini-cli");
  assert.equal(record.routing?.fallback_from, "codex-cli");

  const attemptsPath = `${root}/artifacts/${task.task.task_id}/execution-attempts.json`;
  assert.equal(existsSync(attemptsPath), true);
  const attempts = JSON.parse(readFileSync(attemptsPath, "utf8")) as {
    attempts: Array<{ routing: { worker_target: string }; result: { worker_target: string; status: string } }>;
  };
  assert.equal(attempts.attempts.length, 2);
  assert.equal(attempts.attempts[0]?.routing.worker_target, "codex-cli");
  assert.equal(attempts.attempts[0]?.result.status, "failed");
  assert.equal(attempts.attempts[1]?.routing.worker_target, "gemini-cli");
  assert.equal(attempts.attempts[1]?.result.worker_target, "gemini-cli");
});

test("dispatch runtime includes a standardized task prompt for local workers", async () => {
  const root = createTempDir("codex-head-runtime-prompt-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async (task, runtime) => ({
      task_id: task.task_id,
      worker_target: "codex-cli",
      status: "completed",
      summary: runtime.task_prompt,
      artifacts: [runtime.task_file],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 10,
      next_action: "none",
      review_notes: []
    })
  ));

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const orchestrator = createAppWithRegistry(root, registry);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Summarize the current orchestration state",
    repo: root,
    worker_target: "codex-cli"
  }));

  orchestrator.enqueueTask(task.task.task_id);
  const outcome = await orchestrator.dispatchNext();
  assert.equal(outcome?.state, "completed");

  const summary = orchestrator.getTask(task.task.task_id).result?.summary ?? "";
  assert.match(summary, /Codex Head/i);
  assert.match(summary, /task specification/i);
});

test("dispatchExistingTask claims the requested queued task instead of the next queue item", async () => {
  const root = createTempDir("codex-head-dispatch-specific-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("GitHub review should not run locally");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async (task, runtime) => ({
      task_id: task.task_id,
      worker_target: "codex-cli",
      status: "completed",
      summary: "Codex completed the targeted dispatch",
      artifacts: [runtime.task_file],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 10,
      next_action: "none",
      review_notes: []
    })
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const orchestrator = createAppWithRegistry(root, registry);
  const first = orchestrator.submitTask(createTaskSpec({
    goal: "Analyze task one",
    repo: root,
    worker_target: "codex-cli",
    priority: 10
  }));
  const second = orchestrator.submitTask(createTaskSpec({
    goal: "Review the latest PR in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true,
    priority: 90
  }));

  orchestrator.enqueueTask(first.task.task_id);
  orchestrator.enqueueTask(second.task.task_id);

  const outcome = await orchestrator.dispatchExistingTask(first.task.task_id);
  assert.equal(outcome.state, "completed");
  assert.equal(outcome.task_id, first.task.task_id);
  assert.equal(orchestrator.getTask(second.task.task_id).state, "queued");
});

test("smokeAdapters separates binary health from local readiness", async () => {
  const root = createTempDir("codex-head-readiness-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    { worker_target: "antigravity", healthy: false, reason: "disabled", detected_binary: null },
    async () => {
      throw new Error("should not execute");
    }
  ));

  const config = createTestConfig(root);
  config.command_templates["codex-cli"].local = undefined;
  const orchestrator = createAppWithRegistry(root, registry, config);
  const health = await orchestrator.smokeAdapters();

  const codexReadiness = health.readiness.find((entry: any) => entry.worker_target === "codex-cli");
  assert.ok(codexReadiness);
  assert.equal(codexReadiness.healthy, true);
  assert.equal(codexReadiness.has_local_template, false);
  assert.equal(codexReadiness.local_ready, false);

  const geminiReadiness = health.readiness.find((entry: any) => entry.worker_target === "gemini-cli");
  assert.ok(geminiReadiness);
  assert.equal(geminiReadiness.github_ready, true);
});

test("required reviews can complete a task through reviewer verdict aggregation", async () => {
  const root = createTempDir("codex-head-review-aggregation-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async (task, runtime) => ({
      task_id: task.task_id,
      worker_target: "claude-code",
      status: "awaiting_review",
      review_verdict: null,
      summary: "Patch prepared by Claude Code",
      artifacts: [runtime.task_file],
      patch_ref: runtime.task_file,
      log_ref: null,
      cost: 0,
      duration_ms: 50,
      next_action: "review",
      review_notes: []
    })
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const orchestrator = createAppWithRegistry(root, registry);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Implement the orchestrator slice",
    repo: root,
    worker_target: "claude-code",
    expected_output: { kind: "patch", format: "patch", code_change: true },
    review_policy: { required_reviewers: ["codex-cli", "gemini-cli"], require_all: true }
  }));

  orchestrator.enqueueTask(task.task.task_id);
  const executionOutcome = await orchestrator.dispatchNext();
  assert.equal(executionOutcome?.state, "awaiting_review");

  const firstReview = orchestrator.recordReview(task.task.task_id, "codex-cli", "approved", "Codex approves");
  assert.equal(firstReview.state, "awaiting_review");
  assert.equal(orchestrator.getTask(task.task.task_id).reviews.length, 1);

  const secondReview = orchestrator.recordReview(task.task.task_id, "gemini-cli", "approved", "Gemini approves");
  assert.equal(secondReview.state, "completed");

  const record = orchestrator.getTask(task.task.task_id);
  assert.equal(record.state, "completed");
  assert.equal(record.reviews.length, 2);
});

test("changes requested review fails the awaiting review task", async () => {
  const root = createTempDir("codex-head-review-reject-");
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async (task, runtime) => ({
      task_id: task.task_id,
      worker_target: "claude-code",
      status: "awaiting_review",
      review_verdict: null,
      summary: "Patch prepared by Claude Code",
      artifacts: [runtime.task_file],
      patch_ref: runtime.task_file,
      log_ref: null,
      cost: 0,
      duration_ms: 50,
      next_action: "review",
      review_notes: []
    })
  ));

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    createHealthyHealth("antigravity"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const orchestrator = createAppWithRegistry(root, registry);
  const task = orchestrator.submitTask(createTaskSpec({
    goal: "Implement the orchestrator slice",
    repo: root,
    worker_target: "claude-code",
    expected_output: { kind: "patch", format: "patch", code_change: true },
    review_policy: { required_reviewers: ["codex-cli"], require_all: true }
  }));

  orchestrator.enqueueTask(task.task.task_id);
  const executionOutcome = await orchestrator.dispatchNext();
  assert.equal(executionOutcome?.state, "awaiting_review");

  const reviewOutcome = orchestrator.recordReview(
    task.task.task_id,
    "codex-cli",
    "changes_requested",
    "Codex requests changes"
  );
  assert.equal(reviewOutcome.state, "failed");
  assert.equal(orchestrator.getTask(task.task.task_id).state, "failed");
});

test("recent local rate limits deprioritize the same worker on the next task", async () => {
  const root = createTempDir("codex-head-local-penalty-");
  const config = createTestConfig(root);
  config.github.enabled = false;
  const registry = new AdapterRegistry();
  let codexCalls = 0;

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async (task) => {
      codexCalls += 1;
      return {
        task_id: task.task_id,
        worker_target: "codex-cli",
        status: "failed",
        review_verdict: null,
        summary: "ERROR: You've hit your usage limit",
        artifacts: [],
        patch_ref: null,
        log_ref: null,
        cost: 0,
        duration_ms: 10,
        next_action: "manual",
        review_notes: ["usage limit hit"]
      };
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async (task, runtime) => ({
      task_id: task.task_id,
      worker_target: "gemini-cli",
      status: "completed",
      review_verdict: null,
      summary: "Gemini handled the analysis",
      artifacts: [runtime.task_file],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 20,
      next_action: "none",
      review_notes: []
    })
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    { worker_target: "antigravity", healthy: false, reason: "disabled", detected_binary: null },
    async () => {
      throw new Error("should not execute");
    }
  ));

  const orchestrator = createAppWithRegistry(root, registry, config);
  const prior = orchestrator.submitTask(createTaskSpec({
    goal: "Summarize the previous run",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  }));
  orchestrator.enqueueTask(prior.task.task_id);
  const claimed = orchestrator.taskStore.claimTask(prior.task.task_id);
  assert.ok(claimed);
  orchestrator.acceptWorkerResult({
    task_id: prior.task.task_id,
    worker_target: "codex-cli",
    status: "failed",
    review_verdict: null,
    summary: "ERROR: You've hit your usage limit",
    artifacts: [],
    patch_ref: null,
    log_ref: null,
    cost: 0,
    duration_ms: 10,
    next_action: "manual",
    review_notes: ["usage limit hit"]
  }, routing("codex-cli", "local"));

  const followUp = orchestrator.submitTask(createTaskSpec({
    goal: "Summarize the current orchestration state",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  }));
  orchestrator.enqueueTask(followUp.task.task_id);
  const outcome = await orchestrator.dispatchExistingTask(followUp.task.task_id);

  assert.equal(outcome.state, "completed");
  assert.equal(outcome.routing.worker_target, "gemini-cli");
  assert.equal(codexCalls, 0);

  const health = await orchestrator.smokeAdapters();
  assert.equal(Array.isArray(health.recent_penalties), true);
  assert.equal(health.recent_penalties.some((penalty) => penalty.worker_target === "codex-cli"), true);

  const codexReadiness = health.readiness.find((entry: any) => entry.worker_target === "codex-cli");
  assert.ok(codexReadiness);
  assert.equal(codexReadiness.local_ready, false);
  assert.equal(typeof codexReadiness.cooldown_until, "number");
  assert.match(codexReadiness.cooldown_reason ?? "", /usage limit/i);
});

test("rate-limit penalties from execution attempts survive a successful fallback", async () => {
  const root = createTempDir("codex-head-attempt-penalty-");
  const config = createTestConfig(root);
  config.github.enabled = false;
  const registry = new AdapterRegistry();
  let codexCalls = 0;

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async (task) => {
      codexCalls += 1;
      return {
        task_id: task.task_id,
        worker_target: "codex-cli",
        status: "failed",
        review_verdict: null,
        summary: "ERROR: You've hit your usage limit",
        artifacts: [],
        patch_ref: null,
        log_ref: null,
        cost: 0,
        duration_ms: 10,
        next_action: "manual",
        review_notes: ["usage limit hit"]
      };
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async (task, runtime) => ({
      task_id: task.task_id,
      worker_target: "gemini-cli",
      status: "completed",
      review_verdict: null,
      summary: "Gemini handled the analysis",
      artifacts: [runtime.task_file],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 20,
      next_action: "none",
      review_notes: []
    })
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    { worker_target: "antigravity", healthy: false, reason: "disabled", detected_binary: null },
    async () => {
      throw new Error("should not execute");
    }
  ));

  const orchestrator = createAppWithRegistry(root, registry, config);

  const firstTask = orchestrator.submitTask(createTaskSpec({
    goal: "Summarize the first analysis",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  }));
  orchestrator.enqueueTask(firstTask.task.task_id);
  const firstOutcome = await orchestrator.dispatchExistingTask(firstTask.task.task_id);
  assert.equal(firstOutcome.state, "completed");
  assert.equal(firstOutcome.routing.worker_target, "gemini-cli");

  const secondTask = orchestrator.submitTask(createTaskSpec({
    goal: "Summarize the follow-up analysis",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  }));
  orchestrator.enqueueTask(secondTask.task.task_id);
  const secondOutcome = await orchestrator.dispatchExistingTask(secondTask.task.task_id);

  assert.equal(secondOutcome.state, "completed");
  assert.equal(secondOutcome.routing.worker_target, "gemini-cli");
  assert.equal(codexCalls, 1);
});

test("a later successful local run clears a recent worker penalty", async () => {
  const root = createTempDir("codex-head-penalty-clear-");
  const config = createTestConfig(root);
  config.github.enabled = false;
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    { worker_target: "antigravity", healthy: false, reason: "disabled", detected_binary: null },
    async () => {
      throw new Error("should not execute");
    }
  ));

  const orchestrator = createAppWithRegistry(root, registry, config);

  const failedTask = orchestrator.submitTask(createTaskSpec({
    goal: "Summarize a limited run",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  }));
  orchestrator.enqueueTask(failedTask.task.task_id);
  orchestrator.taskStore.claimTask(failedTask.task.task_id);
  orchestrator.acceptWorkerResult({
    task_id: failedTask.task.task_id,
    worker_target: "codex-cli",
    status: "failed",
    review_verdict: null,
    summary: "ERROR: You've hit your usage limit",
    artifacts: [],
    patch_ref: null,
    log_ref: null,
    cost: 0,
    duration_ms: 10,
    next_action: "manual",
    review_notes: ["usage limit hit"]
  }, routing("codex-cli", "local"));

  let health = await orchestrator.smokeAdapters();
  assert.equal(health.recent_penalties.some((penalty) => penalty.worker_target === "codex-cli"), true);

  const recoveredTask = orchestrator.submitTask(createTaskSpec({
    goal: "Summarize after recovery",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  }));
  orchestrator.enqueueTask(recoveredTask.task.task_id);
  orchestrator.taskStore.claimTask(recoveredTask.task.task_id);
  orchestrator.acceptWorkerResult({
    task_id: recoveredTask.task.task_id,
    worker_target: "codex-cli",
    status: "completed",
    review_verdict: null,
    summary: "Codex completed a later local run",
    artifacts: [],
    patch_ref: null,
    log_ref: null,
    cost: 0,
    duration_ms: 10,
    next_action: "none",
    review_notes: []
  }, routing("codex-cli", "local"));

  health = await orchestrator.smokeAdapters();
  assert.equal(health.recent_penalties.some((penalty) => penalty.worker_target === "codex-cli"), false);
});

test("clearRecentWorkerPenalties suppresses remembered local cooldowns until a new incident happens", async () => {
  const root = createTempDir("codex-head-clear-penalties-");
  const config = createTestConfig(root);
  config.github.enabled = false;
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  registry.register(new FakeAdapter(
    makeCapability("antigravity", { supports_local: false, supports_github: false }),
    { worker_target: "antigravity", healthy: false, reason: "disabled", detected_binary: null },
    async () => {
      throw new Error("should not execute");
    }
  ));

  const orchestrator = createAppWithRegistry(root, registry, config);
  const failedTask = orchestrator.submitTask(createTaskSpec({
    goal: "Summarize a limited run",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  }));

  orchestrator.enqueueTask(failedTask.task.task_id);
  orchestrator.taskStore.claimTask(failedTask.task.task_id);
  orchestrator.acceptWorkerResult({
    task_id: failedTask.task.task_id,
    worker_target: "codex-cli",
    status: "failed",
    review_verdict: null,
    summary: "ERROR: You've hit your usage limit",
    artifacts: [],
    patch_ref: null,
    log_ref: null,
    cost: 0,
    duration_ms: 10,
    next_action: "manual",
    review_notes: ["usage limit hit"]
  }, routing("codex-cli", "local"));

  let health = await orchestrator.smokeAdapters();
  assert.equal(health.recent_penalties.some((penalty) => penalty.worker_target === "codex-cli"), true);

  const cleared = orchestrator.clearRecentWorkerPenalties(["codex-cli"]);
  assert.deepEqual(cleared.cleared_targets, ["codex-cli"]);

  health = await orchestrator.smokeAdapters();
  assert.equal(health.recent_penalties.some((penalty) => penalty.worker_target === "codex-cli"), false);
});
