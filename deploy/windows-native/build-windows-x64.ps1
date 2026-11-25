param(
  [string]$NodeVersion = "22.23.5",
  [string]$NodeHome,
  [string]$OutputDir = (Join-Path $PSScriptRoot "out"),
  [string]$Proxy,
  [switch]$SkipNpmInstall
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\common.ps1")

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$cacheDir = Join-Path $PSScriptRoot ".cache"
[IO.Directory]::CreateDirectory($cacheDir) | Out-Null
if ($Proxy) {
  $env:HTTPS_PROXY = $Proxy
  $env:HTTP_PROXY = $Proxy
}

function Invoke-NativeDownload {
  param([string]$Uri, [string]$Destination)
  $arguments = @("-fL", "--retry", "3", $Uri, "-o", $Destination)
  if ($Proxy) {
    $arguments = @("--proxy", $Proxy) + $arguments
  }
  & curl.exe @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Download failed: $Uri"
  }
}

function Invoke-NativeNpm {
  param([string]$WorkingDirectory, [string[]]$Arguments)
  Push-Location $WorkingDirectory
  try {
    & (Join-Path $script:NodeHome "node.exe") $script:NpmCli @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "npm $($Arguments -join ' ') failed in $WorkingDirectory with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

if (-not $NodeHome) {
  $zip = Join-Path $cacheDir "node-v$NodeVersion-win-x64.zip"
  $sums = Join-Path $cacheDir "node-v$NodeVersion-SHASUMS256.txt"
  if (-not (Test-Path -LiteralPath $zip)) {
    Invoke-NativeDownload -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -Destination $zip
  }
  if (-not (Test-Path -LiteralPath $sums)) {
    Invoke-NativeDownload -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -Destination $sums
  }
  $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  $expectedLine = Select-String -LiteralPath $sums -Pattern "node-v$([regex]::Escape($NodeVersion))-win-x64.zip$"
  if ($null -eq $expectedLine -or $expectedLine.Line.Split(" ")[0] -ne $actual) {
    throw "Node.js checksum verification failed."
  }
  $NodeHome = Join-Path $cacheDir "node-v$NodeVersion-win-x64"
  if (-not (Test-Path -LiteralPath (Join-Path $NodeHome "node.exe"))) {
    Expand-Archive -LiteralPath $zip -DestinationPath $cacheDir -Force
  }
}
$script:NodeHome = [IO.Path]::GetFullPath($NodeHome)
$version = & (Join-Path $NodeHome "node.exe") --version
if ($version -notlike "v22.*") {
  throw "Node.js 22 is required; found $version"
}
$env:PATH = "$NodeHome;$env:PATH"

# npm 10 can reject cross-platform optional esbuild entries in the upstream lockfiles.
$npmToolingDir = Join-Path $cacheDir "npm11"
$script:NpmCli = Join-Path $npmToolingDir "node_modules\npm\bin\npm-cli.js"
if (-not (Test-Path -LiteralPath $script:NpmCli)) {
  & (Join-Path $NodeHome "npm.cmd") install --prefix $npmToolingDir npm@11 --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install the build-local npm 11 CLI."
  }
}

if (-not $SkipNpmInstall) {
  Invoke-NativeNpm -WorkingDirectory (Join-Path $repoRoot "MemoryCore") `
    -Arguments @("install", "--ignore-scripts", "--legacy-peer-deps", "--omit=peer", "--no-audit", "--no-fund")
  Invoke-NativeNpm -WorkingDirectory (Join-Path $repoRoot "MemoryKnowledge") `
    -Arguments @("ci", "--no-audit", "--no-fund")
  Invoke-NativeNpm -WorkingDirectory (Join-Path $repoRoot "MemoryPanel") `
    -Arguments @("ci", "--no-audit", "--no-fund")
  Invoke-NativeNpm -WorkingDirectory (Join-Path $repoRoot "MemoryPanel\web") `
    -Arguments @("ci", "--no-audit", "--no-fund")
  Invoke-NativeNpm -WorkingDirectory (Join-Path $repoRoot "MemoryProxy") `
    -Arguments @("install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund")
  Invoke-NativeNpm -WorkingDirectory (Join-Path $repoRoot "MemoryProxy") `
    -Arguments @("ci", "--no-audit", "--no-fund")
}

# This branch's aggregate build references a seed-v2 project that is not shipped.
Invoke-NativeNpm -WorkingDirectory (Join-Path $repoRoot "MemoryCore") -Arguments @("run", "build:plugin")
foreach ($target in @("build:migrate-sqlite-to-vdb", "build:export-tencent-vdb", "build:read-local-memory")) {
  Invoke-NativeNpm -WorkingDirectory (Join-Path $repoRoot "MemoryCore") -Arguments @("run", $target)
}
Invoke-NativeNpm -WorkingDirectory (Join-Path $repoRoot "MemoryKnowledge") -Arguments @("run", "build")
Invoke-NativeNpm -WorkingDirectory (Join-Path $repoRoot "MemoryKnowledge") -Arguments @("run", "typecheck")
Invoke-NativeNpm -WorkingDirectory (Join-Path $repoRoot "MemoryPanel") -Arguments @("run", "build")
Invoke-NativeNpm -WorkingDirectory (Join-Path $repoRoot "MemoryPanel") -Arguments @("run", "typecheck")
Invoke-NativeNpm -WorkingDirectory (Join-Path $repoRoot "MemoryPanel\web") -Arguments @("run", "build")
Invoke-NativeNpm -WorkingDirectory (Join-Path $repoRoot "MemoryProxy") -Arguments @("run", "typecheck")

. (Join-Path $PSScriptRoot "installer\Initialize-Python.ps1")
$pythonBuild = Initialize-NativePythonBuild -CacheDir $cacheDir -Proxy $Proxy
$serviceDist = Join-Path $cacheDir "service-dist"
$serviceWork = Join-Path $cacheDir "service-work"
$serviceSpec = Join-Path $cacheDir "service-spec"
foreach ($directory in @($serviceDist, $serviceWork, $serviceSpec)) {
  [IO.Directory]::CreateDirectory($directory) | Out-Null
}
& $pythonBuild -m PyInstaller --noconfirm --clean --onefile --console `
  --name TdaiMemoryService --distpath $serviceDist --workpath $serviceWork --specpath $serviceSpec `
  --hidden-import win32timezone (Join-Path $PSScriptRoot "service\service_host.py")
if ($LASTEXITCODE -ne 0) { throw "Failed to build the pywin32 service host." }
$serviceHost = Join-Path $serviceDist "TdaiMemoryService.exe"

$packageDir = Join-Path ([IO.Path]::GetFullPath($OutputDir)) "TencentDB-Agent-Memory-windows-x64"
if (Test-Path -LiteralPath $packageDir) {
  # Robocopy handles deep node_modules paths that PowerShell 5.1 cannot remove.
  $emptyDir = Join-Path $cacheDir "empty"
  [IO.Directory]::CreateDirectory($emptyDir) | Out-Null
  & robocopy.exe $emptyDir $packageDir "/MIR" "/NFL" "/NDL" "/NJH" "/NJS" "/NP" | Out-Null
  if ($LASTEXITCODE -gt 7) {
    throw "Failed to clean the previous package with robocopy exit code $LASTEXITCODE"
  }
  $global:LASTEXITCODE = 0
  Remove-Item -LiteralPath $packageDir -Recurse -Force
}
[IO.Directory]::CreateDirectory($packageDir) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $packageDir "scripts")) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $packageDir "config")) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $packageDir "service")) | Out-Null

