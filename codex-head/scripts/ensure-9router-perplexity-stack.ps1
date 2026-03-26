[CmdletBinding()]
param(
  [string]$RouterRoot = "",
  [string]$RouterDataDir = "",
  [string]$RouterHost = "127.0.0.1",
  [int]$RouterPort = 20128,
  [Alias("PerplexityBridgePort")]
  [int]$PerplexityManagerPort = 20129,
  [int]$PerplexityCdpPort = 9233,
  [string]$NodePrefix = "pplxapp",
  [string]$NodeName = "Perplexity Runtime Manager Local",
  [string]$DefaultModel = "pplxapp/app-chat",
  [string]$HealthModel = "pplxapp/app-health",
  [Alias("BridgeApiKey")]
  [string]$ManagerApiKey = "local-perplexity",
  [switch]$SkipRouterBuild = $false,
  [switch]$RestartPerplexity = $false
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

function Wait-PerplexityRuntimeStable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ManagerHealthUri,
    [Parameter(Mandatory = $true)]
    [string]$CdpVersionUri,
    [int]$TimeoutSeconds = 45,
    [int]$ConsecutiveSuccesses = 2
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $streak = 0
  do {
    $manager = Test-HttpJson -Uri $ManagerHealthUri
    $cdp = Test-HttpJson -Uri $CdpVersionUri

    $managerHealthy = $null -ne $manager `
      -and [string]$manager.status -eq "ok" `
      -and $manager.runtime_target_available -eq $true
    $cdpHealthy = $null -ne $cdp -and -not [string]::IsNullOrWhiteSpace([string]$cdp.Browser)

    if ($managerHealthy -and $cdpHealthy) {
      $streak += 1
      if ($streak -ge $ConsecutiveSuccesses) {
        return [pscustomobject]@{
          manager = $manager
          cdp = $cdp
        }
      }
    } else {
      $streak = 0
    }

    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)

  throw "Timed out waiting for a stable Perplexity runtime."
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

function Start-NineRouter {
  param(
    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory,
    [Parameter(Mandatory = $true)]
    [string]$DataDir,
    [Parameter(Mandatory = $true)]
    [string]$Host,
    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  $stdoutPath = Join-Path $env:TEMP "9router-pplx.stdout.log"
  $stderrPath = Join-Path $env:TEMP "9router-pplx.stderr.log"
  $command = @(
    "set DATA_DIR=$DataDir",
    "set PORT=$Port",
    "set HOSTNAME=$Host",
    "set BASE_URL=http://$Host`:$Port",
    "set NEXT_PUBLIC_BASE_URL=http://$Host`:$Port",
    "node .next/standalone/server.js 1>> `"$stdoutPath`" 2>> `"$stderrPath`""
  ) -join " && "

  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $command -WorkingDirectory $WorkingDirectory -WindowStyle Hidden | Out-Null
}

function Ensure-NpmInstall {
  param([string]$WorkingDirectory)

  if (Test-Path (Join-Path $WorkingDirectory "node_modules")) {
    return
  }

  Push-Location $WorkingDirectory
  try {
    & npm install
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed in $WorkingDirectory"
    }
  } finally {
    Pop-Location
  }
}

function Ensure-NineRouterBuild {
  param([string]$WorkingDirectory)

  if (Test-Path (Join-Path $WorkingDirectory ".next/standalone/server.js")) {
    return
  }

  Push-Location $WorkingDirectory
  try {
    $env:NODE_ENV = "production"
    & npm exec next build -- --webpack
    if ($LASTEXITCODE -ne 0) {
      throw "9router build failed in $WorkingDirectory"
    }
  } finally {
    Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
    Pop-Location
  }
}

function Ensure-ProviderNode {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$Prefix,
    [Parameter(Mandatory = $true)]
    [ValidateSet("chat", "responses")]
    [string]$ApiType,
    [Parameter(Mandatory = $true)]
    [string]$UpstreamBaseUrl,
    [ref]$Created
  )

  $nodesResponse = Invoke-RestMethod -Uri "$BaseUrl/api/provider-nodes" -Method Get -TimeoutSec 10
  $existing = @($nodesResponse.nodes) | Where-Object {
    $_.prefix -eq $Prefix -and $_.apiType -eq $ApiType -and $_.baseUrl -eq $UpstreamBaseUrl
  } | Select-Object -First 1
  if ($existing) {
    if ($existing.name -ne $Name) {
      $payload = @{
        name = $Name
        prefix = $Prefix
        apiType = $ApiType
        baseUrl = $UpstreamBaseUrl
      } | ConvertTo-Json
      $updated = Invoke-RestMethod -Uri "$BaseUrl/api/provider-nodes/$($existing.id)" -Method Put -ContentType "application/json" -Body $payload -TimeoutSec 10
      $Created.Value = $false
      return $updated.node
    }
    $Created.Value = $false
    return $existing
  }

  $payload = @{
    name = $Name
    prefix = $Prefix
    apiType = $ApiType
    baseUrl = $UpstreamBaseUrl
    type = "openai-compatible"
  } | ConvertTo-Json

  $result = Invoke-RestMethod -Uri "$BaseUrl/api/provider-nodes" -Method Post -ContentType "application/json" -Body $payload -TimeoutSec 10
  $Created.Value = $true
  return $result.node
}

