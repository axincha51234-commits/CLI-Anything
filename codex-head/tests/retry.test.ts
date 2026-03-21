import test from "node:test";
import assert from "node:assert/strict";

import { AdapterRegistry } from "../src/adapter-registry";
import { createTaskSpec } from "../src/schema";
import {
  createAppWithRegistry,
  createHealthyHealth,
  createTempDir,
  FakeAdapter,
  makeCapability
} from "./helpers";

test("retryable failures are requeued with backoff", async () => {
  const root = createTempDir("codex-head-retry-");
  const registry = new AdapterRegistry();
  registry.register(new FakeAdapter(
    makeCapability("codex-cli"),
    createHealthyHealth("codex-cli"),
    async (task) => ({
      task_id: task.task_id,
      worker_target: task.worker_target,
      status: "retryable",
      summary: "Timed out",
      artifacts: [],
      patch_ref: null,
      log_ref: null,
      cost: 0,
      duration_ms: 1000,
      next_action: "retry",
      review_notes: []
    })
  ));

  const orchestrator = createAppWithRegistry(root, registry);
  const record = orchestrator.submitTask(createTaskSpec({
    goal: "Validate the harness",
    repo: root,
    worker_target: "codex-cli",
    budget: { max_cost_usd: 5, max_attempts: 3 }
  }));
  orchestrator.enqueueTask(record.task.task_id);

  const outcome = await orchestrator.dispatchNext();
  assert.equal(outcome?.state, "queued");
  assert.equal(orchestrator.getTask(record.task.task_id).state, "queued");
});
