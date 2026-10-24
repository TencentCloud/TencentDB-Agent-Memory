#requires -Version 5.1
[CmdletBinding()]
param([switch]$FullStack)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_lib.ps1')
Initialize-Deploy
Assert-Settings @('PROXY_IMAGE', 'PROXY_PORT', 'PROXY_UPSTREAM_URL', 'PROXY_UPSTREAM_API_KEY', 'PROXY_UPSTREAM_MODEL')
$full = $FullStack -or (Get-Setting 'PROXY_FULL_STACK' '0') -eq '1'
$sessionInit = $full -or (Get-Setting 'PROXY_ENABLE_SESSION_INIT' '0') -eq '1'
$auth = $full -or $sessionInit -or (Get-Setting 'PROXY_ENABLE_AUTH' '0') -eq '1'
$tdai = $full -or (Get-Setting 'PROXY_ENABLE_TDAI' '0') -eq '1'
$gatewayKey = Get-Setting 'MEMORY_CORE_GATEWAY_API_KEY'
$config = @{
    server = @{ host = '0.0.0.0'; port = 8096; forwardTimeoutMs = 600000 }
    upstream = @{ url = Get-Setting 'PROXY_UPSTREAM_URL'; apiKey = Get-Setting 'PROXY_UPSTREAM_API_KEY' }
    log = @{ file = ''; level = 'info'; backend = 'console' }
    tdai = @{
        enabled = $tdai; endpoint = 'http://memory-core:8420'; apiKey = $gatewayKey; serviceId = 'default'
        memory = @{ enabled = $true; inject = $true; writeL0 = $true; recallL1 = $true; injectL2L3 = $true }
    }
    skill = @{ endpoint = 'http://memory-core:8420'; serviceToken = $gatewayKey }
    knowledge = @{ enabled = $tdai; endpoint = 'http://memory-core:8420'; serviceToken = $gatewayKey; serviceId = 'default' }
    auth = @{ enabled = $auth; url = 'http://memory-core:8420'; timeoutMs = 5000 }
    sessionInit = @{
        enabled = $sessionInit; maxRetries = 3; injectAgentContext = $true; injectTaskContext = $true
        headerAutoSelect = @{ enabled = $true; teamHeader = 'x-team-id'; agentHeader = 'x-agent-id'; taskHeader = 'x-task-id'; onMismatch = 'form' }
    }
    costGuard = @{ enabled = $false }
    injection = @{ enabled = $true; injectors = @('skill', 'knowledge', 'tdai-memory') }
    redis = @{ enabled = $false }
}
$configFile = Write-DeployConfig (Get-Setting 'PROXY_CONFIG_DIR' (Join-Path $PSScriptRoot '.proxy-config')) 'config.yaml' $config
Start-DeployContainer 'tdai-proxy' (Get-Setting 'PROXY_IMAGE') @(
    '--network-alias', 'proxy', '-p', "$(Get-Setting 'PROXY_PORT'):8096", '-v', "${configFile}:/data/config.yaml:ro"
)
Wait-Healthy 'tdai-proxy'
