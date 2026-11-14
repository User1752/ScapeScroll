@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "BROWSER_OPENED="
goto :main

:banner
echo.
echo   +=======================================================+
echo   ^|                                                       ^|
echo   ^|    _____  _____                                       ^|
echo   ^|   / ____^|/ ____^|      ScrollScape                     ^|
echo   ^|  ^| (___ ^| (___        Windows Launcher                ^|
echo   ^|   \___ \ \___ \                                       ^|
echo   ^|   ____^) ^|____^) ^|      Current server.js flow          ^|
echo   ^|  ^|_____/^|_____/       Foreground logs ^& easy debug    ^|
echo   ^|                                                       ^|
echo   +=======================================================+
echo.
goto :eof

:err
echo   +-------------------------------------------------------+
echo   ^|    [ ERR ]  %~1
if not "%~2"=="" echo   ^|              %~2
echo   +-------------------------------------------------------+
echo.
goto :eof

:main
title ScrollScape Launcher
cls

set "ROOT=%~dp0"
cd /d "%ROOT%"
set "PORT=4000"
set "KILLED="

call :banner

REM ── Apply a staged Node.js runtime update, if one is pending ────────────────
REM The in-app "Update" button (System Health > Dependency & Tool Updates) can
REM only download, checksum-verify, and extract a new build into
REM tools\node-staged - it can never safely swap it into tools\node itself from
REM inside a running server, because that means renaming a folder while
REM node.exe inside it is the very process handling that request (confirmed
REM live: Windows refuses that rename outright, "Access to the path ... is
REM denied"). A detached background helper that waits for the server to exit
REM was tried and abandoned - confirmed live, a genuinely detached child
REM process doesn't survive/run reliably in every hosting environment this
REM project runs under, and silently dropping a promised update with no error
REM anywhere is worse than not automating it. This is the one guaranteed-safe
REM moment instead: nothing has touched tools\node\node.exe yet this launch,
REM so the rename can happen synchronously, right here, no waiting needed.
if exist "%ROOT%tools\node-staged\node.exe" (
    echo   [ .. ]  Applying staged Node.js runtime update...
    if exist "%ROOT%tools\node-previous" rmdir /s /q "%ROOT%tools\node-previous"
    if exist "%ROOT%tools\node" ren "%ROOT%tools\node" node-previous
    ren "%ROOT%tools\node-staged" node
    echo   [ OK ]  Node.js runtime updated.
)

echo   [ .. ]  Scanning for Node.js runtime environment...
set "NODE_EXE="
if exist "%ROOT%tools\node\node.exe" (
    set "NODE_EXE=%ROOT%tools\node\node.exe"
) else (
    where node >nul 2>&1
    if not errorlevel 1 set "NODE_EXE=node"
)

REM ── Local staging for portable tools ──────────────────────────────────────
REM Windows shows an interactive "Open File - Security Warning" for every
REM Start-Process launch of an unsigned exe sitting on a network drive/share
REM (confirmed live: happens for both node.exe and flaresolverr.exe here,
REM even after Unblock-File - likely because the network filesystem behind
REM this drive doesn't support the NTFS Alternate Data Stream Windows uses
REM to remember "this file is trusted", so it can never persist that and
REM keeps asking forever). Since the project itself needs to stay on this
REM drive, the fix is to run the interpreter binary from a real local disk
REM instead - node.exe doesn't care where ITS OWN exe lives vs. the working
REM directory / server.js it's told to run, so this is functionally
REM identical to running it straight off the network drive, just without
REM the popup. ~86MB copy; every later launch reuses the cached copy as-is
REM unless the project's own tools\node was upgraded since (version-checked
REM below), in which case it re-syncs once more.
set "LOCAL_TOOLS=%LocalAppData%\ScrollScape\tools"
if /i "!NODE_EXE!"=="!ROOT!tools\node\node.exe" (
    set "LOCAL_NODE_EXE=!LOCAL_TOOLS!\node\node.exe"
    set "NEED_STAGE_NODE="
    if not exist "!LOCAL_NODE_EXE!" (
        set "NEED_STAGE_NODE=1"
    ) else (
        REM A cache that exists is not necessarily a cache that's current -
        REM confirmed live, this silently kept running v20.20.1 for weeks
        REM after the project's own tools\node was upgraded to v24.20.0,
        REM with zero error or warning anywhere pointing at it. Comparing
        REM `node --version` between the source and the cached copy costs
        REM one extra process spawn per launch (cheap) and catches this.
        for /f "delims=" %%V in ('"!ROOT!tools\node\node.exe" --version 2^>^&1') do set "SRC_NODE_VER=%%V"
        for /f "delims=" %%V in ('"!LOCAL_NODE_EXE!" --version 2^>^&1') do set "CACHED_NODE_VER=%%V"
        if not "!SRC_NODE_VER!"=="!CACHED_NODE_VER!" set "NEED_STAGE_NODE=1"
    )
    if defined NEED_STAGE_NODE (
        echo   [ .. ]  Staging portable Node.js to local disk - avoids a Windows security prompt on network drives...
        robocopy "!ROOT!tools\node" "!LOCAL_TOOLS!\node" /MIR /NFL /NDL /NJH /NJS >nul
        powershell -NoProfile -Command "Get-ChildItem -Path '!LOCAL_TOOLS!\node' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >nul 2>&1
    )
    if exist "!LOCAL_NODE_EXE!" set "NODE_EXE=!LOCAL_NODE_EXE!"
)