foreach ($component in @("MemoryCore", "MemoryKnowledge", "MemoryPanel", "MemoryProxy")) {
  $source = Join-Path $repoRoot $component
  Invoke-Robocopy -Source $source -Destination (Join-Path $packageDir "app\$component") `
    -ExcludedDirectories @((Join-Path $source ".git"), (Join-Path $source "data"), (Join-Path $source "coverage"), (Join-Path $source "__tests__"), (Join-Path $source ".archive-tmp"), (Join-Path $source "z_config"))
}
Invoke-Robocopy -Source $NodeHome -Destination (Join-Path $packageDir "runtime\node")
Copy-Item -LiteralPath $serviceHost -Destination (Join-Path $packageDir "service\TdaiMemoryService.exe")
$licenseDir = Join-Path $packageDir "licenses"
[IO.Directory]::CreateDirectory($licenseDir) | Out-Null
$pythonRoot = Split-Path (Split-Path $pythonBuild -Parent) -Parent
$pythonPackages = Join-Path $pythonRoot "Lib\site-packages"
$pythonBase = (& $pythonBuild -c "import sys; print(sys.base_prefix)").Trim()
Copy-Item -LiteralPath (Join-Path $pythonBase "LICENSE.txt") -Destination (Join-Path $licenseDir "Python.txt")
Copy-Item -LiteralPath (Join-Path $pythonPackages "pyinstaller-6.22.3.dist-info\licenses\COPYING.txt") `
  -Destination (Join-Path $licenseDir "PyInstaller.txt")
Invoke-Robocopy -Source (Join-Path $pythonPackages "pywin32-312.dist-info\licenses") `
  -Destination (Join-Path $licenseDir "pywin32")
Copy-Item -LiteralPath (Join-Path $repoRoot "LICENSE") -Destination (Join-Path $packageDir "LICENSE.txt")
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "config\settings.example.psd1") -Destination (Join-Path $packageDir "config\settings.example.psd1")
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "install.ps1") -Destination (Join-Path $packageDir "install.ps1")
foreach ($script in @("Initialize-Configuration.ps1", "Configure-Firewall.ps1", "start-all.ps1", "stop-all.ps1", "verify.ps1", "uninstall.ps1")) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination (Join-Path $packageDir "scripts\$script")
}
Invoke-Robocopy -Source (Join-Path $PSScriptRoot "lib") -Destination (Join-Path $packageDir "scripts\lib")
Invoke-Robocopy -Source (Join-Path $PSScriptRoot "service") -Destination (Join-Path $packageDir "scripts\service") `
  -ExcludedDirectories @((Join-Path $PSScriptRoot "service\__pycache__"))

$buildInfo = [ordered]@{
  node = $version
  serviceHost = "pywin32 312"
  installerToolkit = "PyInstaller 6.22.3"
  sourceRevision = (& git -C $repoRoot rev-parse HEAD).Trim()
  builtAtUtc = [DateTime]::UtcNow.ToString("o")
}
Write-NativeJson -Value $buildInfo -Path (Join-Path $packageDir "build-info.json")
Write-Host "Windows x64 package created: $packageDir"
