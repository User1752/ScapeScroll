@echo off
rem ============================================================================
rem  Setup-Suwayomi.cmd - sets up your own Suwayomi-Server on this Windows computer, for ScrollScape.
rem  Double-click it. It asks once before it does anything, and everything goes into a "Suwayomi" folder inside your ScrollScape folder:
rem  move the ScrollScape folder and it all moves with it; delete the Suwayomi folder and it is all gone.
rem
rem    Setup-Suwayomi.cmd              install (or start again) and show how to connect
rem    Setup-Suwayomi.cmd /dryrun      only check the download with GitHub, change nothing
rem    Setup-Suwayomi.cmd /uninstall   stop it and remove everything this script made
rem    /yes /nofirewall /noautostart   can be added: do not ask, skip the firewall rules, do not start it with Windows
rem    /user:NAME /pass:SECRET         a login of your own (letters, digits and . _ - only); the default is a user "scrollscape" and a long
rem                                    random password, which ScrollScape picks up by itself. Run again with these to change an existing one.
rem
rem  This file is a batch file followed by a PowerShell script: the batch part only starts PowerShell on the rest of the file.
rem ============================================================================
setlocal
set "SS_SELF=%~f0"
rem  The next line is filled in by ScrollScape when you download this file from Settings (the Suwayomi folder inside your ScrollScape folder).
set "SS_ROOT="
set "SS_MODE="
set "SS_YES="
set "SS_NOFIREWALL="
set "SS_NOAUTOSTART="
set "SS_USER="
set "SS_PASS="
:args
if "%~1"=="" goto run
if /i "%~1"=="/dryrun" set "SS_MODE=dryrun"
if /i "%~1"=="/uninstall" set "SS_MODE=uninstall"
if /i "%~1"=="/yes" set "SS_YES=1"
if /i "%~1"=="/nofirewall" set "SS_NOFIREWALL=1"
if /i "%~1"=="/noautostart" set "SS_NOAUTOSTART=1"
for /f "tokens=1,* delims=:" %%a in ("%~1") do (
  if /i "%%a"=="/user" set "SS_USER=%%b"
  if /i "%%a"=="/pass" set "SS_PASS=%%b"
)
shift
goto args
:run
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t = [IO.File]::ReadAllText($env:SS_SELF); $i = $t.IndexOf('#PS' + 'BEGIN'); & ([scriptblock]::Create($t.Substring($i)))"
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%

#PSBEGIN
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---- What this installs: one tested version of Suwayomi-Server, checked against the SHA-256 GitHub lists for that file ----
$Tag     = 'v2.4.2366'
$Asset   = "Suwayomi-Server-$Tag-windows-x64.zip"
$Sha256  = 'b955f374a8d94b8d1c2750ae28fa7eb2066b479957561b5ba9cf8ac993c8fc13'
$Size    = 343828201
$Url     = "https://github.com/Suwayomi/Suwayomi-Server/releases/download/$Tag/$Asset"
$ApiUrl  = "https://api.github.com/repos/Suwayomi/Suwayomi-Server/releases/tags/$Tag"

$Root    = if ($env:SS_ROOT) { $env:SS_ROOT } else { Join-Path $env:LOCALAPPDATA 'ScrollScape\Suwayomi' }
$App     = Join-Path $Root 'app'
$Data    = Join-Path $Root 'data'
$Zip     = Join-Path $Root 'download.zip'
$Conn    = Join-Path $Root 'connection.json'
$Port    = 4567
$User    = if ($env:SS_USER) { $env:SS_USER } else { 'scrollscape' }
$Secret  = [string]$env:SS_PASS
$RuleName = 'ScrollScape Suwayomi - no home network'
$Blocked = @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10')
$Shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'ScrollScape Suwayomi.lnk'

$mode = ([string]$env:SS_MODE).ToLower()
$LoginOk = '^[A-Za-z0-9._-]{1,100}$'
if ($User -notmatch $LoginOk) { throw 'The user can only have letters, digits and . _ - (at most 100).' }
if ($Secret -and $Secret -notmatch $LoginOk) { throw 'The password can only have letters, digits and . _ - (at most 100).' }
$yes = [bool]$env:SS_YES

