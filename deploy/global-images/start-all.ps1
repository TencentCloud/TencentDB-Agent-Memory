#requires -Version 5.1
<#
.SYNOPSIS
Start memory-core, memory-hub and proxy on Docker Desktop (Linux containers).
.EXAMPLE
.\start-all.ps1
.EXAMPLE
.\start-all.ps1 -NonInteractive -SkipLlm
#>
[CmdletBinding()]
param([switch]$NonInteractive, [switch]$SkipLlm)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_lib.ps1')

# Validate Docker before asking for credentials or writing local configuration.
Assert-Docker
if (-not (Test-Path -LiteralPath $script:EnvFile)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '.env.example') -Destination $script:EnvFile
}
Import-DeployEnv
if (-not $NonInteractive) { Initialize-LlmSettings }
Assert-Settings
Assert-Ports
if (-not $SkipLlm) { Test-ConfiguredLlms }

& (Join-Path $PSScriptRoot 'start-memory-core.ps1')
& (Join-Path $PSScriptRoot 'start-memory-hub.ps1')
& (Join-Path $PSScriptRoot 'start-proxy.ps1') -FullStack:((Get-Setting 'PROXY_FULL_STACK' '1') -eq '1')

Write-Ok 'All services are ready.'
Write-Endpoints
$keyFile = Get-Setting 'MEMORY_CORE_ADMIN_KEY_FILE' (Join-Path $PSScriptRoot '.admin-key')
Write-Host "  Admin key file: $keyFile"
Write-Host '  Stop containers and keep data: .\stop-all.ps1'
