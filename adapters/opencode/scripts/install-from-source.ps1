[CmdletBinding()]
param(
  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw "This checked-in source auto-installer currently supports Windows PowerShell only. Use the regular adapter installation on macOS/Linux." }

function Find-CompatibleNode {
  $candidates = [Collections.Generic.List[string]]::new()
  foreach ($command in @(Get-Command node -All -ErrorAction SilentlyContinue)) { $candidates.Add($command.Source) }
  $profile = [Environment]::GetFolderPath("UserProfile")
  $known = @(
    (Join-Path $profile ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"),
    (Join-Path ([Environment]::GetFolderPath("ProgramFiles")) "nodejs\node.exe")
  )
  foreach ($path in $known) { if (Test-Path -LiteralPath $path) { $candidates.Add($path) } }
  $workBuddyVersions = Join-Path $profile ".workbuddy\binaries\node\versions"
  if (Test-Path -LiteralPath $workBuddyVersions) {
    foreach ($node in @(Get-ChildItem -LiteralPath $workBuddyVersions -Filter node.exe -Recurse -File -ErrorAction SilentlyContinue)) { $candidates.Add($node.FullName) }
  }
  $compatible = foreach ($path in @($candidates | Select-Object -Unique)) {
    try {
      $raw = (& $path --version).Trim().TrimStart("v")
      $version = [Version]$raw
      if ($version -ge [Version]"22.16.0") { [pscustomobject]@{ Path = $path; Version = $version } }
    } catch { continue }
  }
  $selected = $compatible | Sort-Object Version -Descending | Select-Object -First 1
  if (-not $selected) { throw "Node.js 22.16.0 or newer is required. Install a current Node.js LTS release, then retry the same OpenCode instruction." }
  return $selected
}

function Read-PrivateEnv([string]$Path) {
  $values = @{}
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $separator = $trimmed.IndexOf("=")
    if ($separator -lt 1) { throw "Invalid .env line; expected NAME=VALUE." }
    $name = $trimmed.Substring(0, $separator).Trim()
    $value = $trimmed.Substring($separator + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    if ($name -notmatch "^[A-Za-z_][A-Za-z0-9_]*$") { throw "Invalid environment variable name." }
    $values[$name] = $value
  }
  return $values
}

function Value-OrEmpty([hashtable]$Values, [string]$Name) {
  if ($Values.ContainsKey($Name)) { return [string]$Values[$Name] }
  return ""
}

function Quote-Yaml([string]$Value) {
  return '"' + $Value.Replace('\', '/').Replace('"', '\"') + '"'
}

function Redact([string]$Text, [string[]]$Secrets) {
  $safe = $Text
  foreach ($secret in $Secrets) {
    if (-not [string]::IsNullOrWhiteSpace($secret)) { $safe = $safe.Replace($secret, "[REDACTED]") }
  }
  return $safe -replace '(?i)(Authorization\s*[:=]\s*Bearer\s+)\S+', '$1[REDACTED]' -replace '(?i)(api[_-]?key\s*[:=]\s*)\S+', '$1[REDACTED]'
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
} else {
  $RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
}

$memoryCore = Join-Path $RepoRoot "MemoryCore"
$adapter = Join-Path $RepoRoot "adapters\opencode"
$envFile = Join-Path $memoryCore ".env.opencode.local"
if (-not (Test-Path -LiteralPath (Join-Path $memoryCore "package.json")) -or -not (Test-Path -LiteralPath (Join-Path $adapter "package.json"))) {
  throw "RepoRoot must contain MemoryCore/package.json and adapters/opencode/package.json."
}
if (-not (Test-Path -LiteralPath $envFile)) { throw "Create and fill MemoryCore/.env.opencode.local first." }

Push-Location $RepoRoot
try {
  & git check-ignore --quiet --no-index -- "MemoryCore/.env.opencode.local"
  if ($LASTEXITCODE -ne 0) { throw "MemoryCore/.env.opencode.local must be ignored by Git." }
} finally {
  Pop-Location
}

$nodeRuntime = Find-CompatibleNode
$nodeVersion = $nodeRuntime.Version.ToString()
$settings = Read-PrivateEnv $envFile
$portText = Value-OrEmpty $settings "TDAI_GATEWAY_PORT"
$port = if ($portText) { [int]$portText } else { 18420 }
if ($port -lt 1 -or $port -gt 65535) { throw "TDAI_GATEWAY_PORT must be between 1 and 65535." }

$skillText = Value-OrEmpty $settings "TDAI_SKILL_ENABLED"
if (-not $skillText) { $skillText = "false" }
if ($skillText -notin @("true", "false")) { throw "TDAI_SKILL_ENABLED must be true or false." }
$skillEnabled = $skillText -eq "true"
$llmKey = Value-OrEmpty $settings "TDAI_LLM_API_KEY"
$llmBaseUrl = Value-OrEmpty $settings "TDAI_LLM_BASE_URL"
$llmModel = Value-OrEmpty $settings "TDAI_LLM_MODEL"
$hasLlm = $llmKey -and $llmBaseUrl -and $llmModel
if ($skillEnabled -and -not $hasLlm) { throw "Skill requires complete LLM configuration." }
if (@($llmKey, $llmBaseUrl, $llmModel).Where({ $_ }).Count -notin @(0, 3)) { throw "LLM key, Base URL, and model must be all empty or all configured." }

$embeddingKey = Value-OrEmpty $settings "TDAI_EMBEDDING_API_KEY"
$embeddingBaseUrl = Value-OrEmpty $settings "TDAI_EMBEDDING_BASE_URL"
$embeddingModel = Value-OrEmpty $settings "TDAI_EMBEDDING_MODEL"
$embeddingDimensions = Value-OrEmpty $settings "TDAI_EMBEDDING_DIMENSIONS"
$embeddingCount = @($embeddingKey, $embeddingBaseUrl, $embeddingModel).Where({ $_ }).Count
if ($embeddingCount -notin @(0, 3)) { throw "Embedding key, Base URL, and model must be all empty or all configured." }
if ($embeddingCount -eq 3 -and ($embeddingDimensions -notmatch "^[1-9][0-9]*$")) { throw "TDAI_EMBEDDING_DIMENSIONS must be a positive integer." }

$dataDirText = Value-OrEmpty $settings "TDAI_GATEWAY_DATA_DIR"
$dataDir = if ($dataDirText) {
  if ([IO.Path]::IsPathRooted($dataDirText)) { [IO.Path]::GetFullPath($dataDirText) } else { [IO.Path]::GetFullPath((Join-Path $RepoRoot $dataDirText)) }
} else {
  [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath("UserProfile")) ".memory-tencentdb\memory-tdai"))
}
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$runtimeDir = Join-Path $memoryCore ".opencode-runtime"
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$runtimeConfig = Join-Path $runtimeDir "tdai-gateway.yaml"
$fastL1 = (Value-OrEmpty $settings "TDAI_E2E_FAST_L1") -eq "true"

