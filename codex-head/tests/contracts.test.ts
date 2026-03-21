import test from "node:test";
import assert from "node:assert/strict";

import { createTaskSpec, TaskValidationError, validateTaskSpec } from "../src/schema";

test("createTaskSpec applies defaults", () => {
  const task = createTaskSpec({
    goal: "Fix the failing harness",
    repo: "/tmp/repo"
  });

  assert.equal(task.worker_target, "codex-cli");
  assert.equal(task.base_branch, "main");
  assert.equal(task.expected_output.kind, "analysis");
  assert.equal(task.review_policy.required_reviewers.length, 0);
  assert.match(task.work_branch, /^codex\//);
});

test("validateTaskSpec rejects invalid worker_target", () => {
  const task = createTaskSpec({
    goal: "Review the patch",
    repo: "/tmp/repo"
  }) as unknown as Record<string, unknown>;
  task.worker_target = "bad-target";

  assert.throws(() => validateTaskSpec(task), TaskValidationError);
});
