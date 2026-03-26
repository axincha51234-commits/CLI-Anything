[CmdletBinding()]
param(
  [int]$ManagerPort = 8083,
  [string]$ManagerHost = "127.0.0.1",
  [string]$ApiKey = "local-blackbox",
  [string]$Models = "bbxapp/app-agent",
  [string]$StateDbPath = "",
  [string]$UpstreamBaseUrl = "https://oi-vscode-server-985058387028.europe-west1.run.app",
  [string]$UpstreamModel = "custom/blackbox-base-2",
  [string]$CustomerId = "placeholder"
)

$ErrorActionPreference = "Stop"

function Test-HttpJson {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Uri
  )

  try {
    return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 5
  } catch {
    return $null
  }
}

function Wait-HttpReady {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Uri,
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $result = Test-HttpJson -Uri $Uri
    if ($null -ne $result) {
      return $result
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)

  throw "Timed out waiting for $Uri"
}

$managerScript = Join-Path $PSScriptRoot "blackbox-account-manager.mjs"
if (-not (Test-Path $managerScript)) {
  throw "Blackbox account manager script not found at $managerScript"
}

$nodePath = (Get-Command node -ErrorAction Stop).Source
$stdoutPath = Join-Path $env:TEMP "blackbox-account-manager.stdout.log"
$stderrPath = Join-Path $env:TEMP "blackbox-account-manager.stderr.log"
$managerHealthUrl = "http://$ManagerHost`:$ManagerPort/health"

$health = Test-HttpJson -Uri $managerHealthUrl
if ($null -eq $health -or $health.provider -ne "blackbox-account-manager") {
  $args = @(
    "`"$managerScript`"",
    "--host", $ManagerHost,
    "--port", $ManagerPort.ToString(),
    "--api-key", $ApiKey,
    "--models", "`"$Models`"",
    "--upstream-base-url", "`"$UpstreamBaseUrl`"",
    "--upstream-model", "`"$UpstreamModel`"",
    "--customer-id", "`"$CustomerId`""
  )

  if (-not [string]::IsNullOrWhiteSpace($StateDbPath)) {
    $args += @("--state-db", "`"$StateDbPath`"")
  }

  Start-Process -FilePath $nodePath `
    -ArgumentList ($args -join " ") `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath | Out-Null
}

$managerHealth = Wait-HttpReady -Uri $managerHealthUrl -TimeoutSeconds 90

[pscustomobject]@{
  manager_base_url = "http://$ManagerHost`:$ManagerPort"
  manager_status = $managerHealth.status
  state_db_path = $managerHealth.state_db_path
  identity_loaded = $managerHealth.identity_loaded
  user_id = $managerHealth.user_id
  upstream_base_url = $managerHealth.upstream_base_url
  default_upstream_model = $managerHealth.default_upstream_model
  models = $managerHealth.model_aliases
} | ConvertTo-Json -Depth 6
