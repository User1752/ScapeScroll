# Starts a packaged ScrollScape .exe with everything bound to this computer only.
#
# Why: older builds spawn FlareSolverr with the environment they inherited, and
# FlareSolverr listens on 0.0.0.0 unless HOST says otherwise, which exposes it
# (no authentication) to the whole network. Pinning HOST to 127.0.0.1 here keeps
# both the app and FlareSolverr off the university network. Builds that include
# the lifecycle fix already pin it themselves.
#
# Run it with:  powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-ScrollScape-Safe.ps1
# Windows refuses to run .ps1 files directly under its default execution policy,
# which is why the command above spells the policy out.
#
# Which .exe: the one given with -Exe, otherwise the only ScrollScape*.exe found
# in your Downloads folder (up to two folders deep). The script prints the one it
# uses. It never guesses between several: each exe works out its own data folder,
# so starting the wrong one can open a different, blank library. With more than
# one candidate it lists them and stops (exit code 6); run it again with -Exe.
# The app itself prints "[Setup] Data folder: ..." in its own window when it
# starts; check that line names the library you expect.
#
# By default FlareSolverr is switched off for this run (also on patched builds, so
# an already installed copy is not started), and an exposed FlareSolverr found
# listening on the network is stopped. -AllowFlareSolverr is your consent to
# install and use it (still loopback-only). Use a build that includes the
# lifecycle fix: older ones cannot be told to stay off cleanly (see the comment
# at FLARESOLVERR_EXE_PATH below).
#
# To reach the app from your other devices use -TailscaleServe: Tailscale
# proxies your tailnet to 127.0.0.1, so no port is ever opened on the LAN. It
# refuses to run until an Access Password is set in the app (Settings), and it
# only protects the install/settings routes (SCROLLSCAPE_ADMIN_LOCAL_ONLY) on
# builds that include the patch: older builds ignore that variable, so there the
# password is the only barrier. /opds, /local-media and /sources-repo are never
# behind the password.
#
# Exit codes: 0 ok, 1 not safe (stopped), 2 the app did not start listening,
# 3 no Access Password, 4 tailscale serve failed, 5 refused (unrestricted build or
# something already published; see -IKnowTheRisk and -Force), 6 several ScrollScape
# executables found and no -Exe given, 10 any other error.
param(
    [string]$Exe,
    [int]$Port = 4000,
    [switch]$AllowFlareSolverr,
    [switch]$TailscaleServe,
    [switch]$IKnowTheRisk,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
trap { Write-Host $_.Exception.Message -ForegroundColor Red; exit 10 }

if (-not $Exe) {
    $downloads = Join-Path $env:USERPROFILE 'Downloads'
    $candidates = @(Get-ChildItem -LiteralPath $downloads -Filter 'ScrollScape*.exe' -File -Recurse -Depth 2 -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending)
    if ($candidates.Count -gt 1) {
        Write-Host "More than one ScrollScape executable was found under $downloads. Which one is started decides which library opens, so none was picked:" -ForegroundColor Yellow
        foreach ($c in $candidates) { Write-Host ('  {0}   (modified {1:yyyy-MM-dd HH:mm})' -f $c.FullName, $c.LastWriteTime) }
        Write-Host 'Run this script again with -Exe and the full path of the one you want.' -ForegroundColor Yellow
        exit 6
    }
    if ($candidates.Count -eq 1) { $Exe = $candidates[0].FullName }
}
if (-not $Exe -or -not (Test-Path -LiteralPath $Exe -PathType Leaf)) { throw 'ScrollScape .exe not found; pass its path with -Exe.' }
$Exe = (Resolve-Path -LiteralPath $Exe).Path
Write-Host "Using $Exe"

function Get-Listeners([int[]]$Ports) {
    @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $Ports -contains $_.LocalPort })
}

function Get-ProcessTree([int]$RootPid) {
    $all = Get-CimInstance Win32_Process
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    $queue = [System.Collections.Generic.Queue[int]]::new()
    $queue.Enqueue($RootPid)
    while ($queue.Count -gt 0) {
        $id = $queue.Dequeue()
        if ($ids.Add($id)) {
            $all | Where-Object { $_.ParentProcessId -eq $id } | ForEach-Object { $queue.Enqueue([int]$_.ProcessId) }
        }
    }
    # The comma keeps PowerShell from unrolling the set into a bare int or array.
    return , $ids
}

