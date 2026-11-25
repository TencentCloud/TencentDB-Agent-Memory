param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$SettingsPath
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\common.ps1")

function New-NativeAdminKey {
  $bytes = New-Object byte[] 64
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  $raw = ([Convert]::ToBase64String($bytes) -replace "[^A-Za-z0-9]", "").Substring(0, 32)
  return "sk-mem-$raw"
}

$settings = Import-PowerShellDataFile -LiteralPath $SettingsPath
$layout = Get-NativeLayout -InstallDir $InstallDir
$deploymentMode = if ($settings.ContainsKey("DeploymentMode")) { ([string]$settings.DeploymentMode).ToLowerInvariant() } else { "basic" }
if ($deploymentMode -notin @("full", "basic")) {
  throw "DeploymentMode must be 'Full' or 'Basic'."
}
$coreProtocol = if ($settings.Core.ContainsKey("LlmProtocol")) { [string]$settings.Core.LlmProtocol } else { "openai" }
if ($coreProtocol -notin @("openai", "anthropic")) {
  throw "Core.LlmProtocol must be 'openai' or 'anthropic'."
}
$upstreamUri = $null
if (-not [Uri]::TryCreate([string]$settings.Proxy.UpstreamUrl, [UriKind]::Absolute, [ref]$upstreamUri) -or
    $upstreamUri.Scheme -notin @("http", "https")) {
  throw "Proxy.UpstreamUrl must be an absolute HTTP(S) URL."
}
if ($deploymentMode -eq "full") {
  if (-not [string]$settings.Core.LlmBaseUrl -or -not [string]$settings.Core.LlmApiKey -or -not [string]$settings.Core.LlmModel) {
    throw "Full mode requires Core.LlmBaseUrl, Core.LlmApiKey, and Core.LlmModel."
  }
  if (-not [string]$settings.Proxy.UpstreamApiKey -or -not [string]$settings.Proxy.UpstreamModel) {
    throw "Full mode requires Proxy.UpstreamApiKey and Proxy.UpstreamModel."
  }
  $coreUri = $null
  if (-not [Uri]::TryCreate([string]$settings.Core.LlmBaseUrl, [UriKind]::Absolute, [ref]$coreUri) -or
      $coreUri.Scheme -notin @("http", "https")) {
    throw "Core.LlmBaseUrl must be an absolute HTTP(S) URL."
  }
  if ($upstreamUri.Host -eq "llm-upstream.example.com" -or $coreUri.Host -eq "llm-upstream.example.com") {
    throw "Edit settings.psd1 and replace the example LLM endpoints before installation."
  }
}
$enableExtraction = [bool]([string]$settings.Core.LlmBaseUrl)
if ($settings.Core.ContainsKey("EnableExtraction")) {
  $enableExtraction = [bool]$settings.Core.EnableExtraction
}

foreach ($directory in @($layout.ConfigDir, $layout.DataDir, $layout.LogDir, $layout.RunDir,
    (Join-Path $layout.DataDir "core"), (Join-Path $layout.DataDir "knowledge"),
    (Join-Path $layout.DataDir "knowledge\ssh-keys"), (Join-Path $layout.DataDir "knowledge\agent-templates"),
    (Join-Path $layout.DataDir "proxy"), (Join-Path $layout.DataDir "skill-resources"))) {
  [IO.Directory]::CreateDirectory($directory) | Out-Null
}

if (Test-Path -LiteralPath $layout.AdminKeyFile) {
  $adminKey = [IO.File]::ReadAllText($layout.AdminKeyFile).Trim()
  if (-not $adminKey) {
    throw "Admin key file is empty: $($layout.AdminKeyFile)"
  }
} else {
  $adminKey = New-NativeAdminKey
  [IO.File]::WriteAllText($layout.AdminKeyFile, $adminKey, (New-Object Text.UTF8Encoding($false)))
}

$upstreamKeyFile = Join-Path $layout.ConfigDir "proxy-upstream.key"
[IO.File]::WriteAllText($upstreamKeyFile, [string]$settings.Proxy.UpstreamApiKey, (New-Object Text.UTF8Encoding($false)))

