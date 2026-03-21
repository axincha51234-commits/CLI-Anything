import type { ReviewVerdict, WorkerResult } from "../contracts";

export interface NormalizedGeminiReview {
  review_verdict: ReviewVerdict;
  summary: string;
  review_notes: string[];
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}

function ensureVerdict(value: unknown): ReviewVerdict {
  if (value === "approved" || value === "changes_requested" || value === "commented") {
    return value;
  }
  throw new Error("review_verdict must be approved, changes_requested, or commented");
}

function ensureNotes(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("review_notes must be a string array");
  }
  return value;
}

export function parseGeminiReviewSummary(raw: string): NormalizedGeminiReview {
  const parsed = JSON.parse(stripCodeFence(raw)) as Record<string, unknown>;
  if (typeof parsed.summary !== "string" || parsed.summary.trim().length === 0) {
    throw new Error("summary must be a non-empty string");
  }

  return {
    review_verdict: ensureVerdict(parsed.review_verdict),
    summary: parsed.summary.trim(),
    review_notes: ensureNotes(parsed.review_notes)
  };
}

export function buildFallbackGeminiReview(reason: string): NormalizedGeminiReview {
  return {
    review_verdict: "commented",
    summary: reason,
    review_notes: [reason]
  };
}

export function normalizeGeminiReviewSummary(raw: string | null | undefined, reason: string): NormalizedGeminiReview {
  if (!raw || raw.trim().length === 0) {
    return buildFallbackGeminiReview(reason);
  }

  try {
    return parseGeminiReviewSummary(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildFallbackGeminiReview(`${reason} ${message}`.trim());
  }
}

export function buildGitHubReviewCallback(
  taskId: string,
  artifactPath: string,
  review: NormalizedGeminiReview,
  extraNotes: string[] = []
): WorkerResult {
  return {
    task_id: taskId,
    worker_target: "gemini-cli",
    status: "completed",
    review_verdict: review.review_verdict,
    summary: review.summary,
    artifacts: [artifactPath],
    patch_ref: null,
    log_ref: null,
    cost: 0,
    duration_ms: 0,
    next_action: "review",
    review_notes: [...extraNotes, ...review.review_notes]
  };
}