if not defined NODE_EXE (
    echo.
    call :err "Node.js was not found" "Expected tools\node\node.exe or a system node in PATH."
    pause
    exit /b 1
)

for /f "delims=" %%V in ('"%NODE_EXE%" --version 2^>^&1') do set "NODE_VER=%%V"
echo   [ OK ]  Using Node.js !NODE_VER!
echo   [ .. ]  Clearing stale node listener on port !PORT! if present...
for /f %%P in ('powershell -NoProfile -Command "try { $c = Get-NetTCPConnection -LocalPort !PORT! -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){ $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.OwningProcess); if([string]$p.Name -ieq 'node.exe'){ Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Output 1 } } } catch {}"') do set "KILLED=%%P"
if "!KILLED!"=="1" (
    echo   [ OK ]  Removed stale node process on port !PORT!.
) else (
    echo   [ OK ]  Port !PORT! was already free.
)

if not exist "%ROOT%node_modules\" (
    echo.
    echo   [ .. ]  First run detected! Installing dependencies...
    call npm install
    if errorlevel 1 (
        call :err "Failed to install dependencies" "Make sure npm is installed and in PATH."
        pause
        exit /b 1
    )
    echo   [ OK ]  Dependencies installed.
)

set "SCROLLSCAPE_LAUNCHER=1"
set "NODE_PID="

echo   [ .. ]  Starting server daemon...

set "FLARESOLVERR_EXE=%ROOT%tools\flaresolverr\flaresolverr.exe"
set "FS_PID="

REM ── Is FlareSolverr wanted at all? ──────────────────────────────────────────
REM FlareSolverr is a third-party browser-automation tool of about 700MB. It is
REM never downloaded without a yes, and never started after a no. The order of
REM the decision is the one the server itself uses, see
REM server\modules\network\flaresolverr-lifecycle.js:
REM   1. FLARESOLVERR_DISABLED set to anything but 0, false, no, off or n: never.
REM   2. FLARESOLVERR_AUTO_INSTALL set to 1, true, yes, on or y: yes, no question.
REM   3. data\setup.json, written by the app's own first-run question or by this
REM      launcher: "skip" means no. A file that exists but cannot be read means
REM      no as well, until it is fixed or deleted, because nobody has answered.
REM   4. Already installed: keep using it, exactly as before.
REM   5. Otherwise ask once. Sim saves "install", Nao saves "skip", and Mais
REM      tarde saves nothing and carries on without it, asked again next launch.
REM install_flaresolverr.js reads and writes data\setup.json through the module
REM the server uses, so the launcher and the server always agree on the file.
REM FLARESOLVERR_EXE_PATH is cleared here and set again only for a copy that is
REM wanted and present: the server reads that variable as "the launcher owns the
REM install" and then ignores a saved "skip", so it must never be left over.
set "FLARESOLVERR_EXE_PATH="
set "FS_WANTED=1"
set "FS_CONSENT="
set "FS_WHY="
set "FS_CHOICE=invalid"
if defined FLARESOLVERR_DISABLED (
    set "FS_WANTED="
    set "FS_WHY=FLARESOLVERR_DISABLED is set. Unset that variable to turn it on."
    for %%F in (0 false no off n) do if /i "!FLARESOLVERR_DISABLED!"=="%%F" (
        set "FS_WANTED=1"
        set "FS_WHY="
    )
)
if defined FS_WANTED (
    for %%F in (1 true yes on y) do if /i "!FLARESOLVERR_AUTO_INSTALL!"=="%%F" set "FS_CONSENT=1"
    if not defined FS_CONSENT (
        REM Prints one word: install, skip, none or invalid. Nothing printed at
        REM all means the helper failed, which is read as invalid: stay off.
        REM The script is named relative to this folder, which the cd /d at the
        REM top already made the current one: cmd drops the quotes of a for /f
        REM command that has two quoted parts, and this folder has spaces in it.
        for /f "delims=" %%C in ('"!NODE_EXE!" install_flaresolverr.js --choice') do set "FS_CHOICE=%%C"
        if "!FS_CHOICE!"=="install" set "FS_CONSENT=1"
        if "!FS_CHOICE!"=="skip" (
            set "FS_WANTED="
            set "FS_WHY=you answered no earlier. Delete data\setup.json to be asked again."
        )
        if "!FS_CHOICE!"=="invalid" (
            set "FS_WANTED="
            set "FS_WHY=data\setup.json could not be read. Fix or delete it to be asked again."
        )
    )
)

