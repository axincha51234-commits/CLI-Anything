[CmdletBinding()]
param(
  [string]$AntigravityManagerRoot = "",
  [string]$AntigravityBinary = "",
  [string]$RouterRoot = "",
  [string]$RouterDataDir = "",
  [string]$RouterHost = "127.0.0.1",
  [int]$AntigravityPort = 8045,
  [int]$RouterPort = 20128,
  [switch]$SkipRouterBuild = $false,
  [switch]$SkipResponsesNode = $false
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

function Start-AntigravityManager {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BinaryPath
  )

  Start-Process -FilePath $BinaryPath -ArgumentList "--headless" -WindowStyle Hidden | Out-Null
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

  $stdoutPath = Join-Path $WorkingDirectory "runtime-9router.log"
  $stderrPath = Join-Path $WorkingDirectory "runtime-9router.err.log"
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
    [ref]$Created
  )

  $nodesResponse = Invoke-RestMethod -Uri "$BaseUrl/api/provider-nodes" -Method Get -TimeoutSec 10
  $existing = @($nodesResponse.nodes) | Where-Object {
    $_.prefix -eq $Prefix -and $_.apiType -eq $ApiType -and $_.baseUrl -eq "http://127.0.0.1:$AntigravityPort/v1"
  } | Select-Object -First 1
  if ($existing) {
    $Created.Value = $false
    return $existing
  }

  $payload = @{
    name = $Name
    prefix = $Prefix
    apiType = $ApiType
    baseUrl = "http://127.0.0.1:$AntigravityPort/v1"
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

Require-Command "npm"
Require-Command "node"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\\.."))
$documentsRoot = [Environment]::GetFolderPath("MyDocuments")
$resolvedAntigravityRoot = if ([string]::IsNullOrWhiteSpace($AntigravityManagerRoot)) {
  Resolve-ExistingPath -Candidates @(
    (Join-Path $documentsRoot "Antigravity-Manager-main")
  )
} else {
  Resolve-ExistingPath -Candidates @($AntigravityManagerRoot)
}

if (-not $resolvedAntigravityRoot) {
  throw "Could not resolve Antigravity-Manager root."
}

$resolvedAntigravityBinary = if ([string]::IsNullOrWhiteSpace($AntigravityBinary)) {
  Resolve-ExistingPath -Candidates @(
    (Join-Path $resolvedAntigravityRoot "src-tauri\\target\\debug\\antigravity_tools.exe"),
    (Join-Path $resolvedAntigravityRoot "src-tauri\\target\\release\\antigravity_tools.exe")
  )
} else {
  Resolve-ExistingPath -Candidates @($AntigravityBinary)
}

if (-not $resolvedAntigravityBinary) {
  throw "Could not resolve antigravity_tools.exe."
}

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

$managerConfigPath = Join-Path $HOME ".antigravity_tools\\gui_config.json"
if (-not (Test-Path $managerConfigPath)) {
  throw "Could not find Antigravity-Manager config at $managerConfigPath"
}
$managerConfig = Get-Content $managerConfigPath | ConvertFrom-Json
$managerApiKey = [string]$managerConfig.proxy.api_key
if ([string]::IsNullOrWhiteSpace($managerApiKey)) {
  throw "Antigravity-Manager API key is missing in $managerConfigPath"
}

$antigravityBaseUrl = "http://127.0.0.1:$AntigravityPort"
$routerBaseUrl = "http://$RouterHost`:$RouterPort"
$managerStarted = $false
$routerStarted = $false

$managerHealth = Test-HttpJson -Uri "$antigravityBaseUrl/health"
if ($null -eq $managerHealth) {
  Start-AntigravityManager -BinaryPath $resolvedAntigravityBinary
  $managerHealth = Wait-HttpReady -Uri "$antigravityBaseUrl/health"
  $managerStarted = $true
}

$routerHealth = Test-HttpJson -Uri "$routerBaseUrl/api/version"
if ($null -eq $routerHealth) {
  Ensure-NpmInstall -WorkingDirectory $resolvedRouterRoot
  if (-not $SkipRouterBuild) {
    Ensure-NineRouterBuild -WorkingDirectory $resolvedRouterRoot
  }
  Start-NineRouter -WorkingDirectory $resolvedRouterRoot -DataDir $resolvedRouterDataDir -Host $RouterHost -Port $RouterPort
  $routerHealth = Wait-HttpReady -Uri "$routerBaseUrl/api/version" -TimeoutSeconds 90
  $routerStarted = $true
}

$proxyStatus = Wait-HttpReady -Uri "$antigravityBaseUrl/api/proxy/status" -Headers @{ Authorization = "Bearer $managerApiKey" }
$routerModels = Wait-HttpReady -Uri "$routerBaseUrl/v1/models" -Headers @{ Authorization = "Bearer local-9router" }

$chatNodeCreated = $false
$chatNode = Ensure-ProviderNode -BaseUrl $routerBaseUrl -Name "Antigravity Manager Local" -Prefix "agm" -ApiType "chat" -Created ([ref]$chatNodeCreated)
$chatConnectionCreated = $false
$chatConnection = Ensure-ProviderConnection -BaseUrl $routerBaseUrl -ProviderId $chatNode.id -Name "Antigravity Manager Local" -ApiKey $managerApiKey -DefaultModel "agm/gpt-4o-mini" -Created ([ref]$chatConnectionCreated)

$responsesNode = $null
$responsesConnection = $null
$responsesNodeCreated = $false
$responsesConnectionCreated = $false
if (-not $SkipResponsesNode) {
  $responsesNode = Ensure-ProviderNode -BaseUrl $routerBaseUrl -Name "Antigravity Manager Responses" -Prefix "agr" -ApiType "responses" -Created ([ref]$responsesNodeCreated)
  $responsesConnection = Ensure-ProviderConnection -BaseUrl $routerBaseUrl -ProviderId $responsesNode.id -Name "Antigravity Manager Responses" -ApiKey $managerApiKey -DefaultModel "agr/gpt-4o-mini" -Created ([ref]$responsesConnectionCreated)
}

$chatProbeBody = @{
  model = "agm/gpt-4o-mini"
  messages = @(
    @{
      role = "user"
      content = "Reply with OK only."
    }
  )
} | ConvertTo-Json -Depth 8
$chatProbe = Invoke-RestMethod -Uri "$routerBaseUrl/v1/chat/completions" -Method Post -Headers @{
  Authorization = "Bearer local-9router"
  "Content-Type" = "application/json"
} -Body $chatProbeBody -TimeoutSec 30

$responsesProbeBody = @{
  model = "agr/gpt-4o-mini"
  input = @(
    @{
      role = "user"
      content = @(
        @{
          type = "input_text"
          text = "Reply with OK only."
        }
      )
    }
  )
} | ConvertTo-Json -Depth 10
$responsesProbe = if (-not $SkipResponsesNode) {
  Invoke-RestMethod -Uri "$routerBaseUrl/v1/responses" -Method Post -Headers @{
    Authorization = "Bearer local-9router"
    "Content-Type" = "application/json"
  } -Body $responsesProbeBody -TimeoutSec 30
} else {
  $null
}

[pscustomobject]@{
  antigravity = [pscustomobject]@{
    base_url = $antigravityBaseUrl
    started_now = $managerStarted
    version = $managerHealth.version
    active_accounts = $proxyStatus.active_accounts
    api_key_source = $managerConfigPath
  }
  router = [pscustomobject]@{
    base_url = "$routerBaseUrl/v1"
    started_now = $routerStarted
    version = $routerHealth.currentVersion
    data_dir = $resolvedRouterDataDir
    model_count = @($routerModels.data).Count
  }
  routes = [pscustomobject]@{
    chat = [pscustomobject]@{
      prefix = "agm"
      provider_id = $chatNode.id
      connection_id = $chatConnection.id
      created_node = $chatNodeCreated
      created_connection = $chatConnectionCreated
      probe_text = $chatProbe.choices[0].message.content
    }
    responses = if ($SkipResponsesNode) {
      $null
    } else {
      [pscustomobject]@{
        prefix = "agr"
        provider_id = $responsesNode.id
        connection_id = $responsesConnection.id
        created_node = $responsesNodeCreated
        created_connection = $responsesConnectionCreated
        probe_object = $responsesProbe.object
      }
    }
  }
  recommended_review_workflow = [pscustomobject]@{
    review_api_url = "$routerBaseUrl/v1"
    review_api_key = "local-9router"
    review_model = "agm/gpt-4o-mini"
  }
  notes = @(
    "Use agm/gpt-4o-mini for GitHub review workflow through 9router.",
    "The agr responses path is useful for experimentation, but Antigravity-backed replies are still completion-shaped, so keep Codex CLI local execution on a native Responses-compatible endpoint for now."
  )
} | ConvertTo-Json -Depth 8
