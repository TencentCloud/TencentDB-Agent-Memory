param(
  [string]$InstallDir = (Split-Path -Parent $PSScriptRoot),
  [switch]$Purge
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\common.ps1")

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run uninstall.ps1 from an elevated PowerShell console."
}

$layout = Get-NativeLayout -InstallDir $InstallDir
Stop-NativeServiceSet
foreach ($name in @("TdaiMemoryProxy", "TdaiMemoryPanel", "TdaiMemoryKnowledge", "TdaiMemoryCore")) {
  $exe = Join-Path $layout.ServiceDir "$name.exe"
  if ((Test-Path -LiteralPath $exe) -and $null -ne (Get-Service -Name $name -ErrorAction SilentlyContinue)) {
    & $exe remove
    if ($LASTEXITCODE -ne 0) {
      throw "pywin32 failed to uninstall $name with exit code $LASTEXITCODE"
    }
  }
}

& (Join-Path $PSScriptRoot "Configure-Firewall.ps1") -InstallDir $layout.Root -Remove

if ($Purge) {
  if (([IO.Path]::GetFullPath($InstallDir)).Length -lt 8) {
    throw "Refusing to purge an unsafe path: $InstallDir"
  }
  Remove-Item -LiteralPath $layout.Root -Recurse -Force -Confirm
} else {
  Write-Host "Services were removed. Application files, configuration, and data were preserved in $($layout.Root)."
}