if defined FS_WANTED if not defined FS_CONSENT if not exist "!FLARESOLVERR_EXE!" (
    echo.
    echo   [ ?? ]  FlareSolverr is not installed. It is optional: a third-party tool from
    echo           github.com/FlareSolverr/FlareSolverr, about 700MB, that opens sources
    echo           protected by Cloudflare. It only listens on this computer.
    echo           Without it those sources stay unavailable.
    echo           Ferramenta opcional de terceiros, cerca de 700MB, para fontes protegidas
    echo           pela Cloudflare. Sem ela essas fontes ficam indisponiveis.
    echo           It would be installed in !ROOT!tools\flaresolverr
    REM No answer within a minute counts as Mais tarde, so an unattended launch
    REM never waits forever and never downloads.
    choice /c SNM /n /t 60 /d M /m "          Install it? / Instalar?  [S]im / [N]ao / [M]ais tarde: "
    set "FS_ANSWER=!errorlevel!"
    if "!FS_ANSWER!"=="1" (
        "!NODE_EXE!" "!ROOT!install_flaresolverr.js" --save install
        set "FS_CONSENT=1"
    ) else if "!FS_ANSWER!"=="2" (
        "!NODE_EXE!" "!ROOT!install_flaresolverr.js" --save skip
        set "FS_WANTED="
        set "FS_WHY=you answered no. Delete data\setup.json to be asked again."
    ) else (
        set "FS_WANTED="
        set "FS_WHY=not now. You will be asked again next launch."
    )
)

REM Only ever reached with a yes: FS_CONSENT is set by the environment, by a
REM saved "install", or by the answer just given.
if defined FS_WANTED if defined FS_CONSENT if not exist "!FLARESOLVERR_EXE!" (
    echo.
    echo   [ .. ]  Downloading portable FlareSolverr, as you agreed. This can take a few minutes...
    "!NODE_EXE!" "!ROOT!install_flaresolverr.js"
    if not exist "!FLARESOLVERR_EXE!" (
        set "FS_WANTED="
        REM The server would see a saved yes with nothing installed and start its own
        REM 700MB download in this same launch. Switch it off for this run only - the
        REM saved answer stays, so the next launch tries again.
        set "FLARESOLVERR_DISABLED=1"
        set "FS_WHY=the download did not finish. It will be tried again next launch."
        call :err "FlareSolverr could not be downloaded" "Cloudflare-protected sources stay unavailable until it is installed."
    )
)
if not defined FS_WANTED echo   [ .. ]  FlareSolverr is off: !FS_WHY!

