@echo off
REM ============================================================
REM TencentDB-Agent-Memory daily backup
REM Entry point for Windows Task Scheduler.
REM Real logic lives in backup-memory.sh
REM
REM NOTES:
REM  - this file MUST use CRLF line endings (cmd.exe misparses LF)
REM  - messages are ASCII-only so cmd.exe (ANSI codepage) never garbles them
REM  - MSYS_NO_PATHCONV stops Git Bash from rewriting "/c/Users/..." inside the
REM    bash argument into "C:\Users\...", which would break the "cd" in it
REM ============================================================
setlocal EnableExtensions

set "GITBASH=C:\Program Files\Git\bin\bash.exe"
set "REPO=C:\Users\qjl10\TencentDB-Agent-Memory\deploy\global-images"
set "DOCKER=C:\Program Files\Docker\Docker\resources\bin\docker.exe"
set "LOGDIR=%REPO%\backups"

set "MSYS_NO_PATHCONV=1"
set "MSYS2_ARG_CONV_EXCL=*"

if not exist "%LOGDIR%" mkdir "%LOGDIR%" 2>nul
REM --- trace marker: proves the task body actually executed ---
echo [%DATE% %TIME%] START task-runner cwd=%CD% >> "%LOGDIR%ackup.log"

if not exist "%GITBASH%" (
    echo [%DATE% %TIME%] ERROR: Git Bash not found at %GITBASH% >> "%LOGDIR%\backup.log"
    exit /b 2
)

REM --- preflight: docker daemon must be reachable ---
"%DOCKER%" version --format "{{.Server.Version}}" >nul 2>&1
if errorlevel 1 (
    echo [%DATE% %TIME%] ERROR: Docker daemon not reachable, backup skipped >> "%LOGDIR%\backup.log"
    exit /b 1
)

REM --- run backup, keep latest 7 snapshots ---
"%GITBASH%" -lc "cd '/c/Users/qjl10/TencentDB-Agent-Memory/deploy/global-images' && ./backup-memory.sh --keep 7 >> backups/backup.log 2>&1"
set RC=%ERRORLEVEL%

if %RC% NEQ 0 (
    echo [%DATE% %TIME%] ERROR: backup script exit code %RC% >> "%LOGDIR%\backup.log"
) else (
    echo [%DATE% %TIME%] OK: backup completed >> "%LOGDIR%\backup.log"
)

exit /b %RC%