$coreConfig = [ordered]@{
  deployMode = "standalone"
  stateBackend = "local"
  server = [ordered]@{
    port = [int]$settings.Core.Port
    host = [string]$settings.Core.Host
  }
  data = [ordered]@{ baseDir = Join-Path $layout.DataDir "core" }
  llm = [ordered]@{
    baseUrl = [string]$settings.Core.LlmBaseUrl
    apiKey = [string]$settings.Core.LlmApiKey
    model = [string]$settings.Core.LlmModel
    maxTokens = 32000
    timeoutMs = 300000
  }
  memory = [ordered]@{
    promptMode = [string]$settings.Core.PromptMode
    capture = [ordered]@{ enabled = $true }
    extraction = [ordered]@{ enabled = $enableExtraction; enableDedup = $true; maxMemoriesPerSession = 20 }
    persona = [ordered]@{ triggerEveryN = 50; maxScenes = 15; triggerMode = "current" }
    pipeline = [ordered]@{
      everyNConversations = 5
      enableWarmup = $enableExtraction
      l1IdleTimeoutSeconds = 600
      l2DelayAfterL1Seconds = 90
      l2MinIntervalSeconds = 900
      l2MaxIntervalSeconds = 3600
    }
    recall = [ordered]@{
      enabled = $true
      maxResults = 5
      scoreThreshold = 0.3
      strategy = "hybrid"
      timeoutMs = 5000
    }
    storeBackend = "sqlite"
    embedding = [ordered]@{ provider = "none" }
  }
  skill = [ordered]@{
    enabled = $true
    routing = [ordered]@{ mode = "bm25"; searchTopK = 20 }
    extraction = [ordered]@{
      enabled = $enableExtraction
      maxIterations = 16
      queue = [ordered]@{
        backend = "local"
        keyPrefix = "tdai"
        resultTtlSeconds = 86400
        lockTtlMs = 600000
        maxRetries = 2
        retryBackoffsMs = @(5000, 15000)
      }
    }
    resources = [ordered]@{
      maxResourceSizeBytes = 5000000
      downloadDir = Join-Path $layout.DataDir "skill-resources"
    }
  }
}
Write-NativeJson -Value $coreConfig -Path (Join-Path $layout.ConfigDir "tdai-gateway.yaml")

$proxyConfig = [ordered]@{
  server = [ordered]@{
    host = [string]$settings.Proxy.Host
    port = [int]$settings.Proxy.Port
    forwardTimeoutMs = 600000
  }
  upstream = [ordered]@{ url = [string]$settings.Proxy.UpstreamUrl; apiKey = "" }
  log = [ordered]@{ file = ""; level = "info"; backend = "console" }
  tdai = [ordered]@{
    enabled = [bool]$settings.Proxy.EnableTdai
    endpoint = "http://127.0.0.1:$($settings.Core.Port)"
    apiKey = ""
    serviceId = "default"
    memory = [ordered]@{
      enabled = $true
      inject = $true
      writeL0 = $true
      recallL1 = $true
      injectL2L3 = $true
    }
  }
  skill = [ordered]@{
    endpoint = "http://127.0.0.1:$($settings.Core.Port)"
    serviceToken = ""
  }
  knowledge = [ordered]@{
    enabled = [bool]$settings.Proxy.EnableTdai
    endpoint = "http://127.0.0.1:$($settings.Core.Port)"
    serviceToken = ""
    serviceId = "default"
  }
  auth = [ordered]@{
    enabled = [bool]$settings.Proxy.EnableAuth
    url = "http://127.0.0.1:$($settings.Core.Port)"
    timeoutMs = 5000
  }
  sessionInit = [ordered]@{
    enabled = [bool]$settings.Proxy.EnableSessionInit
    maxRetries = 3
    injectAgentContext = $true
    injectTaskContext = $true
    headerAutoSelect = [ordered]@{
      enabled = $true
      teamHeader = "x-team-id"
      agentHeader = "x-agent-id"
      taskHeader = "x-task-id"
      onMismatch = "form"
    }
  }
  costGuard = [ordered]@{ enabled = $false }
  creditReport = [ordered]@{ url = ""; timeoutMs = 5000 }
  injection = [ordered]@{ enabled = $true; injectors = @("skill", "knowledge", "tdai-memory") }
  redis = [ordered]@{ enabled = $false }
  storage = [ordered]@{
    enabled = $true
    backend = "sqlite"
    ttlDays = 7
    sqlite = [ordered]@{ dbPath = Join-Path $layout.DataDir "proxy\proxy.db" }
    fs = [ordered]@{ fsRoot = Join-Path $layout.DataDir "proxy\fs" }
  }
}
$proxyConfigPath = Join-Path $layout.ConfigDir "proxy.yaml"
Write-NativeJson -Value $proxyConfig -Path $proxyConfigPath

