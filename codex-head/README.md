# Codex Head

`codex-head` is the internal control layer that keeps Codex App as the single
planner, router, and synthesis authority for CLI-Anything's multi-agent
experiments.

## Status

`codex-head` is **internal beta**.

- Use it for team development, orchestration experiments, and contract-driven
  worker integration.
- Do not treat it as production-ready GitHub automation or autonomous release
  infrastructure yet.

## Quick Start

```bash
cd codex-head
npm install
npm run health
node dist/src/index.js run-goal "Summarize the current orchestration state"
node dist/src/index.js run-goal "Review the latest PR in GitHub"
```

The default local templates now run `claude-code`, `codex-cli`, and
`gemini-cli` in safe non-interactive read-only or plan-style modes. The Gemini
template is pinned to `gemini-2.5-flash` because headless `auto` or premium
defaults can be quota-sensitive on real operator accounts. Local command
templates can also inject environment variables through an optional `env` map.
Use `config/workers.local.json` for shareable repo-local overrides, and keep
machine-only secrets or absolute paths in `config/workers.machine.json`.
That machine overlay is merged after `workers.local.json`, which keeps the
tracked config safe while still supporting WSL-backed `codex-cli` or local
proxy routing such as Antigravity-Manager on `http://127.0.0.1:8045`.
These workers are meant to produce artifacts, summaries, and patch text, not
uncontrolled local mutation.

The default bootstrap is now local-first. `github.enabled` starts as `false`,
so a fresh clone stays on-machine unless you explicitly enable GitHub routing.

When you do enable GitHub, `github.execution_preference` controls whether
GitHub-shaped tasks must execute remotely or can still prefer local workers
while keeping GitHub mirrors and workflow artifacts. The conservative default
is `remote_only`. For the strongest mixed setup on an operator machine, set
`execution_preference` to `local_preferred`.

`run-goal` is now the shortest operator path. It plans, saves, enqueues,
publishes mirrors when needed, dispatches the task, and waits for GitHub
callbacks when a live workflow run is available. For GitHub work, it also
auto-promotes the current run to live `gh_cli` dispatch when a real repository
is configured and `gh auth status` is healthy.

When `github.enabled` is `false`, GitHub-shaped goals stay local. Codex Head
keeps PR, issue, workflow, and research-shaped goals on local workers instead
of forcing a GitHub dispatch or a disabled `antigravity` route.

Local-only `summarize`, `report`, and `research` goals now stay typed as
`analysis` work even when the planner prefers `gemini-cli`, so the runtime can
still fall through to `claude-code` when review-specific workers are weak.

When a local worker fails at runtime, Codex Head now tries the next healthy
local fallback in the same dispatch and records the chain in
`runtime/artifacts/<task-id>/execution-attempts.json`.

`npm run health` now also reports cooldown-aware readiness. If a worker
recently hit a quota, auth failure, or timeout, readiness marks it as not
currently local-ready and exposes the matching cooldown reason.

## Docs

- [Docs home](docs/README.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contracts](docs/CONTRACTS.md)
- [Operations](docs/OPERATIONS.md)
- [Adapters](docs/ADAPTERS.md)
- [GitHub handoff](docs/GITHUB.md)

## Current Scope

- Typed planning and routing for `claude-code`, `codex-cli`, `gemini-cli`, and
  `antigravity`
- SQLite-backed task lifecycle and retry state
- CLI support for `health`, `run-goal`, `configure-github-repo`, `plan`, `enqueue`,
  `review`, `status`, `dispatch`, `dispatch-next`, `dispatch-and-wait`, `publish-github-mirror`,
  `run-github-payload`,
  `sync-github-callback`, `wait-github-callback`, `clear-penalties`,
  `reconcile-github-running`, `recover-running`, and `complete-from-file`
- Local artifact generation and GitHub dispatch payload generation
- Opt-in live GitHub workflow dispatch through `gh workflow run`
- Opt-in GitHub issue and PR mirror publishing through `gh`
- GitHub worker workflows that now emit typed callback artifacts
- GitHub workflow run tracking persisted into task state as `github_run`
- GitHub mirror metadata persisted into task state as `github_mirror`
- One-shot GitHub orchestration through `dispatch-and-wait`
- Batch reconciliation for running GitHub tasks through
  `reconcile-github-running`
- One-shot operator automation through `run-goal`
- Auto-detection of `github.repository` from `GITHUB_REPOSITORY` or `git remote origin`
- Review aggregation for required reviewers while tasks are in
  `awaiting_review`
- Automatic local execution fallback to the next healthy worker when the
  first local worker fails at runtime
- Recent local quota, auth, and timeout penalties that temporarily deprioritize
  weak workers on later tasks
