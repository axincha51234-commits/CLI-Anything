import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFallbackGeminiReview,
  buildGitHubReviewCallback,
  normalizeGeminiReviewSummary,
  parseGeminiReviewSummary
} from "../src/github/reviewCallback";

test("parseGeminiReviewSummary accepts strict JSON output", () => {
  const parsed = parseGeminiReviewSummary(JSON.stringify({
    review_verdict: "approved",
    summary: "Looks good",
    review_notes: ["No blocking issues found."]
  }));

  assert.equal(parsed.review_verdict, "approved");
  assert.equal(parsed.summary, "Looks good");
  assert.deepEqual(parsed.review_notes, ["No blocking issues found."]);
});

test("normalizeGeminiReviewSummary strips code fences and falls back safely on invalid output", () => {
  const parsed = normalizeGeminiReviewSummary("```json\n{\"review_verdict\":\"commented\",\"summary\":\"Needs a closer look\",\"review_notes\":[\"One note\"]}\n```", "fallback");
  assert.equal(parsed.review_verdict, "commented");
  assert.equal(parsed.summary, "Needs a closer look");

  const fallback = normalizeGeminiReviewSummary("not json", "Gemini review returned invalid structured output.");
  assert.equal(fallback.review_verdict, "commented");
  assert.match(fallback.summary, /Gemini review returned invalid structured output/i);
});

test("buildGitHubReviewCallback produces a typed worker result", () => {
  const review = buildFallbackGeminiReview("Gemini review skipped because workflow auth was not configured.");
  const callback = buildGitHubReviewCallback(
    "task-123",
    "runtime/artifacts/task-123/github-callback.json",
    review,
    ["Review callback captured from GitHub workflow."]
  );

  assert.equal(callback.task_id, "task-123");
  assert.equal(callback.worker_target, "gemini-cli");
  assert.equal(callback.status, "completed");
  assert.equal(callback.review_verdict, "commented");
  assert.deepEqual(callback.artifacts, ["runtime/artifacts/task-123/github-callback.json"]);
});
