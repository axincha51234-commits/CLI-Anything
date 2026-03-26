export const WORKER_TARGETS = [
  "claude-code",
  "codex-cli",
  "gemini-cli",
  "antigravity"
] as const;

export type WorkerTarget = (typeof WORKER_TARGETS)[number];

export const TASK_STATES = [
  "planned",
  "queued",
  "running",
  "awaiting_review",
  "completed",
  "failed",
  "canceled"
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const OUTPUT_KINDS = [
  "analysis",
  "patch",
  "pull_request",
  "review",
  "report"
] as const;

export type OutputKind = (typeof OUTPUT_KINDS)[number];

export const OUTPUT_FORMATS = ["json", "markdown", "patch", "text"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const REVIEW_PROVIDER_PROFILES = [
  "standard",
  "research",
  "code_assist"
] as const;

export type ReviewProviderProfile = (typeof REVIEW_PROVIDER_PROFILES)[number];

export const WORKER_RESULT_STATUSES = [
  "running",
  "awaiting_review",
  "completed",
  "failed",
  "retryable"
] as const;

export type WorkerResultStatus = (typeof WORKER_RESULT_STATUSES)[number];

export const REVIEW_VERDICTS = [
  "approved",
  "changes_requested",
  "commented"
] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const NEXT_ACTIONS = [
  "none",
  "review",
  "dispatch_github",
  "manual",
  "retry"
] as const;

export type NextAction = (typeof NEXT_ACTIONS)[number];

export interface ExpectedOutput {
  kind: OutputKind;
  format: OutputFormat;
  code_change: boolean;
}

export interface BudgetSpec {
  max_cost_usd: number;
  max_attempts: number;
}

export interface ReviewPolicy {
  required_reviewers: WorkerTarget[];
  require_all: boolean;
}

export interface ArtifactPolicy {
  mode: "local_artifact" | "patch_artifact" | "branch_pr";
  require_lineage: boolean;
}

export interface TaskSpec {
  task_id: string;
  goal: string;
  repo: string;
  base_branch: string;
  work_branch: string;
  worker_target: WorkerTarget;
  allowed_tools: string[];
  input_artifacts: string[];
  expected_output: ExpectedOutput;
  review_profile?: ReviewProviderProfile | null;
  budget: BudgetSpec;
  timeout_sec: number;
  review_policy: ReviewPolicy;
  artifact_policy: ArtifactPolicy;
  priority: number;
  requires_github: boolean;
}

export interface WorkerResult {
  task_id: string;
  worker_target: WorkerTarget;
  status: WorkerResultStatus;
  review_verdict?: ReviewVerdict | null;
  summary: string;
  artifacts: string[];
  patch_ref: string | null;
  log_ref: string | null;
  cost: number;
  duration_ms: number;
  next_action: NextAction;
  review_notes: string[];
}

export interface AdapterCapability {
  worker_target: WorkerTarget;
  supports_local: boolean;
  supports_github: boolean;
  can_edit_code: boolean;
  can_review: boolean;
  can_run_tests: boolean;
  max_concurrency: number;
  required_binaries: string[];
  feature_flag: string | null;
}

export interface AdapterHealth {
  worker_target: WorkerTarget;
  healthy: boolean;
  reason: string;
  detected_binary: string | null;
}

export interface RoutingDecision {
  worker_target: WorkerTarget;
  mode: "local" | "github";
  reason: string;
  fallback_from: WorkerTarget | null;
}

export interface GitHubRunState {
  run_id: number;
  run_url: string | null;
  workflow_name: string;
  status: string;
  conclusion: string | null;
  updated_at: number;
}

export interface GitHubMirrorTarget {
  number: number | null;
  url: string;
  title: string;
}

export interface GitHubMirrorState {
  issue: GitHubMirrorTarget | null;
  pull_request: GitHubMirrorTarget | null;
  issue_error: string | null;
  pull_request_error: string | null;
  updated_at: number;
}

export interface TaskRecord {
  task: TaskSpec;
  state: TaskState;
  attempts: number;
  max_attempts: number;
  next_run_at: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  last_error: string | null;
  result: WorkerResult | null;
  routing: RoutingDecision | null;
  github_run: GitHubRunState | null;
  github_mirror: GitHubMirrorState | null;
  reviews: TaskReview[];
}

export interface HeadPlan {
  summary: string;
  tasks: TaskSpec[];
  methodology_refs: string[];
}

export interface DispatchOutcome {
  task_id: string;
  state: TaskState;
  routing: RoutingDecision;
  detail: string;
}

export interface TaskRuntimeContext {
  task_file: string;
  task_goal: string;
  task_prompt: string;
  artifact_dir: string;
  github_payload: string | null;
}

export interface AdapterRuntimeReadiness {
  worker_target: WorkerTarget;
  healthy: boolean;
  feature_enabled: boolean;
  supports_local: boolean;
  supports_github: boolean;
  has_local_template: boolean;
  local_ready: boolean;
  github_ready: boolean;
  github_worker_ready?: boolean;
  github_review_ready?: boolean;
  cooldown_until?: number | null;
  cooldown_reason?: string | null;
}

export interface TaskReview {
  reviewer: WorkerTarget;
  verdict: ReviewVerdict;
  summary: string;
  review_notes: string[];
  artifacts: string[];
  source_status: WorkerResultStatus;
  reviewed_at: number;
}
