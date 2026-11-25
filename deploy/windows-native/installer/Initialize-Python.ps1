Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Initialize-NativePythonBuild {
  param(
    [Parameter(Mandatory = $true)][string]$CacheDir,
    [string]$Proxy
  )

  $venv = Join-Path $CacheDir "installer-python"
  $python = Join-Path $venv "Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $python)) {
    $systemPython = (Get-Command python -ErrorAction Stop).Source
    & $systemPython -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "Failed to create the isolated Python build environment." }
  }

  & $python -c "import PyInstaller, win32serviceutil" 2>$null
  if ($LASTEXITCODE -ne 0) {
    $arguments = @("-m", "pip", "install", "--disable-pip-version-check", "-r", (Join-Path $PSScriptRoot "requirements.txt"))
    if ($Proxy) { $arguments += @("--proxy", $Proxy) }
    & $python @arguments
    if ($LASTEXITCODE -ne 0) { throw "Failed to install the Python installer build dependencies." }
  }
  return $python
}