# An old FlareSolverr that is already exposed on the network gets stopped, but
# only if the listener really is FlareSolverr (one process can show up twice, for
# 0.0.0.0 and ::, and taskkill /T also takes its Chrome children with it).
foreach ($l in (Get-Listeners 8191 | Where-Object { $_.LocalAddress -notin '127.0.0.1', '::1' } | Sort-Object OwningProcess -Unique)) {
    $p = Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue
    if (-not $p) { continue }   # already gone
    if ($p.ProcessName -eq 'flaresolverr') {
        Write-Host "An exposed FlareSolverr is already running (PID $($p.Id)); stopping it." -ForegroundColor Yellow
        & taskkill.exe /PID $p.Id /T /F | Out-Null
    } else {
        throw "Port 8191 is exposed by '$($p.ProcessName)' (PID $($l.OwningProcess)), which is not FlareSolverr. Stop it first."
    }
}

# A second copy would be refused by the single-instance check and this script
# would audit nothing, so say so up front.
$already = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -eq $Exe })
if ($already.Count -gt 0) {
    throw "$([IO.Path]::GetFileName($Exe)) is already running (PID $($already[0].Id)). Close it first so it can be started with the safe settings."
}
Start-Sleep 2

# The settings below are applied to the child process only: the caller's
# environment is restored right after the app has been started. Every variable
# set or cleared below must be in this list.
$saved = @{}
foreach ($name in 'HOST', 'PORT', 'SCROLLSCAPE_ADMIN_LOCAL_ONLY', 'FLARESOLVERR_AUTO_INSTALL', 'FLARESOLVERR_DISABLED', 'FLARESOLVERR_EXE_PATH') {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$env:HOST = '127.0.0.1'      # inherited by FlareSolverr when the app spawns it
$env:PORT = "$Port"
$env:SCROLLSCAPE_ADMIN_LOCAL_ONLY = '1'   # install sources / change settings only from this computer, even with a password
if ($AllowFlareSolverr) {
    $env:FLARESOLVERR_AUTO_INSTALL = '1'  # your consent: no first-run question, installs if missing
    # Nothing exported in the calling shell may undo that consent. An inherited
    # FLARESOLVERR_DISABLED=1 beats AUTO_INSTALL in the app, so the flag would do
    # nothing and the wait for FlareSolverr below would run for minutes; an
    # inherited FLARESOLVERR_EXE_PATH points the app at a copy this script knows
    # nothing about and makes it treat a launcher as owning the install.
    [Environment]::SetEnvironmentVariable('FLARESOLVERR_DISABLED', $null, 'Process')
    [Environment]::SetEnvironmentVariable('FLARESOLVERR_EXE_PATH', $null, 'Process')
} else {
    # Builds WITHOUT the lifecycle fix treat "a path is configured" as "FlareSolverr
    # is installed" and skip the GitHub download; a path that does not exist then
    # makes every launch attempt fail. That is not free on those builds: each failed
    # attempt runs their restart routine, which force-kills EVERY chromedriver.exe
    # on this computer (your own Selenium or Playwright runs included), sweeps
    # Chrome processes and polls the port for about 15 seconds before giving up.
    # Use a build that includes the fix: it honours FLARESOLVERR_DISABLED and never
    # goes down that path.
    $env:FLARESOLVERR_EXE_PATH = Join-Path $env:LOCALAPPDATA 'ScrollScape\flaresolverr-disabled\flaresolverr.exe'
    $env:FLARESOLVERR_DISABLED = '1'   # honoured by builds that include the fix
}
$proc = Start-Process -FilePath $Exe -WorkingDirectory (Split-Path $Exe) -PassThru
foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }

function Get-OwnedListeners {
    $ids = Get-ProcessTree $proc.Id
    Get-Process flaresolverr -ErrorAction SilentlyContinue | ForEach-Object { [void]$ids.Add($_.Id) }
    @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids.Contains([int]$_.OwningProcess) })
}

