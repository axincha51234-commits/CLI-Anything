[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Repository = "axincha51234-commits/CLI-Anything",
  [string]$RunnerName = "",
  [string]$ScheduledTaskName = "",
  [string]$RunnerRoot = "",
  [int]$DrainTimeoutSec = 180,
  [int]$ReconnectTimeoutSec = 180,
  [int]$PollIntervalSec = 5
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

function Get-RunnerRecord {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Repository,
    [Parameter(Mandatory = $true)]
    [string]$RunnerName
  )

  $response = Invoke-GhJson -Args @("api", "repos/$Repository/actions/runners")
  $runner = $response.runners | Where-Object { $_.name -eq $RunnerName } | Select-Object -First 1
  if (-not $runner) {
    throw "Runner '$RunnerName' was not found in repository '$Repository'."
  }
  return $runner
}

function Wait-ForRunnerState {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Repository,
    [Parameter(Mandatory = $true)]
    [string]$RunnerName,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Condition,
    [Parameter(Mandatory = $true)]
    [string]$Description,
    [int]$TimeoutSec = 180,
    [int]$PollIntervalSec = 5
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $runner = Get-RunnerRecord -Repository $Repository -RunnerName $RunnerName
    Write-Host "Runner state: status=$($runner.status) busy=$($runner.busy)"
    if (& $Condition $runner) {
      return $runner
    }
    Start-Sleep -Seconds $PollIntervalSec
  }

  throw "Timed out waiting for runner '$RunnerName' to $Description."
}

Require-Command "gh"
Require-Command "Start-ScheduledTask"

$resolvedRunnerName = if ([string]::IsNullOrWhiteSpace($RunnerName)) {
  "$env:COMPUTERNAME-codex-head"
} else {
  $RunnerName
}
$resolvedRunnerRoot = if ([string]::IsNullOrWhiteSpace($RunnerRoot)) {
  Join-Path $PSScriptRoot "..\\runtime\\github-runner"
} else {
  $RunnerRoot
}
$resolvedRunnerRoot = [System.IO.Path]::GetFullPath($resolvedRunnerRoot)
$resolvedScheduledTaskName = if ([string]::IsNullOrWhiteSpace($ScheduledTaskName)) {
  "Codex Head Runner ($resolvedRunnerName)"
} else {
  $ScheduledTaskName
}
$runCmd = Join-Path $resolvedRunnerRoot "run.cmd"

Write-Host "Repository: $Repository"
Write-Host "Runner name: $resolvedRunnerName"
Write-Host "Runner root: $resolvedRunnerRoot"
Write-Host "Scheduled task: $resolvedScheduledTaskName"

if ($PSCmdlet.ShouldProcess($resolvedRunnerName, "Recycle self-hosted runner")) {
  $listenerProcesses = Get-Process Runner.Listener -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and $_.Path.StartsWith($resolvedRunnerRoot, [System.StringComparison]::OrdinalIgnoreCase)
  }

  try {
    $scheduledTask = Get-ScheduledTask -TaskName $resolvedScheduledTaskName -ErrorAction Stop
  } catch {
    $scheduledTask = $null
  }

  if ($scheduledTask) {
    try {
      Stop-ScheduledTask -TaskName $resolvedScheduledTaskName -ErrorAction SilentlyContinue
    } catch {
      Write-Warning "Failed to stop scheduled task '$resolvedScheduledTaskName'. Continuing with listener shutdown."
    }
  }

  if ($listenerProcesses) {
    $listenerProcesses | Stop-Process -Force
    Write-Host "Stopped existing Runner.Listener process(es)."
  } else {
    Write-Host "No tracked Runner.Listener process was running under $resolvedRunnerRoot."
  }

  Write-Host "Waiting for GitHub to clear the previous runner session..."
  Wait-ForRunnerState `
    -Repository $Repository `
    -RunnerName $resolvedRunnerName `
    -Condition { param($runner) -not $runner.busy } `
    -Description "clear the previous session" `
    -TimeoutSec $DrainTimeoutSec `
    -PollIntervalSec $PollIntervalSec | Out-Null

  if ($scheduledTask) {
    Start-ScheduledTask -TaskName $resolvedScheduledTaskName
    Write-Host "Started scheduled task '$resolvedScheduledTaskName'."
  } elseif (Test-Path $runCmd) {
    Start-Process -FilePath $runCmd -WorkingDirectory $resolvedRunnerRoot | Out-Null
    Write-Host "Started runner directly with '$runCmd'."
  } else {
    throw "Neither scheduled task '$resolvedScheduledTaskName' nor run.cmd at '$runCmd' was available."
  }

  Write-Host "Waiting for runner to reconnect..."
  $runner = Wait-ForRunnerState `
    -Repository $Repository `
    -RunnerName $resolvedRunnerName `
    -Condition { param($current) $current.status -eq "online" -and -not $current.busy } `
    -Description "come back online and idle" `
    -TimeoutSec $ReconnectTimeoutSec `
    -PollIntervalSec $PollIntervalSec

  Write-Host "Runner recycled successfully. status=$($runner.status) busy=$($runner.busy)"
}
