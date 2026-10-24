#requires -Version 5.1
<#
.SYNOPSIS
Remove stack containers, keeping data by default. -Purge also deletes named volumes and generated credentials/configs.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param([switch]$Purge)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_lib.ps1')
if (Test-Path -LiteralPath $script:EnvFile) { Import-DeployEnv }
Assert-Docker
foreach ($name in @('tdai-proxy', 'tdai-memory-hub', 'tdai-memory-core', (Get-Setting 'MONGO_LOCAL_CONTAINER' 'tdai-mongo-local'))) {
    if ((Get-Container $name) -and $PSCmdlet.ShouldProcess($name, 'Remove Docker container (keep volumes)')) {
        Invoke-Docker @('rm', '-f', $name) | Out-Null
    }
}
if ($Purge -and $PSCmdlet.ShouldProcess('stack data volumes, admin key and generated configs', 'Permanently delete deployment data')) {
    # Delete credentials only after volume removal succeeds, so a failed purge stays recoverable.
    foreach ($volume in @((Get-Setting 'MEMORY_CORE_VOLUME' 'tdai-memory-core-data'), (Get-Setting 'PANEL_VOLUME' 'tdai-panel-data'), 'mongo-local-db', 'mongo-local-configdb', 'mongo-local-mongot')) {
        if ((Invoke-Docker @('volume', 'inspect', $volume) -AllowFailure).ExitCode -eq 0) {
            Invoke-Docker @('volume', 'rm', $volume) | Out-Null
        }
    }
    if ((Invoke-Docker @('network', 'inspect', 'tdai-memory-stack') -AllowFailure).ExitCode -eq 0) {
        Invoke-Docker @('network', 'rm', 'tdai-memory-stack') | Out-Null
    }
    # Only known generated files are removed; never recursively delete configurable directories.
    $files = @(
        (Get-Setting 'MEMORY_CORE_ADMIN_KEY_FILE' (Join-Path $PSScriptRoot '.admin-key')),
        (Join-Path (Get-Setting 'MEMORY_CORE_CONFIG_DIR' (Join-Path $PSScriptRoot '.memory-core-config')) 'tdai-gateway.yaml'),
        (Join-Path (Get-Setting 'PROXY_CONFIG_DIR' (Join-Path $PSScriptRoot '.proxy-config')) 'config.yaml')
    )
    foreach ($file in $files) {
        if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
    }
}
Write-Ok 'Done.'