$yaml = [Collections.Generic.List[string]]::new()
$yaml.Add("# Generated by TencentDB Agent Memory OpenCode source installer. Do not commit.")
$yaml.Add("deployMode: standalone")
$yaml.Add('stateBackend: "local"')
$yaml.Add("server:")
$yaml.Add("  port: $port")
$yaml.Add('  host: "127.0.0.1"')
$yaml.Add("data:")
$yaml.Add("  baseDir: $(Quote-Yaml $dataDir)")
$yaml.Add("llm:")
$yaml.Add("  baseUrl: $(Quote-Yaml $llmBaseUrl)")
$yaml.Add('  apiKey: "${TDAI_LLM_API_KEY}"')
$yaml.Add("  model: $(Quote-Yaml $llmModel)")
$yaml.Add("  maxTokens: 4096")
$yaml.Add("  timeoutMs: 120000")
$yaml.Add("memory:")
$yaml.Add("  capture:")
$yaml.Add("    enabled: true")
$yaml.Add("  extraction:")
$yaml.Add("    enabled: $($hasLlm.ToString().ToLowerInvariant())")
$yaml.Add("    enableDedup: true")
$yaml.Add("    maxMemoriesPerSession: 20")
$yaml.Add("  persona:")
$yaml.Add("    triggerEveryN: 50")
$yaml.Add("    maxScenes: 15")
$yaml.Add("  pipeline:")
$yaml.Add("    everyNConversations: $(if ($fastL1) { 1 } else { 5 })")
$yaml.Add("    enableWarmup: true")
$yaml.Add("    l1IdleTimeoutSeconds: $(if ($fastL1) { 3 } else { 600 })")
$yaml.Add("    l2DelayAfterL1Seconds: 90")
$yaml.Add("    l2MinIntervalSeconds: 900")
$yaml.Add("    l2MaxIntervalSeconds: 3600")
$yaml.Add("  recall:")
$yaml.Add("    enabled: true")
$yaml.Add("    maxResults: 5")
$yaml.Add("    scoreThreshold: 0.3")
$yaml.Add('    strategy: "hybrid"')
$yaml.Add("    timeoutMs: 5000")
$yaml.Add('  storeBackend: "sqlite"')
$yaml.Add("  embedding:")
if ($embeddingCount -eq 3) {
  $yaml.Add('    provider: "openai"')
  $yaml.Add("    baseUrl: $(Quote-Yaml $embeddingBaseUrl)")
  $yaml.Add('    apiKey: "${TDAI_EMBEDDING_API_KEY}"')
  $yaml.Add("    model: $(Quote-Yaml $embeddingModel)")
  $yaml.Add("    dimensions: $embeddingDimensions")
} else {
  $yaml.Add('    provider: "none"')
}
$yaml.Add("  bm25:")
$yaml.Add("    enabled: true")
$yaml.Add('    language: "zh"')
$yaml.Add("skill:")
$yaml.Add("  enabled: $($skillEnabled.ToString().ToLowerInvariant())")
if ($skillEnabled) {
  $yaml.Add("  routing:")
  $yaml.Add('    mode: "bm25"')
  $yaml.Add("    searchTopK: 20")
  $yaml.Add("  extraction:")
  $yaml.Add("    enabled: true")
  $yaml.Add("    maxIterations: 16")
}
[IO.File]::WriteAllLines($runtimeConfig, $yaml, [Text.UTF8Encoding]::new($false))