function Ensure-ProviderConnection {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,
    [Parameter(Mandatory = $true)]
    [string]$ProviderId,
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$ApiKey,
    [Parameter(Mandatory = $true)]
    [string]$DefaultModel,
    [ref]$Created
  )

  $providersResponse = Invoke-RestMethod -Uri "$BaseUrl/api/providers" -Method Get -TimeoutSec 10
  $existing = @($providersResponse.connections) | Where-Object {
    $_.provider -eq $ProviderId -or $_.name -eq $Name
  } | Select-Object -First 1
  if ($existing) {
    if ($existing.name -ne $Name -or $existing.defaultModel -ne $DefaultModel) {
      $payload = @{
        name = $Name
        defaultModel = $DefaultModel
        providerSpecificData = @{
          nodeName = $Name
        }
      } | ConvertTo-Json -Depth 6
      $updated = Invoke-RestMethod -Uri "$BaseUrl/api/providers/$($existing.id)" -Method Put -ContentType "application/json" -Body $payload -TimeoutSec 10
      $Created.Value = $false
      return $updated.connection
    }
    $Created.Value = $false
    return $existing
  }

  $payload = @{
    provider = $ProviderId
    apiKey = $ApiKey
    name = $Name
    priority = 1
    defaultModel = $DefaultModel
  } | ConvertTo-Json

  $result = Invoke-RestMethod -Uri "$BaseUrl/api/providers" -Method Post -ContentType "application/json" -Body $payload -TimeoutSec 10
  $Created.Value = $true
  return $result.connection
}

function Remove-ConflictingProviderNodes {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,
    [Parameter(Mandatory = $true)]
    [string]$KeepNodeId,
    [Parameter(Mandatory = $true)]
    [string[]]$Prefixes,
    [Parameter(Mandatory = $true)]
    [ValidateSet("chat", "responses")]
    [string]$ApiType
  )

  $nodesResponse = Invoke-RestMethod -Uri "$BaseUrl/api/provider-nodes" -Method Get -TimeoutSec 10
  $staleNodes = @($nodesResponse.nodes) | Where-Object {
    $_.id -ne $KeepNodeId -and $Prefixes -contains $_.prefix -and $_.apiType -eq $ApiType
  }

  foreach ($staleNode in $staleNodes) {
    Invoke-RestMethod -Uri "$BaseUrl/api/provider-nodes/$($staleNode.id)" -Method Delete -TimeoutSec 10 | Out-Null
  }

  return @($staleNodes)
}

function Remove-ConflictingProviderConnections {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,
    [Parameter(Mandatory = $true)]
    [string]$KeepConnectionId,
    [Parameter(Mandatory = $true)]
    [string[]]$Prefixes,
    [Parameter(Mandatory = $true)]
    [ValidateSet("chat", "responses")]
    [string]$ApiType
  )

  $providersResponse = Invoke-RestMethod -Uri "$BaseUrl/api/providers" -Method Get -TimeoutSec 10
  $staleConnections = @($providersResponse.connections) | Where-Object {
    $_.id -ne $KeepConnectionId `
      -and $Prefixes -contains $_.providerSpecificData.prefix `
      -and $_.providerSpecificData.apiType -eq $ApiType
  }

  foreach ($staleConnection in $staleConnections) {
    Invoke-RestMethod -Uri "$BaseUrl/api/providers/$($staleConnection.id)" -Method Delete -TimeoutSec 10 | Out-Null
  }

  return @($staleConnections)
}

