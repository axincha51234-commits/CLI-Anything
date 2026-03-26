import test from "node:test";
import assert from "node:assert/strict";

import { AdapterRegistry } from "../src/adapter-registry";
import { CodexHeadPlanner } from "../src/planner";
import { TaskRouter } from "../src/router";
import { createTaskSpec } from "../src/schema";
import { createHealthyHealth, createTempDir, createTestConfig, FakeAdapter, makeCapability } from "./helpers";

test("TaskRouter falls back when primary local adapter is unhealthy", async () => {
  const root = createTempDir("codex-head-router-");
  const config = createTestConfig(root);
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
    async () => {
      throw new Error("should not execute");
    }
  ));

  const router = new TaskRouter(registry, config);
  const task = createTaskSpec({
    goal: "Implement a fix",
    repo: root,
    worker_target: "claude-code",
    expected_output: { kind: "patch", format: "patch", code_change: true }
  });

  const decision = await router.resolve(task);
  assert.equal(decision.worker_target, "codex-cli");
  assert.equal(decision.mode, "local");
  assert.equal(decision.fallback_from, "claude-code");
});

test("TaskRouter routes GitHub review to gemini-cli", async () => {
  const root = createTempDir("codex-head-router-gh-");
  const config = createTestConfig(root);
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const router = new TaskRouter(registry, config);
  const task = createTaskSpec({
    goal: "Review the pull request in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  });

  const decision = await router.resolve(task);
  assert.equal(decision.mode, "github");
  assert.equal(decision.worker_target, "gemini-cli");
});

test("TaskRouter prefers local execution for GitHub tasks when configured", async () => {
  const root = createTempDir("codex-head-router-gh-local-preferred-");
  const config = createTestConfig(root);
  config.github.execution_preference = "local_preferred";
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

  const router = new TaskRouter(registry, config);
  const task = createTaskSpec({
    goal: "Review the pull request in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  });

  const decision = await router.resolve(task);
  assert.equal(decision.mode, "local");
  assert.equal(decision.worker_target, "gemini-cli");
});

test("TaskRouter uses another healthy local worker before GitHub fallback in local-preferred mode", async () => {
  const root = createTempDir("codex-head-router-gh-local-fallback-");
  const config = createTestConfig(root);
  config.github.execution_preference = "local_preferred";
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    { worker_target: "gemini-cli", healthy: false, reason: "quota", detected_binary: "gemini.exe" },
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

  const router = new TaskRouter(registry, config);
  const task = createTaskSpec({
    goal: "Review the pull request in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  });

  const decision = await router.resolve(task);
  assert.equal(decision.mode, "local");
  assert.equal(decision.worker_target, "codex-cli");
  assert.equal(decision.fallback_from, "gemini-cli");
});

test("TaskRouter falls back to GitHub execution when local-preferred mode has no healthy local worker", async () => {
  const root = createTempDir("codex-head-router-gh-remote-fallback-");
  const config = createTestConfig(root);
  config.github.execution_preference = "local_preferred";
  config.command_templates["gemini-cli"].local = undefined;
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const router = new TaskRouter(registry, config);
  const task = createTaskSpec({
    goal: "Review the pull request in GitHub",
    repo: root,
    worker_target: "gemini-cli",
    expected_output: { kind: "review", format: "markdown", code_change: false },
    requires_github: true
  });

  const decision = await router.resolve(task);
  assert.equal(decision.mode, "github");
  assert.equal(decision.worker_target, "gemini-cli");
});

test("CodexHeadPlanner applies operator-friendly timeout defaults", () => {
  const root = createTempDir("codex-head-planner-timeout-");
  const planner = new CodexHeadPlanner([], {
    github_enabled: true,
    antigravity_enabled: false,
    local_reviewers: ["gemini-cli", "codex-cli"]
  });
  const analysisPlan = planner.planGoal("Summarize the current orchestration state", root);
  const patchPlan = planner.planGoal("Implement a fix for the router", root);
  const reviewPlan = planner.planGoal("Review the latest PR in GitHub", root);

  assert.equal(analysisPlan.tasks[0]?.timeout_sec, 30);
  assert.equal(patchPlan.tasks[0]?.timeout_sec, 180);
  assert.equal(reviewPlan.tasks[0]?.timeout_sec, 300);
});

test("CodexHeadPlanner keeps GitHub-shaped goals local when GitHub is disabled", () => {
  const root = createTempDir("codex-head-planner-local-only-");
  const planner = new CodexHeadPlanner([], {
    github_enabled: false,
    antigravity_enabled: false,
    local_reviewers: ["gemini-cli", "codex-cli"]
  });
  const reviewPlan = planner.planGoal("Review the latest PR in GitHub", root);
  const patchPlan = planner.planGoal("Implement a fix for the router", root);

  assert.equal(reviewPlan.tasks[0]?.worker_target, "gemini-cli");
  assert.equal(reviewPlan.tasks[0]?.requires_github, false);
  assert.equal(reviewPlan.tasks[0]?.expected_output.kind, "review");
  assert.equal(reviewPlan.tasks[0]?.review_profile, "standard");
  assert.equal(reviewPlan.tasks[0]?.timeout_sec, 60);
  assert.equal(patchPlan.tasks[0]?.artifact_policy.mode, "patch_artifact");
  assert.deepEqual(patchPlan.tasks[0]?.review_policy.required_reviewers, ["gemini-cli", "codex-cli"]);
  assert.equal(patchPlan.tasks[0]?.review_policy.require_all, false);
});

test("CodexHeadPlanner marks research-heavy review goals for Perplexity-style providers", () => {
  const root = createTempDir("codex-head-planner-review-research-");
  const planner = new CodexHeadPlanner([], {
    github_enabled: true,
    antigravity_enabled: false,
    local_reviewers: ["gemini-cli", "codex-cli"]
  });
  const plan = planner.planGoal("Review the latest dependency changes and verify current release notes in GitHub", root);

  assert.equal(plan.tasks[0]?.expected_output.kind, "review");
  assert.equal(plan.tasks[0]?.review_profile, "research");
});

test("CodexHeadPlanner marks code-assist review goals for Blackbox-style providers", () => {
  const root = createTempDir("codex-head-planner-review-code-assist-");
  const planner = new CodexHeadPlanner([], {
    github_enabled: true,
    antigravity_enabled: false,
    local_reviewers: ["gemini-cli", "codex-cli"]
  });
  const plan = planner.planGoal("Review the latest PR and suggest API usage examples plus refactor snippets", root);

  assert.equal(plan.tasks[0]?.expected_output.kind, "review");
  assert.equal(plan.tasks[0]?.review_profile, "code_assist");
});

test("CodexHeadPlanner keeps research tasks off antigravity when the feature flag is disabled", () => {
  const root = createTempDir("codex-head-planner-research-local-");
  const planner = new CodexHeadPlanner([], {
    github_enabled: false,
    antigravity_enabled: false,
    local_reviewers: ["gemini-cli", "codex-cli"]
  });
  const plan = planner.planGoal("Research the current orchestration bottlenecks", root);

  assert.equal(plan.tasks[0]?.worker_target, "gemini-cli");
  assert.equal(plan.tasks[0]?.requires_github, false);
  assert.equal(plan.tasks[0]?.expected_output.kind, "analysis");
  assert.equal(plan.tasks[0]?.timeout_sec, 60);
});

test("CodexHeadPlanner can still target antigravity when the feature flag is enabled", () => {
  const root = createTempDir("codex-head-planner-research-antigravity-");
  const planner = new CodexHeadPlanner([], {
    github_enabled: false,
    antigravity_enabled: true,
    local_reviewers: ["gemini-cli", "codex-cli"]
  });
  const plan = planner.planGoal("Research the current orchestration bottlenecks", root);

  assert.equal(plan.tasks[0]?.worker_target, "antigravity");
});

test("CodexHeadPlanner keeps summarize goals as analysis in local-only mode", () => {
  const root = createTempDir("codex-head-planner-summarize-analysis-");
  const planner = new CodexHeadPlanner([], {
    github_enabled: false,
    antigravity_enabled: false,
    local_reviewers: ["gemini-cli", "codex-cli"]
  });
  const plan = planner.planGoal("Summarize the current orchestration state", root);

  assert.equal(plan.tasks[0]?.worker_target, "gemini-cli");
  assert.equal(plan.tasks[0]?.expected_output.kind, "analysis");
  assert.equal(plan.tasks[0]?.requires_github, false);
});

test("TaskRouter keeps the most recent excluded target as fallback_from", async () => {
  const root = createTempDir("codex-head-router-exclude-");
  const config = createTestConfig(root);
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("claude-code"),
    createHealthyHealth("claude-code"),
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
    makeCapability("gemini-cli"),
    createHealthyHealth("gemini-cli"),
    async () => {
      throw new Error("should not execute");
    }
  ));

  const router = new TaskRouter(registry, config);
  const task = createTaskSpec({
    goal: "Summarize the current orchestration state",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  });

  const decision = await router.resolve(task, {
    exclude_targets: ["codex-cli", "gemini-cli"]
  });
  assert.equal(decision.worker_target, "claude-code");
  assert.equal(decision.mode, "local");
  assert.equal(decision.fallback_from, "gemini-cli");
});

test("TaskRouter prefers gemini-cli first for local-only analysis fallback", async () => {
  const root = createTempDir("codex-head-router-local-only-fallback-");
  const config = createTestConfig(root);
  config.github.enabled = false;
  const registry = new AdapterRegistry();

  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    { worker_target: "codex-cli", healthy: false, reason: "rate_limited", detected_binary: "codex.exe" },
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

  const router = new TaskRouter(registry, config);
  const task = createTaskSpec({
    goal: "Summarize the current orchestration state",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  });

  const decision = await router.resolve(task);
  assert.equal(decision.worker_target, "gemini-cli");
  assert.equal(decision.mode, "local");
  assert.equal(decision.fallback_from, "codex-cli");
});

test("TaskRouter deprioritizes recently limited workers before falling back", async () => {
  const root = createTempDir("codex-head-router-deprioritized-");
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

  const router = new TaskRouter(registry, config);
  const task = createTaskSpec({
    goal: "Summarize the current orchestration state",
    repo: root,
    worker_target: "codex-cli",
    expected_output: { kind: "analysis", format: "markdown", code_change: false }
  });

  const decision = await router.resolve(task, {
    deprioritized_targets: ["codex-cli"]
  });
  assert.equal(decision.worker_target, "gemini-cli");
  assert.equal(decision.mode, "local");
  assert.equal(decision.fallback_from, "codex-cli");
});