# Wait for the app to bind (it moves to the next port if 4000 is taken), then,
# when FlareSolverr is allowed, for it to appear (the first install downloads
# several hundred MB), and audit every listener owned by the app, its children
# and any FlareSolverr.
$appListener = $null
foreach ($i in 1..75) {
    Start-Sleep 2
    if ($proc.HasExited) {
        Write-Host "ScrollScape exited with code $($proc.ExitCode). If another copy is running, close it first (a second copy is refused)." -ForegroundColor Yellow
        exit 2
    }
    $appListener = Get-OwnedListeners | Where-Object { $_.OwningProcess -eq $proc.Id } | Select-Object -First 1
    if ($appListener) { break }
}
if ($AllowFlareSolverr) {
    Write-Host 'Waiting for FlareSolverr (the first install can take several minutes)...'
    foreach ($i in 1..150) {
        if (Get-Listeners 8191) { break }
        Start-Sleep 2
    }
}
$owned = Get-OwnedListeners
$owned | ForEach-Object {
    $n = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName
    "{0,-12} {1,5}  {2}" -f $_.LocalAddress, $_.LocalPort, $n
}
$bad = @($owned | Where-Object { $_.LocalAddress -notin '127.0.0.1', '::1' })
if ($bad.Count -gt 0) {
    Write-Host "NOT SAFE: something is listening beyond localhost. Stopping everything." -ForegroundColor Red
    foreach ($id in (Get-ProcessTree $proc.Id)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    Get-Process flaresolverr -ErrorAction SilentlyContinue | Stop-Process -Force
    exit 1
}
if (-not $appListener) {
    Write-Host "The app is not listening yet; check its window." -ForegroundColor Yellow
    exit 2
}
$appPort = $appListener.LocalPort
Write-Host "OK: everything is reachable from this computer only (app on port $appPort)." -ForegroundColor Green
# The app's output is not captured here (that would break its first-run question
# in the console), so the data folder can only be read off its own window.
Write-Host 'Library: look for the line "[Setup] Data folder: ..." in the ScrollScape window and check it is the folder you expect. A different exe can open a different, empty library.' -ForegroundColor Cyan

if ($TailscaleServe) {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$appPort/api/auth/status" -TimeoutSec 10
    if (-not $status.passwordSet) {
        Write-Host "Not enabling Tailscale: set an Access Password first (Settings > Sources > Access Password), then run this again." -ForegroundColor Yellow
        exit 3
    }
    $ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
    if (-not $ts) { $ts = 'C:\Program Files\Tailscale\tailscale.exe' }

    # Builds without the patch ignore SCROLLSCAPE_ADMIN_LOCAL_ONLY. Probe it: a patched build
    # answers 403 to a "proxied" request for a privileged route; any other answer means the
    # password would be the only barrier for installing sources and changing settings.
    $code = 0
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$appPort/api/settings" -Headers @{ 'X-Forwarded-For' = '203.0.113.9' } -TimeoutSec 10 | Out-Null
        $code = 200
    } catch {
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    }
    if ($code -ne 403 -and -not $IKnowTheRisk) {
        Write-Host "This build does not restrict the install/settings routes to this computer (HTTP $code): over Tailscale anyone with the password could install sources or change settings. Rebuild with the patch, or run again with -IKnowTheRisk." -ForegroundColor Yellow
        exit 5
    }

    # serve replaces whatever is already published on the default HTTPS port.
    $existing = (& $ts serve status 2>$null) -join "`n"
    if ($existing -match 'https://' -and -not $Force) {
        Write-Host "tailscale serve is already publishing something; run again with -Force to replace it.`n$existing" -ForegroundColor Yellow
        exit 5
    }
    & $ts serve --bg --yes "http://127.0.0.1:$appPort"
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'tailscale serve failed (is Tailscale running, and are HTTPS certificates enabled for your tailnet?).' -ForegroundColor Red
        exit 4
    }
    & $ts serve status
    Write-Host 'Tailnet-only proxy enabled. Stop it with: tailscale serve reset' -ForegroundColor Cyan
    Write-Host 'Note: /opds, /local-media and /sources-repo are not behind the password; every device on your tailnet can read them.' -ForegroundColor Yellow
}