- Local-only planning that keeps GitHub-shaped goals on machine when GitHub is
  disabled
- Smoke, contract, routing, retry, and orchestrator tests

## Known Gaps

- Live GitHub workflow dispatch is opt-in and still requires `gh` auth plus a
  real `github.repository` value.
- `github.execution_preference = "local_preferred"` is now the practical
  hybrid mode: keep GitHub as mirror/control plane, but execute locally first
  and only fall through to GitHub execution when the local chain is unusable.
- `run-goal` can auto-upgrade GitHub tasks to live `gh_cli` dispatch for the
  current run, but a real target repo still has to be discoverable or supplied.
- GitHub issue and PR mirror publishing is now supported, but automatic mirror
  updates and richer sync flows are not fully wired.
- The GitHub review workflow now supports three remote auth paths in order:
  `REVIEW_API_URL` + `REVIEW_API_KEY` for an OpenAI-compatible endpoint,
  `OPENAI_API_KEY` for direct OpenAI usage, or `GEMINI_API_KEY` for Gemini.
- On the OpenAI-compatible path, the workflow now tries `/v1/responses` first
  and falls back to `/v1/chat/completions` if needed.
- Both GitHub workflows now also honor the repository variable
  `CODEX_HEAD_RUNS_ON_JSON`, so you can switch from `["ubuntu-latest"]` to a
  self-hosted label array without editing workflow YAML each time.
- A bootstrap helper now exists at
  [scripts/setup-self-hosted-runner.ps1](C:/Users/khoa%20phan/Documents/CLI-Anything-main/codex-head/scripts/setup-self-hosted-runner.ps1)
  to register a Windows self-hosted runner and optionally wire
  `REVIEW_API_URL` / `REVIEW_API_KEY` for local proxy-backed review.
- That bootstrap helper now also exports `CODEX_HEAD_MACHINE_CONFIG` for the
  current user when `config/workers.machine.json` exists, so self-hosted worker
  runs can reuse machine-local proxy and account-manager overrides outside the
  clean GitHub checkout.
- On newer Windows runner packages that omit `svc.cmd`, the bootstrap helper
  now falls back to a Windows scheduled task by default so the runner can come
  back after logon without a manual terminal. You can still disable that and
  manage `run.cmd` yourself if you prefer.
- The bootstrap helper also opts the self-hosted runner into Node 24 JavaScript
  actions by setting `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` for the current
  user, which reduces GitHub Actions deprecation noise on newer runners.
- If you ever have to bounce the Windows self-hosted runner, use
  [scripts/recycle-self-hosted-runner.ps1](C:/Users/khoa%20phan/Documents/CLI-Anything-main/codex-head/scripts/recycle-self-hosted-runner.ps1)
  so the old GitHub broker session can drain before the listener is started
  again.
- GitHub callback reconciliation can now either sync directly from artifacts or
  wait on a resolved workflow run, but it is not background or automatic yet.
- `npm run health` now also reports the resolved self-hosted `runs-on` labels,
  matching runner records, and whether a machine-local worker overlay is
  visible, so operator triage no longer depends on ad hoc `gh api` calls.
- Local worker defaults do not verify upstream CLI authentication in advance,
  so automatic fallback still fails if every candidate worker is unusable at
  runtime.
- `codex-cli` local proxy overrides must speak the OpenAI Responses API at
  `/v1/responses`; chat-completions-only gateways are not compatible with
  current Codex CLI local execution.
- If your Windows `codex` entrypoint forwards into WSL, override
  `command_templates.codex-cli.local` to call `wsl.exe` directly and set
  `env.WSLENV="CODEX_HOME/p"` plus
  `env.CODEX_HOME="C:\\Users\\<you>\\.codex"` so the Linux-side Codex process
  reads the same auth store as the Windows-side switcher.
- If you want `codex-head` to use Antigravity-Manager only for this repo, point
  `command_templates.codex-cli.*.env.CODEX_HOME` at a repo-local Codex profile
  that contains `auth.json` plus a `config.toml` custom provider targeting the
  reachable Antigravity-Manager host for that runtime, such as
  `http://172.31.64.1:8045/v1` from WSL-backed Codex, and inject
  `ANTHROPIC_BASE_URL` for Claude. For Gemini, prefer a repo-local home/profile
  that sets `.gemini/settings.json` auth to `gemini-api-key`, otherwise the CLI
  may keep preferring cached Google login instead of your proxy env.
- `antigravity` is disabled by default behind a feature flag.
- Legacy config files may still use camelCase keys, but the loader now accepts
  both camelCase and snake_case overrides.
- Queue priority is respected by `dispatch-next`, while `dispatch <task-id>` is
  available for deterministic dispatch.
- Production governance, monitoring, and release controls are not complete.