Push-Location $memoryCore
try {
  & npm install --no-package-lock --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw "MemoryCore dependency installation failed." }
} finally {
  Pop-Location
}

$endpoint = "http://127.0.0.1:$port"
$health = $null
try { $health = Invoke-RestMethod "$endpoint/health" -TimeoutSec 3 } catch {}
$pidPath = Join-Path $runtimeDir "gateway.pid"
$requiresPrivateRuntime = [bool]($dataDirText -or $hasLlm -or $embeddingCount -eq 3 -or $skillEnabled)
if ($health -and $requiresPrivateRuntime) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  $recordedPid = if (Test-Path -LiteralPath $pidPath) {
    $candidate = (Get-Content -LiteralPath $pidPath -Raw).Trim()
    if ($candidate -match "^[1-9][0-9]*$") { [int]$candidate } else { 0 }
  } else { 0 }
  $ownedProcess = if ($recordedPid -and $listener.OwningProcess -eq $recordedPid) {
    Get-CimInstance Win32_Process -Filter "ProcessId=$recordedPid" -ErrorAction SilentlyContinue
  } else { $null }
  $normalizedCore = [regex]::Escape($memoryCore)
  if (-not $ownedProcess -or $ownedProcess.CommandLine -notmatch "src[/\\]gateway[/\\]server\.ts" -or $ownedProcess.CommandLine -notmatch $normalizedCore) {
    throw "Gateway is reachable, but its server-side model and data configuration cannot be safely verified or replaced. Stop the existing Gateway or choose another TDAI_GATEWAY_PORT."
  }
  Stop-Process -Id $recordedPid -Force
  $stopDeadline = [DateTime]::UtcNow.AddSeconds(10)
  do { Start-Sleep -Milliseconds 250 } until (-not (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) -or [DateTime]::UtcNow -ge $stopDeadline)
  if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw "Managed Gateway did not release port $port." }
  $health = $null
}
if (-not $health) {
  $stdout = Join-Path $runtimeDir "gateway.stdout.log"
  $stderr = Join-Path $runtimeDir "gateway.stderr.log"
  $stdin = Join-Path $runtimeDir "gateway.stdin.txt"
  $launcherPath = Join-Path $runtimeDir "start-gateway.ps1"
  $serverEntry = Join-Path $memoryCore "src\gateway\server.ts"
  [IO.File]::WriteAllText($stdin, "")
  $node = $nodeRuntime.Path
  $escape = { param([string]$value) $value.Replace("'", "''") }
  $launcher = @'
$ErrorActionPreference = "Stop"
$settings = @{}
foreach ($line in [IO.File]::ReadAllLines('__ENV_FILE__')) {
  $trimmed = $line.Trim()
  if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
  $separator = $trimmed.IndexOf("=")
  if ($separator -lt 1) { continue }
  $name = $trimmed.Substring(0, $separator).Trim()
  $value = $trimmed.Substring($separator + 1).Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  Set-Item -Path "Env:$name" -Value $value
}
$env:TDAI_GATEWAY_CONFIG = '__RUNTIME_CONFIG__'
$process = Start-Process -FilePath '__NODE__' -ArgumentList @("--import", "tsx", "__SERVER_ENTRY__") -WorkingDirectory '__MEMORY_CORE__' -RedirectStandardInput '__STDIN__' -RedirectStandardOutput '__STDOUT__' -RedirectStandardError '__STDERR__' -WindowStyle Hidden -PassThru
[IO.File]::WriteAllText('__PID_PATH__', [string]$process.Id)
'@
  $launcher = $launcher.Replace("__ENV_FILE__", (& $escape $envFile)).Replace("__RUNTIME_CONFIG__", (& $escape $runtimeConfig)).Replace("__NODE__", (& $escape $node)).Replace("__MEMORY_CORE__", (& $escape $memoryCore)).Replace("__SERVER_ENTRY__", (& $escape $serverEntry)).Replace("__STDIN__", (& $escape $stdin)).Replace("__STDOUT__", (& $escape $stdout)).Replace("__STDERR__", (& $escape $stderr)).Replace("__PID_PATH__", (& $escape $pidPath))
  [IO.File]::WriteAllText($launcherPath, $launcher, [Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath -Force }
  $pwsh = (Get-Process -Id $PID).Path
  $commandLine = '"{0}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{1}"' -f $pwsh, $launcherPath
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
  if ($created.ReturnValue -ne 0) { throw "Detached Gateway launcher failed with WMI code $($created.ReturnValue)." }
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  $gatewayPid = $null
  do {
    Start-Sleep -Milliseconds 500
    if (-not $gatewayPid -and (Test-Path -LiteralPath $pidPath)) {
      $pidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()
      if ($pidText -match "^[1-9][0-9]*$") { $gatewayPid = [int]$pidText }
    }
    try { $health = Invoke-RestMethod "$endpoint/health" -TimeoutSec 2 } catch {}
  } until (($health -and $gatewayPid) -or [DateTime]::UtcNow -ge $deadline)
  if (-not $health -or -not $gatewayPid) {
    $tail = if (Test-Path -LiteralPath $stderr) { (Get-Content -LiteralPath $stderr -Tail 30) -join [Environment]::NewLine } else { "No Gateway error log was created." }
    throw "Gateway failed to become healthy. $(Redact $tail @($llmKey, $embeddingKey))"
  }
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop | Where-Object OwningProcess -eq $gatewayPid
  if (-not $listener) { throw "Gateway health succeeded, but the new process does not own port $port." }
  [IO.File]::WriteAllText($pidPath, [string]$gatewayPid)
} else {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) { [IO.File]::WriteAllText((Join-Path $runtimeDir "gateway.pid"), [string]$listener.OwningProcess) }
}

