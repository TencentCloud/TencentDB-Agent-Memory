param(
  [string]$InstallDir = (Split-Path -Parent $PSScriptRoot),
  [switch]$Remove
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Firewall configuration requires an elevated PowerShell console."
}

$rules = @(
  @{ Name = "TdaiMemory-Core-TCP-In"; Component = "Core"; DefaultPort = 8420 },
  @{ Name = "TdaiMemory-Knowledge-TCP-In"; Component = "Knowledge"; DefaultPort = 8424 },
  @{ Name = "TdaiMemory-Panel-TCP-In"; Component = "Panel"; DefaultPort = 8125 },
  @{ Name = "TdaiMemory-Proxy-TCP-In"; Component = "Proxy"; DefaultPort = 8096 }
)

foreach ($rule in $rules) {
  Get-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction Stop
}
if ($Remove) {
  Write-Host "Tdai Memory firewall rules removed."
  return
}

$root = [IO.Path]::GetFullPath($InstallDir)
$environmentPath = Join-Path $root "config\environment.json"
$proxyPath = Join-Path $root "config\proxy.yaml"
if (-not (Test-Path -LiteralPath $environmentPath) -or -not (Test-Path -LiteralPath $proxyPath)) {
  throw "Generated configuration is missing. Initialize configuration before applying firewall rules."
}
$environment = Get-Content -LiteralPath $environmentPath -Raw | ConvertFrom-Json
$proxy = Get-Content -LiteralPath $proxyPath -Raw | ConvertFrom-Json
$ports = @{
  Core = [int]$environment.Core.TDAI_GATEWAY_PORT
  Knowledge = [int]$environment.Knowledge.PORT
  Panel = [int]$environment.Panel.PORT
  Proxy = [int]$proxy.server.port
}
foreach ($rule in $rules) {
  $port = $ports[$rule.Component]
  if (-not $port) {
    $port = $rule.DefaultPort
  }
  New-NetFirewallRule `
    -Name $rule.Name `
    -DisplayName "TencentDB Agent Memory - $($rule.Component)" `
    -Group "TencentDB Agent Memory" `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $port `
    -Profile Any `
    -ErrorAction Stop | Out-Null
  Write-Host "Allowed inbound TCP port $port for $($rule.Component)."
}
