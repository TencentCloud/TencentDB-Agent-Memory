param(
  [string]$InstallDir = (Split-Path -Parent $PSScriptRoot)
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\common.ps1")

$layout = Get-NativeLayout -InstallDir $InstallDir
if (Test-NativeServiceSet) {
  Stop-NativeServiceSet
  Write-Host "All TencentDB Agent Memory services are stopped."
  return
}

if (-not (Test-Path -LiteralPath $layout.ProcessFile)) {
  Write-Host "No managed native processes are registered."
  return
}

$records = Get-Content -LiteralPath $layout.ProcessFile -Raw | ConvertFrom-Json
for ($index = $records.Count - 1; $index -ge 0; $index--) {
  $record = $records[$index]
  $process = Get-Process -Id $record.Id -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    continue
  }
  if ([IO.Path]::GetFullPath($process.Path) -ne [IO.Path]::GetFullPath($record.NodeExe)) {
    throw "PID $($record.Id) no longer belongs to the managed Node.js runtime; refusing to stop it."
  }
  Stop-Process -Id $record.Id -Force
  Write-Host "Stopped $($record.Name) (PID $($record.Id))."
}
Remove-Item -LiteralPath $layout.ProcessFile -Force
