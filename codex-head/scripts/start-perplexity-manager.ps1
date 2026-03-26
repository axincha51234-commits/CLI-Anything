[CmdletBinding()]
param(
  [string]$PerplexityBinary = "",
  [int]$CdpPort = 9233,
  [Alias("BridgePort")]
  [int]$ManagerPort = 20129,
  [string]$ManagerHost = "127.0.0.1",
  [string]$ApiKey = "local-perplexity",
  [string]$Models = "pplxapp/app-chat,pplxapp/app-health",
  [switch]$RestartApp = $false
)

$ErrorActionPreference = "Stop"

function Test-HttpJson {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Uri,
    [hashtable]$Headers = @{}
  )

  try {
    return Invoke-RestMethod -Uri $Uri -Headers $Headers -Method Get -TimeoutSec 5
  } catch {
    return $null
  }
}

function Wait-HttpReady {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Uri,
    [hashtable]$Headers = @{},
    [int]$TimeoutSeconds = 45
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $result = Test-HttpJson -Uri $Uri -Headers $Headers
    if ($null -ne $result) {
      return $result
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)

  throw "Timed out waiting for $Uri"
}

function Resolve-ExistingPath {
  param([string[]]$Candidates)

  foreach ($candidate in $Candidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path $candidate)) {
      return [System.IO.Path]::GetFullPath($candidate)
    }
  }

  return $null
}

function Require-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

Require-Command "node"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\\.."))
$resolvedPerplexityBinary = if ([string]::IsNullOrWhiteSpace($PerplexityBinary)) {
  Resolve-ExistingPath -Candidates @(
    (Join-Path $env:LOCALAPPDATA "Programs\\Perplexity\\Perplexity.exe")
  )
} else {
  Resolve-ExistingPath -Candidates @($PerplexityBinary)
}

if (-not $resolvedPerplexityBinary) {
  throw "Could not resolve Perplexity.exe."
}

$cdpBaseUrl = "http://127.0.0.1:$CdpPort"
$managerBaseUrl = "http://$ManagerHost`:$ManagerPort"

if ($RestartApp) {
  Get-Process -Name "Perplexity" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

$cdpVersion = Test-HttpJson -Uri "${cdpBaseUrl}/json/version"
if ($null -eq $cdpVersion) {
  Start-Process -FilePath $resolvedPerplexityBinary -ArgumentList "--remote-debugging-port=$CdpPort" | Out-Null
  $cdpVersion = Wait-HttpReady -Uri "${cdpBaseUrl}/json/version" -TimeoutSeconds 40
}

$managerHealth = Test-HttpJson -Uri "$managerBaseUrl/health"
if ($null -eq $managerHealth) {
  $scriptPath = Join-Path $PSScriptRoot "perplexity-runtime-manager.mjs"
  if (-not (Test-Path $scriptPath)) {
    throw "Perplexity runtime manager script not found at $scriptPath"
  }

  $nodePath = (Get-Command node -ErrorAction Stop).Source
  $managerArgs = "`"$scriptPath`" --port $ManagerPort --host $ManagerHost --cdp-port $CdpPort --api-key `"$ApiKey`" --models `"$Models`""
  $stdoutPath = Join-Path $env:TEMP "perplexity-manager.stdout.log"
  $stderrPath = Join-Path $env:TEMP "perplexity-manager.stderr.log"

  Start-Process -FilePath $nodePath -ArgumentList $managerArgs -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath | Out-Null
  $managerHealth = Wait-HttpReady -Uri "$managerBaseUrl/health" -TimeoutSeconds 45
}

[pscustomobject]@{
  perplexity_binary = $resolvedPerplexityBinary
  cdp_base_url = $cdpBaseUrl
  manager_base_url = $managerBaseUrl
  api_key = $ApiKey
  models = $Models -split ","
  cdp_browser = $cdpVersion.Browser
  runtime_target_available = $managerHealth.runtime_target_available
  manager_status = $managerHealth.status
} | ConvertTo-Json -Depth 6
