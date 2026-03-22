[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Repository = "axincha51234-commits/CLI-Anything",
  [string]$RunnerRoot = "",
  [string]$RunnerName = "",
  [string[]]$RunnerLabels = @("windows", "codex-head"),
  [switch]$InstallService = $true,
  [switch]$InstallScheduledTaskFallback = $true,
  [switch]$ForceNode24Actions = $true,
  [switch]$SetRunsOnVariable,
  [string]$ScheduledTaskName = "",
  [string]$ReviewApiUrl = "",
  [string]$ReviewApiKey = "",
  [string]$ReviewModel = ""
)

$ErrorActionPreference = "Stop"

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Invoke-GhJson {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Args
  )

  $output = & gh @Args
  if ($LASTEXITCODE -ne 0) {
    throw "gh command failed: gh $($Args -join ' ')"
  }
  if ([string]::IsNullOrWhiteSpace($output)) {
    return $null
  }
  return $output | ConvertFrom-Json
}

function Register-RunnerScheduledTask {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TaskName,
    [Parameter(Mandatory = $true)]
    [string]$RunnerRoot,
    [Parameter(Mandatory = $true)]
    [string]$RunCmd
  )

  $taskAction = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"`"$RunCmd`"`"" `
    -WorkingDirectory $RunnerRoot

  $taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $taskSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

  $taskPrincipal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Highest

  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $taskAction `
    -Trigger $taskTrigger `
    -Settings $taskSettings `
    -Principal $taskPrincipal `
    -Force | Out-Null
}

Require-Command "gh"
Require-Command "Register-ScheduledTask"
Require-Command "Start-ScheduledTask"

$repoUrl = "https://github.com/$Repository"
$resolvedRunnerRoot = if ([string]::IsNullOrWhiteSpace($RunnerRoot)) {
  Join-Path $PSScriptRoot "..\\runtime\\github-runner"
} else {
  $RunnerRoot
}
$resolvedRunnerRoot = [System.IO.Path]::GetFullPath($resolvedRunnerRoot)
$resolvedRunnerName = if ([string]::IsNullOrWhiteSpace($RunnerName)) {
  "$env:COMPUTERNAME-codex-head"
} else {
  $RunnerName
}
$resolvedScheduledTaskName = if ([string]::IsNullOrWhiteSpace($ScheduledTaskName)) {
  "Codex Head Runner ($resolvedRunnerName)"
} else {
  $ScheduledTaskName
}
$labelCsv = (($RunnerLabels | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ",")
$runsOnLabels = @("self-hosted") + ($RunnerLabels | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$runsOnJson = $runsOnLabels | ConvertTo-Json -Compress

Write-Host "Repository: $Repository"
Write-Host "Runner root: $resolvedRunnerRoot"
Write-Host "Runner name: $resolvedRunnerName"
Write-Host "Runner labels: $labelCsv"
Write-Host "Scheduled task: $resolvedScheduledTaskName"

if ($ForceNode24Actions) {
  [Environment]::SetEnvironmentVariable("FORCE_JAVASCRIPT_ACTIONS_TO_NODE24", "true", "User")
  $env:FORCE_JAVASCRIPT_ACTIONS_TO_NODE24 = "true"
  Write-Host "Configured FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true for the current user."
}

$downloads = Invoke-GhJson -Args @("api", "repos/$Repository/actions/runners/downloads")
$runnerPackage = $downloads | Where-Object { $_.os -eq "win" -and $_.architecture -eq "x64" } | Select-Object -First 1
if (-not $runnerPackage) {
  throw "Could not resolve a Windows x64 GitHub Actions runner package."
}

$zipPath = Join-Path $resolvedRunnerRoot $runnerPackage.filename
$expectedSha = [string]$runnerPackage.sha256_checksum

if ($PSCmdlet.ShouldProcess($resolvedRunnerRoot, "Prepare self-hosted runner files")) {
  New-Item -ItemType Directory -Force -Path $resolvedRunnerRoot | Out-Null
  Invoke-WebRequest -Uri $runnerPackage.download_url -OutFile $zipPath

  $actualSha = (Get-FileHash -Algorithm SHA256 -Path $zipPath).Hash.ToLowerInvariant()
  if ($actualSha -ne $expectedSha.ToLowerInvariant()) {
    throw "Runner package checksum mismatch. Expected $expectedSha but received $actualSha."
  }

  Expand-Archive -Path $zipPath -DestinationPath $resolvedRunnerRoot -Force
}

$registration = Invoke-GhJson -Args @("api", "-X", "POST", "repos/$Repository/actions/runners/registration-token")
if (-not $registration.token) {
  throw "Failed to obtain a runner registration token for $Repository."
}

$configCmd = Join-Path $resolvedRunnerRoot "config.cmd"
$svcCmd = Join-Path $resolvedRunnerRoot "svc.cmd"
$runCmd = Join-Path $resolvedRunnerRoot "run.cmd"

if ($PSCmdlet.ShouldProcess($Repository, "Register self-hosted runner")) {
  Push-Location $resolvedRunnerRoot
  try {
    & $configCmd `
      --unattended `
      --replace `
      --url $repoUrl `
      --token $registration.token `
      --name $resolvedRunnerName `
      --labels $labelCsv `
      --work "_work"
    if ($LASTEXITCODE -ne 0) {
      throw "config.cmd failed with exit code $LASTEXITCODE."
    }

    if ($InstallService) {
      if (Test-Path $svcCmd) {
        & $svcCmd install
        if ($LASTEXITCODE -ne 0) {
          throw "svc.cmd install failed with exit code $LASTEXITCODE."
        }
        & $svcCmd start
        if ($LASTEXITCODE -ne 0) {
          throw "svc.cmd start failed with exit code $LASTEXITCODE."
        }
      } else {
        Write-Warning "svc.cmd was not found in the downloaded runner package. Skipping Windows service installation."
        if ($InstallScheduledTaskFallback) {
          Register-RunnerScheduledTask -TaskName $resolvedScheduledTaskName -RunnerRoot $resolvedRunnerRoot -RunCmd $runCmd
          Start-ScheduledTask -TaskName $resolvedScheduledTaskName
          Write-Warning "Registered scheduled task fallback '$resolvedScheduledTaskName' and started it."
        } else {
          Write-Warning "Start the runner manually with '$runCmd' or wrap it in your own Windows service or scheduled task."
        }
      }
    }
  } finally {
    Pop-Location
  }
}