REM Same network-drive issue as node.exe above, same fix: stage the whole
REM flaresolverr folder - it needs its bundled _internal resources sitting
REM right next to the exe, not just the exe alone - onto local disk once,
REM then always launch from there. This one's ~700MB, so the one-time copy
REM takes noticeably longer than node's - only happens when the local cache
REM doesn't exist yet.
set "LOCAL_FS_EXE=!LOCAL_TOOLS!\flaresolverr\flaresolverr.exe"
if defined FS_WANTED if exist "!FLARESOLVERR_EXE!" (
    if not exist "!LOCAL_FS_EXE!" (
        echo   [ .. ]  Staging portable FlareSolverr to local disk - avoids a Windows security prompt on network drives, one-time - about 700MB, may take a while...
        robocopy "!ROOT!tools\flaresolverr" "!LOCAL_TOOLS!\flaresolverr" /E /NFL /NDL /NJH /NJS >nul
        powershell -NoProfile -Command "Get-ChildItem -Path '!LOCAL_TOOLS!\flaresolverr' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >nul 2>&1
    )
)
if defined FS_WANTED if exist "!LOCAL_FS_EXE!" set "FLARESOLVERR_EXE=!LOCAL_FS_EXE!"

if defined FS_WANTED if exist "!FLARESOLVERR_EXE!" (
    REM Handed to the server through the environment, which cmd, PowerShell and
    REM Start-Process all pass on: it lets the server's own idle watcher find and
    REM relaunch FlareSolverr exactly as it was started here, and it is only set
    REM for a copy that exists and is wanted.
    set "FLARESOLVERR_EXE_PATH=!FLARESOLVERR_EXE!"
    REM Windows tags any freshly-downloaded/extracted exe with the
    REM "Mark of the Web" (a hidden Zone.Identifier stream) and SmartScreen
    REM then blocks Start-Process behind an interactive "Open File - Security
    REM Warning" dialog - with no one there to click it, the process never
    REM actually starts and wait_port below just times out. Unblock-File
    REM strips that marker before every launch; it's a no-op once the file
    REM is already unblocked, so this is safe to run unconditionally.
    powershell -NoProfile -Command "Unblock-File -Path '!FLARESOLVERR_EXE!' -ErrorAction SilentlyContinue" >nul 2>&1
    echo   [ .. ]  Starting portable FlareSolverr proxy...
    REM BelowNormal so Windows always favors other apps (a game, etc.) over
    REM FlareSolverr when both want CPU at the same time - it still gets
    REM full CPU whenever nothing else needs it, this only affects who wins
    REM contention. Chrome processes FlareSolverr spawns per-solve inherit
    REM this from their parent by default on Windows, so the (much larger)
    REM burst those create should be deprioritized too, not just the
    REM lightweight wrapper process itself.
    powershell -NoProfile -Command "$env:PORT='8191'; $env:HOST='127.0.0.1'; $env:PROMETHEUS_ENABLED='false'; $p=Start-Process -FilePath '!FLARESOLVERR_EXE!' -WindowStyle Hidden -PassThru; try { $p.PriorityClass = 'BelowNormal' } catch {}; $p.Id | Out-File ($env:TEMP + '\fs_pid.txt') -Encoding ASCII" >nul 2>&1
    if exist "%TEMP%\fs_pid.txt" (
        set /p FS_PID=<"%TEMP%\fs_pid.txt"
        del "%TEMP%\fs_pid.txt" >nul 2>&1
    )
    REM Start-Process only confirms the exe launched, not that FlareSolverr
    REM actually came up listening on 8191 (it can exit right after launch
    REM on a bad install, a port conflict, etc.) - wait_port is the same
    REM check already used for the main server's port, reused here so a
    REM silent FlareSolverr failure doesn't look identical to success.
    call :wait_port 8191
    if errorlevel 1 (
        echo.
        call :err "FlareSolverr did not come up on port 8191" "Cloudflare-protected sources such as BatCave will fail until it's running - try running tools\flaresolverr\flaresolverr.exe directly to see why."
    ) else (
        echo   [ OK ]  FlareSolverr is listening on port 8191.
    )
)

call :start_node
if not defined NODE_PID (
    call :err "Failed to start server" "Could not launch server.js in background."
    pause
    exit /b 1
)

call :wait_port !PORT!

echo.
echo   +-------------------------------------------------------+
echo   ^|    [ OK ]  Ready to launch ScrollScape                 ^|
echo   ^|                                                       ^|
echo   ^|       http://localhost:!PORT!                          ^|
echo   +-------------------------------------------------------+

