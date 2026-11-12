#requires -Version 5.1
# Start the Gateway, initialize admin once and retain its key across restarts.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_lib.ps1')
Initialize-Deploy
Assert-Settings @('MEMORY_CORE_IMAGE', 'MEMORY_CORE_PORT', 'MEMORY_CORE_VOLUME')

$store = Get-Setting 'MEMORY_CORE_STORE_MODE' 'sqlite'
$metadata = Get-Setting 'MEMORY_CORE_METADATA_BACKEND' 'auto'
if ($store -notin @('sqlite', 'mongodb')) { throw 'MEMORY_CORE_STORE_MODE must be sqlite or mongodb.' }
if ($metadata -notin @('auto', 'sqlite', 'mongodb')) { throw 'MEMORY_CORE_METADATA_BACKEND must be auto, sqlite or mongodb.' }
if ($metadata -eq 'auto') { $metadata = $store }
$gatewayKey = Get-Setting 'MEMORY_CORE_GATEWAY_API_KEY'
if ($gatewayKey) { Write-Warning 'This branch requires an empty MEMORY_CORE_GATEWAY_API_KEY for Proxy auth/session initialization. See .env.example.' }
$containerEnv = @{
    TDAI_GATEWAY_PORT = '8420'; TDAI_GATEWAY_HOST = '0.0.0.0'
    TDAI_GATEWAY_API_KEY = $gatewayKey; TDAI_DATA_DIR = '/data/tdai-memory'; STORE_MODE = $store
}
$persona = @{ triggerEveryN = 50; maxScenes = 15; triggerMode = Get-Setting 'MEMORY_CORE_PERSONA_TRIGGER_MODE' 'current' }
if ($persona.triggerMode -eq 'jev') {
    Assert-Settings @('MEMORY_CORE_JEV_ENDPOINT', 'MEMORY_CORE_JEV_MODEL', 'TYPESAFE_API_KEY')
    $timeoutMs = 0
    if (-not [int]::TryParse((Get-Setting 'MEMORY_CORE_JEV_TIMEOUT_MS' '3000'), [ref]$timeoutMs) -or $timeoutMs -lt 100 -or $timeoutMs -gt 60000) {
        throw 'MEMORY_CORE_JEV_TIMEOUT_MS must be between 100 and 60000.'
    }
    $persona.jev = @{
        provider = Get-Setting 'MEMORY_CORE_JEV_PROVIDER' 'jev'
        endpoint = Get-Setting 'MEMORY_CORE_JEV_ENDPOINT'
        apiKey = '${TYPESAFE_API_KEY}'; model = Get-Setting 'MEMORY_CORE_JEV_MODEL'
        timeoutMs = $timeoutMs; diagnostics = @{ mode = Get-Setting 'MEMORY_CORE_JEV_DIAGNOSTICS_MODE' 'off' }
    }
    $containerEnv.TYPESAFE_API_KEY = Get-Setting 'TYPESAFE_API_KEY'
} elseif ($persona.triggerMode -ne 'current') { throw 'MEMORY_CORE_PERSONA_TRIGGER_MODE must be current or jev.' }
if ($store -eq 'mongodb' -or $metadata -eq 'mongodb') {
    $endpoint = Get-Setting 'MONGODB_ENDPOINT'
    if (-not $endpoint) {
        $mongoName = Get-Setting 'MONGO_LOCAL_CONTAINER' 'tdai-mongo-local'
        $mongo = Get-Container $mongoName
        if (-not $mongo -or $mongo.State.Status -ne 'running') {
            Start-DeployContainer $mongoName (Get-Setting 'MONGO_LOCAL_IMAGE' 'mongodb/mongodb-atlas-local:8.3') @(
                '--hostname', 'mongo-search', '--network-alias', 'mongo-search',
                '-v', 'mongo-local-db:/data/db', '-v', 'mongo-local-configdb:/data/configdb', '-v', 'mongo-local-mongot:/data/mongot'
            )
        }
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            $probe = Invoke-Docker @('exec', $mongoName, 'mongosh', '--quiet', '--eval', "if (db.adminCommand('hello').isWritablePrimary === true) quit(0); else quit(1)") -AllowFailure
            if ($probe.ExitCode -eq 0) { $ready = $true; break }
            Start-Sleep -Seconds 2
        }
        if (-not $ready) { throw "MongoDB did not elect a primary. See docker logs $mongoName." }
        $endpoint = 'mongodb://mongo-search:27017/?directConnection=true'
    }
    if ($store -eq 'mongodb') {
        $containerEnv.MONGODB_ENDPOINT = $endpoint
        $containerEnv.MONGODB_DATABASE = Get-Setting 'MONGODB_DATABASE' 'tdai_memory'
    }
    if ($metadata -eq 'mongodb') { $containerEnv.TDAI_METADATA_MONGO_URI = Get-Setting 'TDAI_METADATA_MONGO_URI' $endpoint }
}

