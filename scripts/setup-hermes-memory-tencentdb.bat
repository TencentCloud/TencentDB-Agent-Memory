@echo off
setlocal EnableExtensions

set "SCRIPT_PATH=%~f0"
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "REPO_ROOT=%%~fI"

if /I "%~1"=="--gateway-only" goto gateway_only

echo [memory-tencentdb] Hermes Windows native setup
echo [memory-tencentdb] Repo: %REPO_ROOT%

if "%USERPROFILE%"=="" (
  echo [ERROR] USERPROFILE is not set.
  exit /b 1
)

call :require_command node "Node.js"
if errorlevel 1 exit /b 1
call :require_command npm "npm"
if errorlevel 1 exit /b 1
call :check_python
if errorlevel 1 exit /b 1
call :check_hermes

for /f "delims=" %%V in ('node -p "process.versions.node" 2^>nul') do set "NODE_VERSION=%%V"
node -e "const [M,m,p]=process.versions.node.split('.').map(Number); process.exit(M>22 || (M===22 && (m>16 || (m===16 && p>=0))) ? 0 : 1)"
if errorlevel 1 (
  echo [ERROR] Node.js 22.16.0 or newer is required. Current: %NODE_VERSION%
  exit /b 1
)
echo [memory-tencentdb] Node.js %NODE_VERSION%

if not exist "%REPO_ROOT%\package.json" (
  echo [ERROR] package.json not found under %REPO_ROOT%
  echo [ERROR] Run this script from the memory-tencentdb package.
  exit /b 1
)

if "%HERMES_HOME%"=="" set "HERMES_HOME=%USERPROFILE%\.hermes"
if "%MEMORY_TENCENTDB_ROOT%"=="" set "MEMORY_TENCENTDB_ROOT=%USERPROFILE%\.memory-tencentdb"
if "%TDAI_DATA_DIR%"=="" set "TDAI_DATA_DIR=%MEMORY_TENCENTDB_ROOT%\memory-tdai"
if "%MEMORY_TENCENTDB_GATEWAY_HOST%"=="" set "MEMORY_TENCENTDB_GATEWAY_HOST=127.0.0.1"
if "%MEMORY_TENCENTDB_GATEWAY_PORT%"=="" set "MEMORY_TENCENTDB_GATEWAY_PORT=8420"
if "%TDAI_GATEWAY_HOST%"=="" set "TDAI_GATEWAY_HOST=%MEMORY_TENCENTDB_GATEWAY_HOST%"
if "%TDAI_GATEWAY_PORT%"=="" set "TDAI_GATEWAY_PORT=%MEMORY_TENCENTDB_GATEWAY_PORT%"

if "%TDAI_LLM_API_KEY%"=="" if not "%MEMORY_TENCENTDB_LLM_API_KEY%"=="" set "TDAI_LLM_API_KEY=%MEMORY_TENCENTDB_LLM_API_KEY%"
if "%TDAI_LLM_BASE_URL%"=="" if not "%MEMORY_TENCENTDB_LLM_BASE_URL%"=="" set "TDAI_LLM_BASE_URL=%MEMORY_TENCENTDB_LLM_BASE_URL%"
if "%TDAI_LLM_MODEL%"=="" if not "%MEMORY_TENCENTDB_LLM_MODEL%"=="" set "TDAI_LLM_MODEL=%MEMORY_TENCENTDB_LLM_MODEL%"
if "%TDAI_LLM_BASE_URL%"=="" set "TDAI_LLM_BASE_URL=https://api.openai.com/v1"
if "%TDAI_LLM_MODEL%"=="" set "TDAI_LLM_MODEL=gpt-4o"

if "%MEMORY_TENCENTDB_LLM_API_KEY%"=="" if not "%TDAI_LLM_API_KEY%"=="" set "MEMORY_TENCENTDB_LLM_API_KEY=%TDAI_LLM_API_KEY%"
if "%MEMORY_TENCENTDB_LLM_BASE_URL%"=="" set "MEMORY_TENCENTDB_LLM_BASE_URL=%TDAI_LLM_BASE_URL%"
if "%MEMORY_TENCENTDB_LLM_MODEL%"=="" set "MEMORY_TENCENTDB_LLM_MODEL=%TDAI_LLM_MODEL%"

set "MEMORY_TENCENTDB_GATEWAY_CMD=cmd /d /s /c ""%SCRIPT_PATH%"" --gateway-only"
set "HERMES_CONFIG=%HERMES_HOME%\config.yaml"
set "HERMES_ENV=%HERMES_HOME%\.env"
set "HERMES_LOG_DIR=%HERMES_HOME%\logs\memory_tencentdb"