REM Inlined rather than "call"ed to a separate :open_app_window label — this
REM is the one spot where the same cmd.exe label-lookup flakiness documented
REM at :node_restart below ("cannot find the batch label specified") was
REM actually observed in practice, right here, on an otherwise completely
REM ordinary first run. Inlining removes the only "call" in the critical
REM startup path that isn't already covered by that documented workaround.
if not defined BROWSER_OPENED (
    echo   [ .. ]  Opening ScrollScape window...
    set "APP_BROWSER="
    if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe"        set "APP_BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    if not defined APP_BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "APP_BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    if not defined APP_BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe"       set "APP_BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
    if not defined APP_BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "APP_BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    if not defined APP_BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"      set "APP_BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

    if defined APP_BROWSER (
        start "" "!APP_BROWSER!" --app=http://localhost:!PORT! --window-size=1280,832
        echo   [ OK ]  Opened in app window.
    ) else (
        start "" "http://localhost:!PORT!"
        echo   [ OK ]  No Chrome/Edge found - opened in your default browser instead.
    )
    set "BROWSER_OPENED=1"
)

REM Try to hand this same window over to the terminal dashboard right away —
REM it's a nicer default than sitting on the bare R/Q menu doing nothing. If
REM Python (or its two deps) aren't available, this falls straight through
REM to the normal menu instead, with a one-line explanation why.
echo.
set "DASHBOARD_READY="
call :detect_python
if defined PY_CMD (
    call :ensure_dashboard_deps
    if defined DEPS_OK set "DASHBOARD_READY=1"
)
if defined DASHBOARD_READY (
    echo   [ .. ]  Switching this window to the terminal dashboard - press Q inside it to come back here, R inside it to restart everything...
    echo.
    "!PY_CMD!" "%ROOT%tools\dashboard\dashboard.py" --url http://localhost:!PORT!
    REM Exit code 42 is the dashboard's own signal for "the user pressed r,
    REM please restart everything" - it never touches the Node process
    REM itself, that's this script's job via the existing :node_restart flow.
    if errorlevel 42 goto :node_restart
) else (
    echo   [ .. ]  Terminal dashboard unavailable right now - showing the normal menu instead.
)

goto :node_menu

:node_menu
echo.
echo   +-------------------------------------------------------+
echo   ^|   D  Open Dashboard (terminal monitor)                ^|
echo   ^|   R  Restart ^& refresh                                ^|
echo   ^|   Q  Quit                                             ^|
echo   +-------------------------------------------------------+
powershell -NoProfile -Command "while($true){$k=[Console]::ReadKey($true).KeyChar.ToString().ToUpper(); if($k -eq 'D'){exit 3}; if($k -eq 'R'){exit 1}; if($k -eq 'Q'){exit 2}}"
if errorlevel 3 goto :node_dashboard
if errorlevel 2 goto :node_quit
if errorlevel 1 goto :node_restart
goto :node_menu

:node_dashboard
call :detect_python
if not defined PY_CMD (
    echo.
    call :err "Python was not found" "Install Python from python.org to use the terminal dashboard, then try D again."
    goto :node_menu
)
call :ensure_dashboard_deps
if not defined DEPS_OK (
    echo.
    call :err "Failed to install dashboard dependencies" "Try it yourself: pip install -r tools\dashboard\requirements.txt"
    goto :node_menu
)
echo   [ .. ]  Switching this window to the terminal dashboard - press Q inside it to come back here, R inside it to restart everything...
echo.
"!PY_CMD!" "%ROOT%tools\dashboard\dashboard.py" --url http://localhost:!PORT!
if errorlevel 42 goto :node_restart
goto :node_menu

:detect_python
set "PY_CMD="
where py >nul 2>&1
if not errorlevel 1 set "PY_CMD=py"
if not defined PY_CMD (
    where python >nul 2>&1
    if not errorlevel 1 set "PY_CMD=python"
)
goto :eof

:ensure_dashboard_deps
set "DEPS_OK=1"
"!PY_CMD!" -c "import textual, httpx" >nul 2>&1
if errorlevel 1 (
    echo   [ .. ]  Installing dashboard dependencies - textual, httpx...
    "!PY_CMD!" -m pip install --quiet -r "%ROOT%tools\dashboard\requirements.txt"
    if errorlevel 1 (
        set "DEPS_OK="
    ) else (
        echo   [ OK ]  Dashboard dependencies installed.
    )
)
goto :eof