if ($SetRunsOnVariable -and $PSCmdlet.ShouldProcess($Repository, "Set CODEX_HEAD_RUNS_ON_JSON repository variable")) {
  & gh variable set CODEX_HEAD_RUNS_ON_JSON --repo $Repository --body $runsOnJson
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to set CODEX_HEAD_RUNS_ON_JSON for $Repository."
  }
}

if (-not [string]::IsNullOrWhiteSpace($ReviewApiUrl) -and -not [string]::IsNullOrWhiteSpace($ReviewApiKey)) {
  if ($PSCmdlet.ShouldProcess($Repository, "Set REVIEW_API_URL and REVIEW_API_KEY repository secrets")) {
    $ReviewApiUrl | gh secret set REVIEW_API_URL --repo $Repository --body -
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to set REVIEW_API_URL."
    }
    $ReviewApiKey | gh secret set REVIEW_API_KEY --repo $Repository --body -
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to set REVIEW_API_KEY."
    }
    if (-not [string]::IsNullOrWhiteSpace($ReviewModel)) {
      $ReviewModel | gh secret set REVIEW_MODEL --repo $Repository --body -
      if ($LASTEXITCODE -ne 0) {
        throw "Failed to set REVIEW_MODEL."
      }
    }
  }
}

Write-Host ""
Write-Host "Self-hosted runner setup is complete."
Write-Host "Suggested runs-on JSON: $runsOnJson"
if ($InstallScheduledTaskFallback -and -not (Test-Path $svcCmd)) {
  Write-Host "Scheduled task fallback: $resolvedScheduledTaskName"
}
if ($ForceNode24Actions) {
  Write-Host "Node 24 actions opt-in: enabled"
}
if (-not [string]::IsNullOrWhiteSpace($ReviewApiUrl)) {
  Write-Host "Configured REVIEW_API_URL and REVIEW_API_KEY for $Repository."
}
