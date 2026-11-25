#requires -Version 5.1
<#
.SYNOPSIS
Check Docker, .env, ports and LLM connectivity without creating containers.
.EXAMPLE
.\verify.ps1 -SkipLlm
#>
[CmdletBinding()]
param([switch]$SkipLlm)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_lib.ps1')
Initialize-Deploy
Assert-Settings
Assert-Ports
foreach ($name in @('MEMORY_CORE_IMAGE', 'MEMORY_HUB_IMAGE', 'PROXY_IMAGE')) {
    $image = Get-Setting $name
    if ((Invoke-Docker @('image', 'inspect', $image) -AllowFailure).ExitCode -ne 0) {
        Write-Warning "Image $image will be downloaded on first start."
    }
}
if (-not $SkipLlm) { Test-ConfiguredLlms }
Write-Ok 'Preflight passed. Start the stack with .\start-all.ps1'
