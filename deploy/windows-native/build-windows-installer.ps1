param(
  [string]$NodeVersion = "22.23.5",
  [string]$OutputDir = (Join-Path $PSScriptRoot "out"),
  [string]$Proxy,
  [switch]$SkipPayloadBuild,
  [switch]$SkipNpmInstall
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

if (-not $SkipPayloadBuild) {
  & (Join-Path $PSScriptRoot "build-windows-x64.ps1") -NodeVersion $NodeVersion -OutputDir $OutputDir `
    -Proxy $Proxy -SkipNpmInstall:$SkipNpmInstall
  if ($LASTEXITCODE -ne 0) { throw "Windows payload build failed." }
}

$packageDir = Join-Path ([IO.Path]::GetFullPath($OutputDir)) "TencentDB-Agent-Memory-windows-x64"
if (-not (Test-Path -LiteralPath (Join-Path $packageDir "install.ps1"))) {
  throw "Windows payload not found. Run build-windows-x64.ps1 first or omit -SkipPayloadBuild."
}

. (Join-Path $PSScriptRoot "installer\Initialize-Python.ps1")
$cacheDir = Join-Path $PSScriptRoot ".cache"
$python = Initialize-NativePythonBuild -CacheDir $cacheDir -Proxy $Proxy
& $python (Join-Path $PSScriptRoot "installer\build_installer.py") `
  --package-dir $packageDir --output-dir ([IO.Path]::GetFullPath($OutputDir)) `
  --work-dir (Join-Path $cacheDir "installer-build")
if ($LASTEXITCODE -ne 0) { throw "Windows installer build failed." }