mkdir "%HERMES_HOME%" 2>nul
mkdir "%HERMES_HOME%\plugins" 2>nul
mkdir "%HERMES_LOG_DIR%" 2>nul
mkdir "%MEMORY_TENCENTDB_ROOT%" 2>nul
mkdir "%TDAI_DATA_DIR%" 2>nul

pushd "%REPO_ROOT%" >nul
call npm ls --omit=dev --depth=0 >nul 2>nul
set "NPM_LS_RC=%ERRORLEVEL%"
if not "%NPM_LS_RC%"=="0" (
  echo [memory-tencentdb] Gateway dependencies missing or incomplete; running npm install --omit=dev
  call npm install --omit=dev
  set "NPM_RC=%ERRORLEVEL%"
  popd >nul
  if not "%NPM_RC%"=="0" (
    echo [ERROR] npm install failed with exit code %NPM_RC%.
    exit /b %NPM_RC%
  )
) else (
  popd >nul
  echo [memory-tencentdb] Gateway dependencies already installed
)

set "PLUGIN_SRC=%REPO_ROOT%\hermes-plugin\memory\memory_tencentdb"
set "PLUGIN_DST=%HERMES_HOME%\plugins\memory_tencentdb"
if not exist "%PLUGIN_SRC%\plugin.yaml" (
  echo [ERROR] Hermes provider source not found: %PLUGIN_SRC%
  exit /b 1
)

echo [memory-tencentdb] Copying Hermes provider to %PLUGIN_DST%
if exist "%PLUGIN_DST%" rmdir /s /q "%PLUGIN_DST%"
xcopy "%PLUGIN_SRC%" "%PLUGIN_DST%\" /E /I /Y >nul
if errorlevel 2 (
  echo [ERROR] Failed to copy Hermes provider to %PLUGIN_DST%
  exit /b 1
)

call :write_env
if errorlevel 1 (
  echo [WARN] Failed to update %HERMES_ENV%; current process env is still set.
) else (
  echo [memory-tencentdb] Environment written to %HERMES_ENV%
)

if not exist "%HERMES_CONFIG%" (
  > "%HERMES_CONFIG%" echo memory:
  >> "%HERMES_CONFIG%" echo   provider: memory_tencentdb
  echo [memory-tencentdb] Created %HERMES_CONFIG% with memory.provider=memory_tencentdb
) else (
  findstr /R /C:"^[ ][ ]*provider:[ ][ ]*memory_tencentdb" /C:"^provider:[ ][ ]*memory_tencentdb" "%HERMES_CONFIG%" >nul
  if errorlevel 1 (
    echo [memory-tencentdb] Please ensure %HERMES_CONFIG% contains:
    echo     memory:
    echo       provider: memory_tencentdb
  ) else (
    echo [memory-tencentdb] Hermes config already references memory_tencentdb
  )
)

call :health_check
if not errorlevel 1 (
  echo [memory-tencentdb] Gateway already healthy at http://%MEMORY_TENCENTDB_GATEWAY_HOST%:%MEMORY_TENCENTDB_GATEWAY_PORT%/health
  goto done
)

echo [memory-tencentdb] Starting Gateway in background
start "memory-tencentdb Gateway" /B cmd /d /s /c call "%SCRIPT_PATH%" --gateway-only 1>> "%HERMES_LOG_DIR%\gateway.stdout.log" 2>> "%HERMES_LOG_DIR%\gateway.stderr.log"

for /L %%I in (1,1,30) do (
  call :health_check
  if not errorlevel 1 goto healthy
  timeout /t 1 /nobreak >nul
)

echo [ERROR] Gateway did not become healthy within 30 seconds.
echo [ERROR] Check logs:
echo         %HERMES_LOG_DIR%\gateway.stdout.log
echo         %HERMES_LOG_DIR%\gateway.stderr.log
exit /b 1

:healthy
echo [memory-tencentdb] Gateway healthy at http://%MEMORY_TENCENTDB_GATEWAY_HOST%:%MEMORY_TENCENTDB_GATEWAY_PORT%/health

:done
echo.
echo [memory-tencentdb] Done.
echo   Data dir:       %TDAI_DATA_DIR%
echo   Hermes plugin:  %PLUGIN_DST%
echo   Hermes config:  %HERMES_CONFIG%
echo   Gateway logs:   %HERMES_LOG_DIR%
if "%TDAI_LLM_API_KEY%"=="" (
  echo.
  echo [WARN] TDAI_LLM_API_KEY is not set. L1/L2/L3 extraction needs an OpenAI-compatible API key.
  echo        Set it in this shell or in %HERMES_ENV%, then rerun this script.
)
exit /b 0