Push-Location $adapter
try {
  & npm ci
  if ($LASTEXITCODE -ne 0) { throw "Adapter dependency installation failed." }
  & npm run check
  if ($LASTEXITCODE -ne 0) { throw "Adapter checks failed." }
} finally {
  Pop-Location
}

$configBase = if ($env:XDG_CONFIG_HOME) { [IO.Path]::GetFullPath($env:XDG_CONFIG_HOME) } else { Join-Path ([Environment]::GetFolderPath("UserProfile")) ".config" }
$openCodeConfig = Join-Path $configBase "opencode"
$pluginsDir = Join-Path $openCodeConfig "plugins"
New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
$loaderPath = Join-Path $pluginsDir "tencentdb-agent-memory.ts"
$privateConfig = Join-Path $openCodeConfig "tencentdb-agent-memory.json"
if (Test-Path -LiteralPath $loaderPath) {
  $existing = Get-Content -LiteralPath $loaderPath -Raw
  if ($existing -notmatch "TencentDB Agent Memory managed source loader|Generated by tdai-opencode") { throw "Refusing to overwrite unrelated plugin: $loaderPath" }
}

$privateBody = [ordered]@{
  endpoint = $endpoint; apiKey = "local"; serviceId = "default"; teamId = "default"; agentId = "opencode"; userId = "default"
  recallEnabled = $true; captureEnabled = $true; skillEnabled = $skillEnabled
}
[IO.File]::WriteAllText($privateConfig, ($privateBody | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
$distPath = Join-Path $adapter "dist\index.js"
$distUrl = [Uri]::new($distPath).AbsoluteUri
$configLiteral = $privateConfig | ConvertTo-Json -Compress
$urlLiteral = $distUrl | ConvertTo-Json -Compress
$loaderBody = "// TencentDB Agent Memory managed source loader`nprocess.env.TDAI_OPENCODE_CONFIG_FILE ??= $configLiteral`nexport { TencentDBAgentMemory } from $urlLiteral`n"
[IO.File]::WriteAllText($loaderPath, $loaderBody, [Text.UTF8Encoding]::new($false))

$result = [ordered]@{
  installed = $true
  nodeVersion = $nodeVersion
  endpoint = $endpoint
  health = [string]$health.status
  gatewayPid = [int](Get-Content -LiteralPath (Join-Path $runtimeDir "gateway.pid") -Raw)
  dataDir = $dataDir
  loader = $loaderPath
  config = $privateConfig
  l0Enabled = $true
  l1Enabled = [bool]$hasLlm
  embeddingEnabled = $embeddingCount -eq 3
  skillEnabled = $skillEnabled
  keyValuesPrinted = $false
}
$result | ConvertTo-Json -Depth 4