:node_restart
echo   [ .. ]  Restarting server...
REM Neither browser-open path above (Chrome/Edge --app= window, or the
REM default-browser fallback) ever captures a PID for what it opens - a
REM stored PID wouldn't be reliable for Chrome/Edge anyway, since --app=
REM windows commonly hand off to an already-running browser instance via
REM IPC and the just-launched process exits right after, well before this
REM label could ever run. Matching on MainWindowTitle instead sidesteps
REM that entirely: both the app window and a plain browser tab set the OS
REM window title to the page's own <title> ("ScrollScape - Manga Web
REM Reader"), so this finds and closes the stale window regardless of
REM which path opened it or which process ended up owning it.
echo   [ .. ]  Closing previous ScrollScape window...
powershell -NoProfile -Command "Get-Process chrome,msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*ScrollScape*' } | ForEach-Object { $_.CloseMainWindow() | Out-Null }" >nul 2>&1
taskkill /pid !NODE_PID! /f >nul 2>&1
if defined FS_PID taskkill /pid !FS_PID! /f >nul 2>&1
call :cleanup_port
REM "goto :main" is what used to be here to loop back — cmd.exe can lose
REM track of a label after enough nested "call"s to powershell.exe further
REM down in a long-running session (a known cmd.exe flakiness, not specific
REM to this script) and fail with "cannot find the batch label specified".
REM Re-launching this same file as a brand new process sidesteps that
REM entirely: it re-reads the file fresh from disk instead of seeking back
REM into the current one. This also means restart always reopens the app
REM window, which is a reasonable default (fixes the case of the window
REM having been closed by accident) — the initial launch still only opens
REM one window per run either way.
call "%~f0"
exit /b 0

:node_quit
echo.
echo   [ .. ]  Stopping ScrollScape...
taskkill /pid !NODE_PID! /f >nul 2>&1
if defined FS_PID taskkill /pid !FS_PID! /f >nul 2>&1
exit /b 0

:cleanup_port
for /f %%P in ('powershell -NoProfile -Command "try { $c = Get-NetTCPConnection -LocalPort !PORT! -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){ $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.OwningProcess); if([string]$p.Name -ieq 'node.exe'){ Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue } } } catch {}"') do rem
goto :eof

:start_node
set "NODE_PID="
REM Same Start-Process-triggers-a-security-dialog issue as FlareSolverr
REM above, just for the portable node.exe this time - same fix. Harmless
REM no-op if NODE_EXE resolved to a bare "node" from PATH instead of a real
REM file path (Unblock-File just fails silently on that, which is fine).
powershell -NoProfile -Command "Unblock-File -Path '!NODE_EXE!' -ErrorAction SilentlyContinue" >nul 2>&1
REM Same BelowNormal reasoning as FlareSolverr above - the server is mostly
REM I/O-bound (waiting on network/disk, not CPU), so this costs it little in
REM practice while making sure a real CPU spike here (e.g. parsing a large
REM scraped page, rewriting the store) never wins a scheduling fight against
REM whatever the user is actively doing in the foreground.
REM FLARESOLVERR_EXE_PATH lets the server's own idle watcher
REM (server/modules/network/flaresolverr-lifecycle.js) find and relaunch
REM FlareSolverr identically to how it was started above, once it's sat
REM unused for a while - reclaims the resident Chrome pool without
REM requiring this launcher script to stay involved after startup.
REM It is not written into the command below any more: the variable is set
REM in this script's own environment, and only when there is a FlareSolverr
REM that is wanted and present, so node inherits it or does not see it at
REM all. Passing it unconditionally made a missing or declined copy look
REM like an install the launcher owns, which switched the saved "skip" off.
powershell -NoProfile -Command "$env:PORT='!PORT!'; $p=Start-Process -FilePath '!NODE_EXE!' -ArgumentList 'server.js' -WorkingDirectory '!ROOT!' -WindowStyle Hidden -PassThru; try { $p.PriorityClass = 'BelowNormal' } catch {}; $p.Id | Out-File ($env:TEMP + '\ss_pid.txt') -Encoding ASCII" >nul 2>&1
if exist "%TEMP%\ss_pid.txt" (
    set /p NODE_PID=<"%TEMP%\ss_pid.txt"
    del "%TEMP%\ss_pid.txt" >nul 2>&1
)
goto :eof

:wait_port
powershell -NoProfile -Command "$port=%~1; for($i=0; $i -lt 20; $i++){ try{ $t=New-Object Net.Sockets.TcpClient('127.0.0.1', $port); $t.Close(); exit 0 }catch{ Start-Sleep -Seconds 1 } }; exit 1" >nul 2>&1
goto :eof
