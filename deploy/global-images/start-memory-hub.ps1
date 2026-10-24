#requires -Version 5.1
# Start Panel + Knowledge with the same persisted service credential.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_lib.ps1')
Initialize-Deploy
Assert-Settings @('MEMORY_HUB_IMAGE', 'PANEL_PORT', 'KNOWLEDGE_PORT', 'PANEL_VOLUME', 'MEMORY_LLM_BASE_URL', 'MEMORY_LLM_API_KEY', 'MEMORY_LLM_MODEL', 'KNOWLEDGE_PUBLIC_BASE_URL')
$serviceKey = Get-Setting 'KNOWLEDGE_SERVICE_KEY'
if (-not $serviceKey -or $serviceKey -eq 'REPLACE_ME') {
    $serviceKey = New-DeployKey 'ks-svc-'
    Set-DeploySetting 'KNOWLEDGE_SERVICE_KEY' $serviceKey
}
$publicUrl = Get-Setting 'MEMORY_HUB_PROXY_PUBLIC_URL' "http://localhost:$(Get-Setting 'PROXY_PORT' '8096')"
# The combined image requires a nonempty key even when Core's Bearer gate is disabled.
$gatewayKey = Get-Setting 'MEMORY_CORE_GATEWAY_API_KEY'
if (-not $gatewayKey) { $gatewayKey = 'local' }
if (-not (Get-Container 'tdai-memory-core')) { Write-Warning 'memory-core is not running; start it before using Knowledge/Memory features.' }
Start-DeployContainer 'tdai-memory-hub' (Get-Setting 'MEMORY_HUB_IMAGE') @(
    '--network-alias', 'memory-hub', '-p', "$(Get-Setting 'PANEL_PORT'):8125",
    '-p', "$(Get-Setting 'KNOWLEDGE_PORT'):8424", '-v', "$(Get-Setting 'PANEL_VOLUME'):/data/knowledge"
) @{
    PANEL_PORT = '8125'; KNOWLEDGE_PORT = '8424'
    KNOWLEDGE_PUBLIC_BASE_URL = Get-Setting 'KNOWLEDGE_PUBLIC_BASE_URL'
    KNOWLEDGE_SERVICE_KEY = $serviceKey; KNOWLEDGE_AUTH_TOKEN = $serviceKey
    REMOTE_INSTANCE_ID = 'default'; REMOTE_INSTANCE_NAME = 'default'
    REMOTE_INSTANCE_URL = 'http://memory-core:8420'; REMOTE_INSTANCE_KEY = $gatewayKey
    REMOTE_INSTANCE_PROXY_URL = $publicUrl
    LLM_MODE = 'custom'; LLM_PROTOCOL = Get-Setting 'MEMORY_LLM_PROTOCOL' 'openai'
    LLM_API_KEY = Get-Setting 'MEMORY_LLM_API_KEY'; LLM_BASE_URL = Get-Setting 'MEMORY_LLM_BASE_URL'
    LLM_MODEL = Get-Setting 'MEMORY_LLM_MODEL'; KNOWLEDGE_LLM_BINDING_SYNC = '0'
}
Wait-Healthy 'tdai-memory-hub' 120
