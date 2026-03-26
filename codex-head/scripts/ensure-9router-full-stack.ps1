[CmdletBinding()]
param(
  [switch]$SkipRouterBuild = $false,
  [switch]$RestartPerplexity = $false,
  [switch]$ForceRefreshBlackboxManager = $false
)

$ErrorActionPreference = "Stop"

$antigravityScript = Join-Path $PSScriptRoot "ensure-9router-antigravity-stack.ps1"
$perplexityScript = Join-Path $PSScriptRoot "ensure-9router-perplexity-stack.ps1"
$blackboxScript = Join-Path $PSScriptRoot "ensure-9router-blackbox-stack.ps1"

foreach ($scriptPath in @($antigravityScript, $perplexityScript, $blackboxScript)) {
  if (-not (Test-Path $scriptPath)) {
    throw "Required helper script not found at $scriptPath"
  }
}

$commonArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass")

$antigravityArgs = @(
  $commonArgs +
  @("-File", $antigravityScript)
)
if ($SkipRouterBuild) {
  $antigravityArgs += "-SkipRouterBuild"
}
$antigravity = & powershell.exe @antigravityArgs | ConvertFrom-Json

$perplexityArgs = @(
  $commonArgs +
  @("-File", $perplexityScript)
)
if ($SkipRouterBuild) {
  $perplexityArgs += "-SkipRouterBuild"
}
if ($RestartPerplexity) {
  $perplexityArgs += "-RestartPerplexity"
}
$perplexity = & powershell.exe @perplexityArgs | ConvertFrom-Json

$blackboxArgs = @(
  $commonArgs +
  @("-File", $blackboxScript)
)
if ($SkipRouterBuild) {
  $blackboxArgs += "-SkipRouterBuild"
}
if ($ForceRefreshBlackboxManager) {
  $blackboxArgs += "-ForceRefreshManager"
}
$blackbox = & powershell.exe @blackboxArgs | ConvertFrom-Json

[pscustomobject]@{
  router_base_url = $antigravity.router.base_url
  antigravity = [pscustomobject]@{
    base_url = $antigravity.antigravity.base_url
    version = $antigravity.antigravity.version
    active_accounts = $antigravity.antigravity.active_accounts
    agm_probe = $antigravity.routes.chat.probe_text
  }
  perplexity = [pscustomobject]@{
    manager_base_url = $perplexity.perplexity_manager_base_url
    default_model = $perplexity.default_model
    manager_status = $perplexity.manager_status
    manager_probe = $perplexity.manager_warm_completion
    router_probe = $perplexity.router_probe_completion
  }
  blackbox = [pscustomobject]@{
    manager_base_url = $blackbox.blackbox_manager_base_url
    default_model = $blackbox.default_model
    manager_status = $blackbox.manager_status
    manager_probe = $blackbox.manager_probe_completion
    router_probe = $blackbox.router_probe_completion
  }
  summary = @(
    "agm=$($antigravity.routes.chat.probe_text)",
    "pplx=$($perplexity.router_probe_completion)",
    "bbx=$($blackbox.router_probe_completion)"
  ) -join " :: "
} | ConvertTo-Json -Depth 6