function Say($text, $color = 'White') { Write-Host $text -ForegroundColor $color }
function Ask($question) {
    if ($yes) { return $true }
    $a = Read-Host "$question [y/N]"
    return ($a -match '^(y|yes|s|sim)$')
}
function Test-Admin {
    $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function New-Secret($length) {
    $chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    $bytes = New-Object byte[] $length
    $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
    $rng.GetBytes($bytes)
    $out = ''
    foreach ($b in $bytes) { $out += $chars[$b % $chars.Length] }
    return $out
}
function Write-Plain($path, $text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false))) }
function Stop-Suwayomi {
    Get-CimInstance Win32_Process -Filter "Name='javaw.exe' OR Name='java.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*Suwayomi-Server.jar*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
# The firewall needs administrator rights: the part that does it is a small script of its own that runs after a Windows prompt.
function Invoke-Rules($action, $programs) {
    $script = Join-Path $Root 'firewall-rules.ps1'
    $lines = @(
        "`$ErrorActionPreference = 'Stop'",
        "Get-NetFirewallRule -DisplayName '$RuleName' -ErrorAction SilentlyContinue | Remove-NetFirewallRule"
    )
    if ($action -eq 'add') {
        foreach ($p in $programs) {
            $lines += "New-NetFirewallRule -DisplayName '$RuleName' -Direction Outbound -Action Block -Program '$p' -RemoteAddress '$($Blocked -join "','")' -Profile Any | Out-Null"
        }
    }
    Write-Plain $script ($lines -join "`r`n")
    if (Test-Admin) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $script
        return ($LASTEXITCODE -eq 0)
    }
    $proc = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$script`"")
    return ($proc.ExitCode -eq 0)
}

Say ''
Say '=== ScrollScape: set up Suwayomi on this computer ===' Cyan

# ---------------------------------------------------------------- dry run: only ask GitHub, change nothing
if ($mode -eq 'dryrun') {
    Say "Checking $Asset with GitHub (nothing is downloaded or changed)..."
    $rel = Invoke-RestMethod -Uri $ApiUrl -Headers @{ 'User-Agent' = 'ScrollScape-setup' }
    $a = $rel.assets | Where-Object { $_.name -eq $Asset }
    if (-not $a) { throw "GitHub does not list $Asset for $Tag." }
    $digestOk = ($a.digest -eq "sha256:$Sha256")
    $sizeOk = ([int64]$a.size -eq $Size)
    Say ("  file     : {0}" -f $a.name)
    Say ("  size     : {0} bytes ({1}) {2}" -f $a.size, ('{0:N0} MB' -f ($a.size / 1MB)), $(if ($sizeOk) { '- as expected' } else { '- NOT what this script expects' }))
    Say ("  SHA-256  : {0} {1}" -f $a.digest, $(if ($digestOk) { '- as expected' } else { '- NOT what this script expects' }))
    Say ("  folder   : {0}" -f $Root)
    if (-not ($digestOk -and $sizeOk)) { Say 'The release does not match what this script was written for: do not install.' Red; exit 2 }
    Say 'All as expected. Run again without /dryrun to install.' Green
    exit 0
}

# ---------------------------------------------------------------- uninstall
if ($mode -eq 'uninstall') {
    Say "This stops Suwayomi and removes $Root, the firewall rules this script added, and the autostart."
    if (-not (Ask 'Remove everything?')) { Say 'Nothing was changed.'; exit 0 }
    Stop-Suwayomi
    if (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue) {
        Say 'Removing the firewall rules (Windows will ask for permission)...'
        if (-not (Invoke-Rules 'remove' @())) { Say 'The firewall rules were not removed (Windows Security > Firewall > Advanced: look for "ScrollScape Suwayomi").' Yellow }
    }
    if (Test-Path $Shortcut) { Remove-Item $Shortcut -Force }
    Start-Sleep -Seconds 2
    if (Test-Path $Root) { Remove-Item $Root -Recurse -Force }
    Say 'Done. Settings > Suwayomi in ScrollScape still holds the old address: clear the three boxes there if you like.' Green
    exit 0
}

# ---------------------------------------------------------------- install
$javaw = $null
$jar = $null
if (Test-Path $App) {
    $javaw = Get-ChildItem $App -Recurse -Filter javaw.exe -ErrorAction SilentlyContinue | Where-Object { $_.FullName -like '*\jre\bin\*' } | Select-Object -First 1
    $jar = Get-ChildItem $App -Recurse -Filter Suwayomi-Server.jar -ErrorAction SilentlyContinue | Select-Object -First 1
}
$already = ($javaw -and $jar -and (Test-Path (Join-Path $Data 'server.conf')) -and (Test-Path $Conn))

if ($already -and ($env:SS_USER -or $Secret)) {
    Say "Changing the login of the Suwayomi in $Root."
    $old = Get-Content $Conn -Raw | ConvertFrom-Json
    $newUser = if ($env:SS_USER) { $User } else { $old.username }
    $newPass = if ($Secret) { $Secret } else { $old.password }
    $confFile = Join-Path $Data 'server.conf'
    $text = [IO.File]::ReadAllText($confFile)
    $text = [regex]::Replace($text, '(?m)^server\.authUsername\s*=.*$', "server.authUsername = `"$newUser`"")
    $text = [regex]::Replace($text, '(?m)^server\.authPassword\s*=.*$', "server.authPassword = `"$newPass`"")
    Write-Plain $confFile $text
    Write-Plain $Conn (@{ url = $old.url; username = $newUser; password = $newPass } | ConvertTo-Json)
    Stop-Suwayomi
    Start-Sleep -Seconds 2
    Say 'Done: it starts again with the new login.' Green
} elseif ($already) {
    Say "Suwayomi is already set up in $Root. Starting it."
} else {
    Say 'This will:'
    Say ("  - download Suwayomi-Server {0} ({1:N0} MB) from github.com/Suwayomi/Suwayomi-Server and check its SHA-256" -f $Tag, ($Size / 1MB))
    Say "  - unpack it into $Root (about 1 GB; deleting that folder removes everything)"
    Say '  - make it listen only on this computer, with a login made for it'
    if (-not $env:SS_NOFIREWALL) { Say '  - add Windows Firewall rules so it cannot reach the other devices of your home network (Windows asks for permission once)' }
    if (-not $env:SS_NOAUTOSTART) { Say '  - start it with Windows (a shortcut in your Startup folder)' }
    Say ''
    Say 'Suwayomi runs extensions: programs written by third parties, which run on this computer with your Windows rights.' Yellow
    Say 'Install only extensions from repositories you trust. The firewall step limits what one of them could reach.' Yellow
    if (-not (Ask 'Continue?')) { Say 'Nothing was changed.'; exit 0 }

    $free = (Get-PSDrive -Name ($env:LOCALAPPDATA.Substring(0, 1))).Free
    if ($free -lt 1.5GB) { throw 'Less than 1.5 GB free on this drive.' }
    New-Item -ItemType Directory -Force -Path $Root | Out-Null

    Say 'Downloading (about 330 MB, a few minutes)...'
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Zip
    $hash = (Get-FileHash -Algorithm SHA256 -Path $Zip).Hash.ToLower()
    if ($hash -ne $Sha256) {
        Remove-Item $Zip -Force
        throw "The downloaded file does not match the expected SHA-256 ($hash). It was deleted; nothing was installed."
    }
    Say 'Checked: the file is the one GitHub lists.' Green

    Say 'Unpacking...'
    if (Test-Path $App) { Remove-Item $App -Recurse -Force }
    Expand-Archive -Path $Zip -DestinationPath $App -Force
    Remove-Item $Zip -Force
    $javaw = Get-ChildItem $App -Recurse -Filter javaw.exe | Where-Object { $_.FullName -like '*\jre\bin\*' } | Select-Object -First 1
    $jar = Get-ChildItem $App -Recurse -Filter Suwayomi-Server.jar | Select-Object -First 1
    if (-not $javaw -or -not $jar) { throw 'The package does not have the layout this script expects (jre\bin\javaw.exe and Suwayomi-Server.jar).' }

    $pass = if ($Secret) { $Secret } else { New-Secret 28 }
    New-Item -ItemType Directory -Force -Path $Data | Out-Null
    $conf = @(
        'server.ip = "127.0.0.1"',
        "server.port = $Port",
        'server.authMode = "basic_auth"',
        "server.authUsername = `"$User`"",
        "server.authPassword = `"$pass`"",
        'server.kcefEnabled = true',
        'server.systemTrayEnabled = false',
        'server.initialOpenInBrowserEnabled = false'
    ) -join "`r`n"
    Write-Plain (Join-Path $Data 'server.conf') $conf
    $json = (@{ url = "http://127.0.0.1:$Port"; username = $User; password = $pass } | ConvertTo-Json)
    Write-Plain $Conn $json
    & icacls $Conn /inheritance:r /grant:r "${env:USERNAME}:(R,W)" | Out-Null
    & icacls (Join-Path $Data 'server.conf') /inheritance:r /grant:r "${env:USERNAME}:(R,W)" | Out-Null

    $start = Join-Path $Root 'Start-Suwayomi.cmd'
    $startText = "@echo off`r`nstart `"`" /min `"$($javaw.FullName)`" --add-exports=java.desktop/sun.awt=ALL-UNNAMED `"-Dsuwayomi.tachidesk.config.server.rootDir=$Data`" -jar `"$($jar.FullName)`"`r`n"
    Write-Plain $start $startText

    if (-not $env:SS_NOFIREWALL) {
        Say 'Adding the firewall rules (Windows will ask for permission)...'
        $programs = @($javaw.FullName, (Join-Path $javaw.DirectoryName 'java.exe'))
        if (Invoke-Rules 'add' $programs) { Say 'The firewall rules are in place: Suwayomi can reach the internet but not your home network.' Green }
        else { Say 'The firewall rules were NOT added. Suwayomi works, but without that limit. Run this again to retry, or use /nofirewall to skip it.' Yellow }
    }
    if (-not $env:SS_NOAUTOSTART) {
        $sh = (New-Object -ComObject WScript.Shell).CreateShortcut($Shortcut)
        $sh.TargetPath = $start
        $sh.WorkingDirectory = $Root
        $sh.WindowStyle = 7
        $sh.Save()
        Say 'It will start with Windows.' Green
    }
}

# ---------------------------------------------------------------- start it and wait until it answers
$cfg = Get-Content $Conn -Raw | ConvertFrom-Json
$auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($cfg.username):$($cfg.password)"))
function Test-Up {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "$($cfg.url)/api/v1/source/list" -Headers @{ Authorization = "Basic $auth" } -TimeoutSec 5
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}
if (-not (Test-Up)) {
    Say 'Starting Suwayomi (the first start takes a minute or two)...'
    Start-Process -FilePath (Join-Path $Root 'Start-Suwayomi.cmd') -WindowStyle Hidden
    $up = $false
    for ($i = 0; $i -lt 90 -and -not $up; $i++) { Start-Sleep -Seconds 2; $up = Test-Up }
    if (-not $up) { Say "Suwayomi did not answer in 3 minutes. Its logs are in $Data\logs. Run this again to retry." Red; exit 1 }
}
Say 'Suwayomi is running.' Green
Say ''
Say 'Now open ScrollScape > Settings > Suwayomi: it connects by itself.' Cyan
Say '(If it does not, press "Connect to the Suwayomi on this computer" there.)'
Say ''
Say ("Suwayomi's own page: {0}   login: {1} / {2}   (also in {3})" -f $cfg.url, $cfg.username, $cfg.password, $Conn)
Say 'To change the login: run this file again with /user:NAME /pass:SECRET. To stop it: Task Manager > end javaw.exe. To remove it all: /uninstall.'
exit 0
