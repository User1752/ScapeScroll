<#
.SYNOPSIS
  Logs CPU/RAM for node.exe, flaresolverr.exe, and any chrome.exe/chromedriver.exe
  processes to a timestamped CSV, once per second, in the background.

.DESCRIPTION
  Built to answer one specific question: "was ScrollScape/FlareSolverr doing
  something heavy at the exact moment a game (or anything else) stuttered?" —
  without having to watch Task Manager live while playing, which isn't
  practical mid-match. Start this before a session, play normally, and after
  a freeze just note roughly when it happened; the CSV has a timestamp per
  row so you can jump straight to that moment afterward.

  Read-only: this never touches ScrollScape's own files or processes, it
  only observes them via Get-Process (same as Task Manager does).

.PARAMETER DurationMinutes
  How long to log before stopping automatically. Default 120 (2 hours).
  Press Ctrl+C any time to stop early — the CSV is flushed after every
  sample, so nothing is lost by stopping early.

.PARAMETER OutFile
  Where to write the CSV. Defaults to a timestamped file next to this
  script, e.g. tools\freeze-monitor-2026-08-25_20-15-00.csv

.EXAMPLE
  # Right-click this file -> Run with PowerShell, or from a terminal:
  .\tools\freeze-monitor.ps1

.EXAMPLE
  # Log for 45 minutes instead of the 2-hour default
  .\tools\freeze-monitor.ps1 -DurationMinutes 45
#>
param(
  [int]$DurationMinutes = 120,
  [string]$OutFile = ""
)

if (-not $OutFile) {
  $stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
  $OutFile = Join-Path $PSScriptRoot "freeze-monitor-$stamp.csv"
}

# CPU_Percent below is computed the same way ScrollScape's own resource
# monitor does it (server/modules/system-health/resource-monitor.js):
# delta of the process's cumulative CPU *time* between two samples, divided
# by wall-clock elapsed time and core count — Get-Process's raw .CPU
# property is cumulative seconds since the process started, not an
# instantaneous percentage, so it has to be diffed against the previous
# sample to mean anything useful here.
$prevCpu = @{}   # pid -> TotalProcessorTime (TimeSpan) at last sample
$prevAt = Get-Date
$coreCount = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors

'Timestamp,ProcessName,PID,CPU_Percent,WorkingSet_MB' | Out-File -FilePath $OutFile -Encoding utf8

Write-Host "A gravar em: $OutFile"
Write-Host "A monitorizar node/flaresolverr/chrome/chromedriver durante $DurationMinutes minuto(s). Ctrl+C para parar antes."
Write-Host "Joga normalmente. Depois de sentires um engasgamento, nota a hora aproximada e vai a este ficheiro procurar essa linha."
Write-Host ""

$endAt = (Get-Date).AddMinutes($DurationMinutes)

while ((Get-Date) -lt $endAt) {
  $now = Get-Date
  $elapsedSec = ($now - $prevAt).TotalSeconds
  if ($elapsedSec -le 0) { $elapsedSec = 1 }

  $procs = Get-Process | Where-Object { $_.ProcessName -match '^(node|flaresolverr|chrome|chromedriver)$' }
  $tsText = $now.ToString('yyyy-MM-dd HH:mm:ss')
  $rows = @()

  foreach ($p in $procs) {
    $cpuNow = $p.TotalProcessorTime
    $cpuPercent = 0
    if ($prevCpu.ContainsKey($p.Id)) {
      $deltaSec = ($cpuNow - $prevCpu[$p.Id]).TotalSeconds
      $cpuPercent = [math]::Round((($deltaSec / $elapsedSec) / $coreCount) * 100, 1)
      if ($cpuPercent -lt 0) { $cpuPercent = 0 }
    }
    $prevCpu[$p.Id] = $cpuNow
    $wsMb = [math]::Round($p.WorkingSet64 / 1MB, 1)
    $rows += "$tsText,$($p.ProcessName),$($p.Id),$cpuPercent,$wsMb"
  }

  if ($rows.Count -gt 0) {
    $rows | Out-File -FilePath $OutFile -Encoding utf8 -Append
    # Quick live glance without needing to open the file — only prints
    # anything visibly heavy so the console doesn't scroll constantly.
    foreach ($r in $rows) {
      $parts = $r -split ','
      if ([double]$parts[3] -gt 15) {
        Write-Host "$tsText  $($parts[1]) (PID $($parts[2]))  CPU: $($parts[3])%  RAM: $($parts[4]) MB"
      }
    }
  }

  $prevAt = $now
  Start-Sleep -Seconds 1
}

Write-Host ""
Write-Host "Terminado. Log completo em: $OutFile"
