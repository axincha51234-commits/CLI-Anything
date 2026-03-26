[CmdletBinding()]
param(
  [string]$RouterRoot = "",
  [string]$RouterDataDir = "",
  [string]$RouterHost = "127.0.0.1",
  [int]$RouterPort = 20128,
  [int]$BlackboxManagerPort = 8083,
  [string]$NodePrefix = "bbxapp",
  [string]$NodeName = "Blackbox Account Manager Local",
  [string]$DefaultModel = "bbxapp/app-agent",
  [string]$ManagerApiKey = "local-blackbox",
  [string]$StateDbPath = "",
  [string]$UpstreamBaseUrl = "https://oi-vscode-server-985058387028.europe-west1.run.app",
  [string]$UpstreamModel = "custom/blackbox-base-2",
  [string]$CustomerId = "placeholder",
  [switch]$SkipRouterBuild = $false,
  [switch]$ForceRefreshManager = $false
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

  $stdoutPath = Join-Path $env:TEMP "9router-bbx.stdout.log"
  $stderrPath = Join-Path $env:TEMP "9router-bbx.stderr.log"
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
    [string]$Prefix,
    [Parameter(Mandatory = $true)]
    [ValidateSet("chat", "responses")]
    [string]$ApiType
  )

  $nodesResponse = Invoke-RestMethod -Uri "$BaseUrl/api/provider-nodes" -Method Get -TimeoutSec 10
  $staleNodes = @($nodesResponse.nodes) | Where-Object {
    $_.id -ne $KeepNodeId -and $_.prefix -eq $Prefix -and $_.apiType -eq $ApiType
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
    [string]$Prefix,
    [Parameter(Mandatory = $true)]
    [ValidateSet("chat", "responses")]
    [string]$ApiType
  )

  $providersResponse = Invoke-RestMethod -Uri "$BaseUrl/api/providers" -Method Get -TimeoutSec 10
  $staleConnections = @($providersResponse.connections) | Where-Object {
    $_.id -ne $KeepConnectionId `
      -and $_.providerSpecificData.prefix -eq $Prefix `
      -and $_.providerSpecificData.apiType -eq $ApiType
  }

  foreach ($staleConnection in $staleConnections) {
    Invoke-RestMethod -Uri "$BaseUrl/api/providers/$($staleConnection.id)" -Method Delete -TimeoutSec 10 | Out-Null
  }

  return @($staleConnections)
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

$startManagerScript = Join-Path $PSScriptRoot "start-blackbox-manager.ps1"
if (-not (Test-Path $startManagerScript)) {
  throw "Blackbox account manager bootstrap script not found at $startManagerScript"
}

$startManagerArgs = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", $startManagerScript,
  "-ManagerPort", $BlackboxManagerPort,
  "-ApiKey", $ManagerApiKey,
  "-Models", $DefaultModel
)

if (-not [string]::IsNullOrWhiteSpace($StateDbPath)) {
  $startManagerArgs += @("-StateDbPath", $StateDbPath)
}
$startManagerArgs += @(
  "-UpstreamBaseUrl", $UpstreamBaseUrl,
  "-UpstreamModel", $UpstreamModel,
  "-CustomerId", $CustomerId
)

if ($ForceRefreshManager) {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -match '^node(\.exe)?$' -and $_.CommandLine -match 'blackbox-account-manager\.mjs'
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
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

$managerBaseUrl = "http://127.0.0.1:$BlackboxManagerPort/v1"
$managerHealth = Wait-HttpReady -Uri "http://127.0.0.1:$BlackboxManagerPort/health" -TimeoutSeconds 60

$nodeCreated = $false
$node = Ensure-ProviderNode -BaseUrl $routerBaseUrl -Name $NodeName -Prefix $NodePrefix -ApiType "chat" -UpstreamBaseUrl $managerBaseUrl -Created ([ref]$nodeCreated)
$connectionCreated = $false
$connection = Ensure-ProviderConnection -BaseUrl $routerBaseUrl -ProviderId $node.id -Name $NodeName -ApiKey $ManagerApiKey -DefaultModel $DefaultModel -Created ([ref]$connectionCreated)
$removedConnections = Remove-ConflictingProviderConnections -BaseUrl $routerBaseUrl -KeepConnectionId $connection.id -Prefix $NodePrefix -ApiType "chat"
$removedNodes = Remove-ConflictingProviderNodes -BaseUrl $routerBaseUrl -KeepNodeId $node.id -Prefix $NodePrefix -ApiType "chat"

$managerProbeBody = @{
  model = "app-agent"
  messages = @(
    @{
      role = "user"
      content = "Reply exactly BBX_MANAGER_OK"
    }
  )
} | ConvertTo-Json -Depth 6

$managerProbeResponse = Invoke-RestMethod -Uri "$managerBaseUrl/chat/completions" `
  -Method Post `
  -Headers @{ Authorization = "Bearer $ManagerApiKey" } `
  -ContentType "application/json" `
  -Body $managerProbeBody `
  -TimeoutSec 120

$managerCompletion = [string]$managerProbeResponse.choices[0].message.content
if ([string]::IsNullOrWhiteSpace($managerCompletion)) {
  throw "Blackbox account manager probe returned an empty completion."
}

$routerProbeBody = @{
  model = $DefaultModel
  messages = @(
    @{
      role = "user"
      content = "Reply exactly BBX_9ROUTER_OK"
    }
  )
} | ConvertTo-Json -Depth 6

$routerProbeResponse = Invoke-RestMethod -Uri "$routerBaseUrl/v1/chat/completions" `
  -Method Post `
  -Headers @{ Authorization = "Bearer local-9router" } `
  -ContentType "application/json" `
  -Body $routerProbeBody `
  -TimeoutSec 120

$routerCompletion = [string]$routerProbeResponse.choices[0].message.content
if ([string]::IsNullOrWhiteSpace($routerCompletion)) {
  throw "Blackbox 9router probe returned an empty completion."
}

[pscustomobject]@{
  router_base_url = $routerBaseUrl
  blackbox_manager_base_url = "http://127.0.0.1:$BlackboxManagerPort"
  node_prefix = $NodePrefix
  default_model = $DefaultModel
  manager_status = $managerHealth.status
  router_version = $routerHealth.currentVersion
  node_created = $nodeCreated
  connection_created = $connectionCreated
  removed_conflicting_connections = @($removedConnections | ForEach-Object { $_.id })
  removed_conflicting_nodes = @($removedNodes | ForEach-Object { $_.id })
  manager_probe_completion = $managerCompletion
  router_probe_completion = $routerCompletion
} | ConvertTo-Json -Depth 6