function Normalize-PerplexityProbeCompletion {
  param([AllowNull()][string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }

  $normalized = $Value.Trim()
  $normalized = [regex]::Replace($normalized, '(\[\d+\]\s*)+$', '')
  return $normalized.Trim()
}

function Invoke-JsonPostWithRetry {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Uri,
    [Parameter(Mandatory = $true)]
    [hashtable]$Headers,
    [Parameter(Mandatory = $true)]
    [string]$Body,
    [int]$TimeoutSeconds = 180,
    [int]$MaxAttempts = 3,
    [int]$DelaySeconds = 2
  )

  $attempt = 0
  while ($attempt -lt $MaxAttempts) {
    $attempt += 1
    try {
      return Invoke-RestMethod -Uri $Uri `
        -Method Post `
        -Headers $Headers `
        -ContentType "application/json" `
        -Body $Body `
        -TimeoutSec $TimeoutSeconds
    } catch {
      if ($attempt -ge $MaxAttempts) {
        throw
      }
      Start-Sleep -Seconds $DelaySeconds
    }
  }

  throw "Failed to POST $Uri after $MaxAttempts attempt(s)."
}

Require-Command "npm"
Require-Command "node"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\\.."))
$resolvedRouterRoot = if ([string]::IsNullOrWhiteSpace($RouterRoot)) {
  Resolve-ExistingPath -Candidates @(
    (Join-Path $repoRoot "vendor\\9router")
  )
} else {
  Resolve-ExistingPath -Candidates @($RouterRoot)
}

if (-not $resolvedRouterRoot) {
  throw "Could not resolve 9router root."
}

$resolvedRouterDataDir = if ([string]::IsNullOrWhiteSpace($RouterDataDir)) {
  Join-Path $resolvedRouterRoot ".runtime-data"
} else {
  $RouterDataDir
}
$resolvedRouterDataDir = [System.IO.Path]::GetFullPath($resolvedRouterDataDir)
New-Item -ItemType Directory -Force -Path $resolvedRouterDataDir | Out-Null

$startManagerScript = Join-Path $PSScriptRoot "start-perplexity-manager.ps1"
if (-not (Test-Path $startManagerScript)) {
  throw "Perplexity runtime manager bootstrap script not found at $startManagerScript"
}

$startManagerArgs = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", $startManagerScript,
  "-CdpPort", $PerplexityCdpPort,
  "-ManagerPort", $PerplexityManagerPort,
  "-ApiKey", $ManagerApiKey,
  "-Models", "$DefaultModel,$HealthModel"
)
if ($RestartPerplexity) {
  $startManagerArgs += "-RestartApp"
}
& powershell.exe @startManagerArgs | Out-Null

$routerBaseUrl = "http://$RouterHost`:$RouterPort"
$routerHealth = Test-HttpJson -Uri "$routerBaseUrl/api/version"
if ($null -eq $routerHealth) {
  Ensure-NpmInstall -WorkingDirectory $resolvedRouterRoot
  if (-not $SkipRouterBuild) {
    Ensure-NineRouterBuild -WorkingDirectory $resolvedRouterRoot
  }
  Start-NineRouter -WorkingDirectory $resolvedRouterRoot -DataDir $resolvedRouterDataDir -Host $RouterHost -Port $RouterPort
  $routerHealth = Wait-HttpReady -Uri "$routerBaseUrl/api/version" -TimeoutSeconds 90
}

$managerBaseUrl = "http://127.0.0.1:$PerplexityManagerPort/v1"
$cdpBaseUrl = "http://127.0.0.1:$PerplexityCdpPort"
$managerHealth = Wait-HttpReady -Uri "http://127.0.0.1:$PerplexityManagerPort/health" -TimeoutSeconds 45

$nodeCreated = $false
$node = Ensure-ProviderNode -BaseUrl $routerBaseUrl -Name $NodeName -Prefix $NodePrefix -ApiType "chat" -UpstreamBaseUrl $managerBaseUrl -Created ([ref]$nodeCreated)
$connectionCreated = $false
$connection = Ensure-ProviderConnection -BaseUrl $routerBaseUrl -ProviderId $node.id -Name $NodeName -ApiKey $ManagerApiKey -DefaultModel $DefaultModel -Created ([ref]$connectionCreated)
$removedConnections = Remove-ConflictingProviderConnections -BaseUrl $routerBaseUrl -KeepConnectionId $connection.id -Prefixes @($NodePrefix, "pplx") -ApiType "chat"
$removedNodes = Remove-ConflictingProviderNodes -BaseUrl $routerBaseUrl -KeepNodeId $node.id -Prefixes @($NodePrefix, "pplx") -ApiType "chat"

$managerWarmBody = @{
  model = "app-health"
  messages = @(
    @{
      role = "user"
      content = "Reply exactly PPLX_MANAGER_OK"
    }
  )
} | ConvertTo-Json -Depth 6

$managerWarmResponse = Invoke-JsonPostWithRetry `
  -Uri "$managerBaseUrl/chat/completions" `
  -Headers @{ Authorization = "Bearer $ManagerApiKey" } `
  -Body $managerWarmBody `
  -TimeoutSeconds 180 `
  -MaxAttempts 4 `
  -DelaySeconds 2

$probeBody = @{
  model = $HealthModel
  messages = @(
    @{
      role = "user"
      content = "Reply exactly PPLX_9ROUTER_MANAGER_OK"
    }
  )
} | ConvertTo-Json -Depth 6

$probeResponse = Invoke-JsonPostWithRetry `
  -Uri "$routerBaseUrl/v1/chat/completions" `
  -Headers @{ Authorization = "Bearer local-9router" } `
  -Body $probeBody `
  -TimeoutSeconds 180 `
  -MaxAttempts 4 `
  -DelaySeconds 2

$managerWarmCompletionRaw = [string]$managerWarmResponse.choices[0].message.content
$managerWarmCompletion = Normalize-PerplexityProbeCompletion -Value $managerWarmCompletionRaw
$routerProbeCompletionRaw = [string]$probeResponse.choices[0].message.content
$routerProbeCompletion = Normalize-PerplexityProbeCompletion -Value $routerProbeCompletionRaw

if ($managerWarmCompletion -ne "PPLX_MANAGER_OK") {
  throw "Perplexity manager warm probe returned an unexpected completion: $managerWarmCompletionRaw"
}

if ($routerProbeCompletion -ne "PPLX_9ROUTER_MANAGER_OK") {
  throw "Perplexity 9router probe returned an unexpected completion: $routerProbeCompletionRaw"
}

$stableRuntime = Wait-PerplexityRuntimeStable `
  -ManagerHealthUri "http://127.0.0.1:$PerplexityManagerPort/health" `
  -CdpVersionUri "${cdpBaseUrl}/json/version" `
  -TimeoutSeconds 45 `
  -ConsecutiveSuccesses 2

[pscustomobject]@{
  router_base_url = $routerBaseUrl
  perplexity_manager_base_url = "http://127.0.0.1:$PerplexityManagerPort"
  cdp_port = $PerplexityCdpPort
  node_prefix = $NodePrefix
  default_model = $DefaultModel
  health_model = $HealthModel
  manager_status = $stableRuntime.manager.status
  router_version = $routerHealth.currentVersion
  cdp_browser = $stableRuntime.cdp.Browser
  node_created = $nodeCreated
  connection_created = $connectionCreated
  removed_stale_connections = @($removedConnections | ForEach-Object { $_.id })
  removed_stale_nodes = @($removedNodes | ForEach-Object { $_.id })
  manager_warm_completion = $managerWarmCompletion
  manager_warm_completion_raw = $managerWarmCompletionRaw
  router_probe_completion = $routerProbeCompletion
  router_probe_completion_raw = $routerProbeCompletionRaw
} | ConvertTo-Json -Depth 6