$config = @{
    deployMode = 'standalone'; stateBackend = 'local'
    server = @{ port = 8420; host = '0.0.0.0' }
    data = @{ baseDir = '/data/tdai-memory' }
    llm = @{
        baseUrl = Get-Setting 'MEMORY_LLM_BASE_URL'; apiKey = Get-Setting 'MEMORY_LLM_API_KEY'
        model = Get-Setting 'MEMORY_LLM_MODEL'; maxTokens = 32000; timeoutMs = 300000
    }
    memory = @{
        promptMode = Get-Setting 'MEMORY_PROMPT_MODE' 'code'
        capture = @{ enabled = $true }
        extraction = @{ enabled = $true; enableDedup = $true; maxMemoriesPerSession = 20 }
        persona = $persona
        pipeline = @{
            everyNConversations = 5; enableWarmup = $true; l1IdleTimeoutSeconds = 600
            l2DelayAfterL1Seconds = 90; l2MinIntervalSeconds = 900; l2MaxIntervalSeconds = 3600
        }
        recall = @{ enabled = $true; maxResults = 5; scoreThreshold = 0.3; strategy = 'hybrid'; timeoutMs = 5000 }
        storeBackend = $store; embedding = @{ provider = 'none' }
    }
    skill = @{
        enabled = $true; routing = @{ mode = 'bm25'; searchTopK = 20 }
        extraction = @{
            enabled = $true; maxIterations = 16
            queue = @{ backend = 'local'; keyPrefix = 'tdai'; resultTtlSeconds = 86400; lockTtlMs = 600000; maxRetries = 2; retryBackoffsMs = @(5000, 15000) }
        }
        resources = @{ maxResourceSizeBytes = 5000000 }
    }
}
$configFile = Write-DeployConfig (Get-Setting 'MEMORY_CORE_CONFIG_DIR' (Join-Path $PSScriptRoot '.memory-core-config')) 'tdai-gateway.yaml' $config
Start-DeployContainer 'tdai-memory-core' (Get-Setting 'MEMORY_CORE_IMAGE') @(
    '--network-alias', 'memory-core', '-p', "$(Get-Setting 'MEMORY_CORE_PORT'):8420",
    '-v', "$(Get-Setting 'MEMORY_CORE_VOLUME'):/data/tdai-memory", '-v', "${configFile}:/data/config/tdai-gateway.yaml:ro"
) $containerEnv
Wait-Healthy 'tdai-memory-core'

$keyFile = [IO.Path]::GetFullPath((Get-Setting 'MEMORY_CORE_ADMIN_KEY_FILE' (Join-Path $PSScriptRoot '.admin-key')))
$key = if (Test-Path -LiteralPath $keyFile) { [IO.File]::ReadAllText($keyFile).Trim() } else { '' }
$hasKey = -not [string]::IsNullOrWhiteSpace($key)
if (-not $hasKey) { $key = New-DeployKey 'sk-mem-' 16 }
$headers = @{ 'x-tdai-service-id' = 'default' }
if ($gatewayKey) { $headers.Authorization = "Bearer $gatewayKey" }
$base = "http://localhost:$(Get-Setting 'MEMORY_CORE_PORT')"
$response = Invoke-DeployHttp "$base/v3/internal/meta/user/init-admin" $headers @{ username = Get-Setting 'MEMORY_CORE_ADMIN_USERNAME' 'admin'; user_key = $key }
if ($response.StatusCode -eq 200) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($keyFile)) | Out-Null
    Write-Utf8File $keyFile $key
} elseif ($response.StatusCode -eq 409) {
    if (-not $hasKey) { throw "Admin already exists, but $keyFile is missing. Restore the key file for this data volume." }
} else { throw "Admin initialization failed (HTTP $($response.StatusCode))." }
$verify = Invoke-DeployHttp "$base/v3/meta/auth/verify" $headers @{ user_key = $key }
if ($verify.StatusCode -ne 200) { throw "Admin key verification failed (HTTP $($verify.StatusCode)). Check that the key file matches the data volume." }
Write-Ok "Admin key verified; saved in $keyFile"
