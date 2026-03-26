import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { buildRunGoalGitHubOverride, parseRunGoalArgs } from "../src/cliMain";

test("parseRunGoalArgs accepts explicit branch overrides", () => {
  const parsed = parseRunGoalArgs([
    "--repo",
    "owner/repo",
    "--base-branch",
    "main",
    "--work-branch",
    "feature/demo",
    "--dispatch-mode",
    "gh_cli",
    "--timeout-sec",
    "120",
    "--interval-sec",
    "5",
    "Review",
    "the",
    "router"
  ]);

  assert.equal(parsed.repository, "owner/repo");
  assert.equal(parsed.baseBranch, "main");
  assert.equal(parsed.workBranch, "feature/demo");
  assert.equal(parsed.dispatchMode, "gh_cli");
  assert.equal(parsed.timeoutSec, 120);
  assert.equal(parsed.intervalSec, 5);
  assert.equal(parsed.goal, "Review the router");
});

test("parseRunGoalArgs rejects missing flag values", () => {
  assert.throws(
    () => parseRunGoalArgs(["--work-branch", "--repo", "owner/repo", "Review"]),
    /--work-branch requires a value/i
  );

  assert.throws(
    () => parseRunGoalArgs(["--repo"]),
    /--repo requires a value/i
  );
});

test("parseRunGoalArgs rejects invalid numeric and enum flag values", () => {
  assert.throws(
    () => parseRunGoalArgs(["--dispatch-mode", "cloud", "Review"]),
    /--dispatch-mode must be gh_cli or artifacts_only/i
  );

  assert.throws(
    () => parseRunGoalArgs(["--timeout-sec", "0", "Review"]),
    /--timeout-sec must be a positive number/i
  );

  assert.throws(
    () => parseRunGoalArgs(["--interval-sec", "abc", "Review"]),
    /--interval-sec must be a positive number/i
  );
});

test("parseRunGoalArgs rejects unknown flags instead of treating them as goal text", () => {
  assert.throws(
    () => parseRunGoalArgs(["--workbranch", "feature/demo", "Review"]),
    /run-goal only accepts --repo, --base-branch, --work-branch/i
  );
});

test("buildRunGoalGitHubOverride defaults run-goal repo overrides to gh_cli without touching persisted config", () => {
  assert.deepEqual(
    buildRunGoalGitHubOverride("owner/repo"),
    {
      repository: "owner/repo",
      dispatch_mode: "gh_cli"
    }
  );

  assert.deepEqual(
    buildRunGoalGitHubOverride("owner/repo", "artifacts_only"),
    {
      repository: "owner/repo",
      dispatch_mode: "artifacts_only"
    }
  );
});

test("index entrypoint invokes cliMain and prints usage when no command is provided", () => {
  const entrypoint = join(__dirname, "..", "src", "index.js");
  const result = spawnSync(process.execPath, [entrypoint], {
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Usage:/);
});