:gateway_only
if "%USERPROFILE%"=="" exit /b 1
if "%HERMES_HOME%"=="" set "HERMES_HOME=%USERPROFILE%\.hermes"
if "%MEMORY_TENCENTDB_ROOT%"=="" set "MEMORY_TENCENTDB_ROOT=%USERPROFILE%\.memory-tencentdb"
if "%TDAI_DATA_DIR%"=="" set "TDAI_DATA_DIR=%MEMORY_TENCENTDB_ROOT%\memory-tdai"
if "%MEMORY_TENCENTDB_GATEWAY_HOST%"=="" set "MEMORY_TENCENTDB_GATEWAY_HOST=127.0.0.1"
if "%MEMORY_TENCENTDB_GATEWAY_PORT%"=="" set "MEMORY_TENCENTDB_GATEWAY_PORT=8420"
if "%TDAI_GATEWAY_HOST%"=="" set "TDAI_GATEWAY_HOST=%MEMORY_TENCENTDB_GATEWAY_HOST%"
if "%TDAI_GATEWAY_PORT%"=="" set "TDAI_GATEWAY_PORT=%MEMORY_TENCENTDB_GATEWAY_PORT%"
if "%TDAI_LLM_API_KEY%"=="" if not "%MEMORY_TENCENTDB_LLM_API_KEY%"=="" set "TDAI_LLM_API_KEY=%MEMORY_TENCENTDB_LLM_API_KEY%"
if "%TDAI_LLM_BASE_URL%"=="" if not "%MEMORY_TENCENTDB_LLM_BASE_URL%"=="" set "TDAI_LLM_BASE_URL=%MEMORY_TENCENTDB_LLM_BASE_URL%"
if "%TDAI_LLM_MODEL%"=="" if not "%MEMORY_TENCENTDB_LLM_MODEL%"=="" set "TDAI_LLM_MODEL=%MEMORY_TENCENTDB_LLM_MODEL%"
if "%TDAI_LLM_BASE_URL%"=="" set "TDAI_LLM_BASE_URL=https://api.openai.com/v1"
if "%TDAI_LLM_MODEL%"=="" set "TDAI_LLM_MODEL=gpt-4o"
mkdir "%TDAI_DATA_DIR%" 2>nul
cd /d "%REPO_ROOT%"
node --import tsx/esm src/gateway/server.ts
exit /b %ERRORLEVEL%

:require_command
where %~1 >nul 2>nul
if errorlevel 1 (
  echo [ERROR] %~2 not found in PATH.
  exit /b 1
)
exit /b 0

:check_python
python --version >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%V in ('python --version 2^>^&1') do echo [memory-tencentdb] %%V
  exit /b 0
)
py -3 --version >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%V in ('py -3 --version 2^>^&1') do echo [memory-tencentdb] %%V
  exit /b 0
)
echo [ERROR] Python 3 not found. Install Python before running Hermes.
exit /b 1

:check_hermes
where hermes >nul 2>nul
if errorlevel 1 (
  echo [WARN] hermes command not found in PATH. Provider files will still be installed.
  exit /b 0
)
echo [memory-tencentdb] hermes command found
exit /b 0

:write_env
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:HERMES_ENV; $dir=Split-Path -Parent $p; New-Item -ItemType Directory -Force $dir | Out-Null; $keys=@('TDAI_DATA_DIR','TDAI_GATEWAY_HOST','TDAI_GATEWAY_PORT','TDAI_LLM_BASE_URL','TDAI_LLM_API_KEY','TDAI_LLM_MODEL','MEMORY_TENCENTDB_GATEWAY_CMD','MEMORY_TENCENTDB_GATEWAY_HOST','MEMORY_TENCENTDB_GATEWAY_PORT','MEMORY_TENCENTDB_LLM_BASE_URL','MEMORY_TENCENTDB_LLM_API_KEY','MEMORY_TENCENTDB_LLM_MODEL'); $pattern='^('+(($keys | ForEach-Object {[regex]::Escape($_)}) -join '|')+')='; $lines=@(); if(Test-Path $p){ $lines=Get-Content $p | Where-Object { $_ -notmatch $pattern } }; $dq=[char]34; $bs=[char]92; foreach($k in $keys){ $v=[Environment]::GetEnvironmentVariable($k,'Process'); if($null -ne $v -and $v.Length -gt 0){ $escaped=$v.Replace([string]$bs, ([string]$bs)+([string]$bs)).Replace([string]$dq, ([string]$bs)+([string]$dq)); $lines += ($k + '=' + [string]$dq + $escaped + [string]$dq) } }; Set-Content -Path $p -Value $lines -Encoding UTF8"
exit /b %ERRORLEVEL%

:health_check
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $u='http://' + $env:MEMORY_TENCENTDB_GATEWAY_HOST + ':' + $env:MEMORY_TENCENTDB_GATEWAY_PORT + '/health'; $r=Invoke-RestMethod -TimeoutSec 2 -Uri $u; if($r.status -eq 'ok' -or $r.status -eq 'degraded'){ exit 0 }; exit 1 } catch { exit 1 }"
exit /b %ERRORLEVEL%