$instances = [ordered]@{
  instances = @([ordered]@{
    id = [string]$settings.Panel.InstanceId
    name = [string]$settings.Panel.InstanceName
    gateway_endpoint = "http://127.0.0.1:$($settings.Core.Port)"
    proxy_endpoint = "http://127.0.0.1:$($settings.Proxy.Port)"
    api_key = $adminKey
  })
}
Write-NativeJson -Value $instances -Path (Join-Path $layout.ConfigDir "metadata-instances.json")

$environment = [ordered]@{
  Core = [ordered]@{
    NODE_ENV = "production"
    TDAI_GATEWAY_CONFIG = Join-Path $layout.ConfigDir "tdai-gateway.yaml"
    TDAI_GATEWAY_HOST = [string]$settings.Core.Host
    TDAI_GATEWAY_PORT = [string]$settings.Core.Port
    TDAI_GATEWAY_API_KEY = ""
    TDAI_DATA_DIR = Join-Path $layout.DataDir "core"
    STORE_MODE = "sqlite"
  }
  Knowledge = [ordered]@{
    HOST = [string]$settings.Knowledge.Host
    PORT = [string]$settings.Knowledge.Port
    API_PREFIX = "/v3"
    KNOWLEDGE_DATA_DIR = Join-Path $layout.DataDir "knowledge"
    KNOWLEDGE_DB_PATH = Join-Path $layout.DataDir "knowledge\knowledge.db"
    KNOWLEDGE_SSH_KEY_DIR = Join-Path $layout.DataDir "knowledge\ssh-keys"
    KNOWLEDGE_PUBLIC_BASE_URL = "http://127.0.0.1:$($settings.Knowledge.Port)/v3"
    KNOWLEDGE_SERVICE_KEY = ""
    TDAI_AGENT_TEMPLATE_DIR = Join-Path $layout.DataDir "knowledge\agent-templates"
    TMC_CALLBACK_URL = "http://127.0.0.1:$($settings.Panel.Port)"
    LLM_MODE = "custom"
    LLM_PROVIDER = "custom"
    LLM_PROTOCOL = $coreProtocol
    LLM_API_KEY = [string]$settings.Core.LlmApiKey
    LLM_BASE_URL = [string]$settings.Core.LlmBaseUrl
    LLM_MODEL = [string]$settings.Core.LlmModel
    LLM_MAX_TOKENS = "32768"
    LLM_TIMEOUT_MS = "1200000"
    LOG_LEVEL = "info"
  }
  Panel = [ordered]@{
    HOST = [string]$settings.Panel.Host
    PORT = [string]$settings.Panel.Port
    UI_DIST_DIR = Join-Path $layout.AppDir "MemoryPanel\web\dist"
    METADATA_INSTANCES_CONFIG = Join-Path $layout.ConfigDir "metadata-instances.json"
    METADATA_REMOTE_TIMEOUT_MS = "15000"
    KNOWLEDGE_SERVICE_URL = "http://127.0.0.1:$($settings.Knowledge.Port)"
    KNOWLEDGE_AUTH_TOKEN = ""
    KNOWLEDGE_TIMEOUT_MS = "15000"
    KNOWLEDGE_LLM_BINDING_SYNC = "0"
    LOG_LEVEL = "info"
    LOG_FORMAT = "json"
  }
  Proxy = [ordered]@{
    TDAI_PROXY_UPSTREAM_API_KEY_FILE = $upstreamKeyFile
  }
}
Write-NativeJson -Value $environment -Path $layout.EnvironmentFile
$settingsDestination = Join-Path $layout.ConfigDir "settings.psd1"
if ([IO.Path]::GetFullPath($SettingsPath) -ne [IO.Path]::GetFullPath($settingsDestination)) {
  Copy-Item -LiteralPath $SettingsPath -Destination $settingsDestination -Force
}
Write-Host "Native configuration generated in $($layout.ConfigDir)"
