#requires -Version 5.1
# Shared helpers for native Windows deployment; no Bash or external modules required.
$ErrorActionPreference = 'Stop'
$script:EnvFile = if ($env:ENV_FILE) { [IO.Path]::GetFullPath($env:ENV_FILE) } else { Join-Path $PSScriptRoot '.env' }
$script:Settings = @{}
$script:RequiredSettings = @(
    'MEMORY_CORE_IMAGE', 'MEMORY_HUB_IMAGE', 'PROXY_IMAGE',
    'MEMORY_CORE_PORT', 'PANEL_PORT', 'KNOWLEDGE_PORT', 'PROXY_PORT',
    'MEMORY_CORE_VOLUME', 'PANEL_VOLUME', 'MEMORY_LLM_BASE_URL',
    'MEMORY_LLM_API_KEY', 'MEMORY_LLM_MODEL', 'KNOWLEDGE_PUBLIC_BASE_URL',
    'PROXY_UPSTREAM_URL', 'PROXY_UPSTREAM_API_KEY', 'PROXY_UPSTREAM_MODEL'
)

function Write-Info([string]$Message) { Write-Host "[info] $Message" }
function Write-Ok([string]$Message) { Write-Host "[ok] $Message" -ForegroundColor Green }

function Get-Setting([string]$Name, [string]$Default = '') {
    # Keep explicitly empty values (including on Windows PowerShell 5.1).
    if ($script:Settings.ContainsKey($Name)) { return [string]$script:Settings[$Name] }
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ($null -ne $value) { return $value }
    return $Default
}

function Import-DeployEnv {
    if (-not (Test-Path -LiteralPath $script:EnvFile -PathType Leaf)) {
        throw "Missing $script:EnvFile. Copy .env.example to .env and fill in the LLM settings."
    }
    $script:Settings = @{}
    $lineNumber = 0
    foreach ($line in [IO.File]::ReadAllLines($script:EnvFile, [Text.Encoding]::UTF8)) {
        $lineNumber++
        if ($line -match '^\s*(#.*)?$') { continue }
        if ($line -notmatch '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
            throw "Invalid .env assignment at line $lineNumber. Use KEY=value."
        }
        $name = $Matches[1]
        $value = $Matches[2].Trim()
        if ($value.StartsWith('"')) {
            if ($value -notmatch '^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$') {
                throw "Invalid quoted .env value at line $lineNumber."
            }
            # Decode shell quoting only; never evaluate commands or expand variables.
            $value = [regex]::Replace($Matches[1], '\\(["\\$`])', '$1')
        } elseif ($value.StartsWith("'")) {
            if ($value -notmatch "^'([^']*)'\s*(?:#.*)?$") {
                throw "Invalid quoted .env value at line $lineNumber."
            }
            $value = $Matches[1]
        } else {
            $value = if ($value.StartsWith('#')) { '' } else { ($value -replace '\s+#.*$', '').TrimEnd() }
        }
        $script:Settings[$name] = $value
    }
}

function Write-Utf8File([string]$Path, [string]$Text) {
    # UTF-8 without BOM works for both Linux containers and Windows PowerShell.
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

function Set-DeploySetting([string]$Name, [string]$Value) {
    if ($Value -match '[\r\n\x00]') { throw "$Name must be a single-line value." }
    $escaped = [regex]::Replace($Value, '[\\"$`]', '\$0')
    $assignment = $Name + '="' + $escaped + '"'
    $lines = @([IO.File]::ReadAllLines($script:EnvFile, [Text.Encoding]::UTF8))
    $found = $false
    $lines = @(foreach ($line in $lines) {
        if ($line -match ('^\s*(?:export\s+)?' + [regex]::Escape($Name) + '\s*=')) {
            $assignment
            $found = $true
        } else { $line }
    })
    if (-not $found) { $lines += $assignment }
    Write-Utf8File $script:EnvFile (($lines -join "`n") + "`n")
    $script:Settings[$Name] = $Value
}

function Assert-Settings([string[]]$Names = $script:RequiredSettings) {
    $missing = @($Names | Where-Object { [string]::IsNullOrWhiteSpace((Get-Setting $_)) -or (Get-Setting $_) -eq 'REPLACE_ME' })
    if ($missing.Count) { throw "Fill in these .env settings before starting: $($missing -join ', ')" }
}

function Invoke-Docker {
    param([string[]]$Arguments, [switch]$AllowFailure)
    # Native executables do not throw on nonzero exits in Windows PowerShell 5.1.
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    $output = & $script:Docker @Arguments 2>&1
    $code = $LASTEXITCODE
    $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    if ($code -ne 0 -and -not $AllowFailure) {
        throw "Docker $($Arguments[0]) failed (exit $code). $text"
    }
    [pscustomobject]@{ ExitCode = $code; Output = $text }
}

function Assert-Docker {
    $command = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { throw 'Docker CLI not found. Install Docker Desktop and add docker.exe to PATH.' }
    $script:Docker = $command.Source
    $result = Invoke-Docker @('info', '--format', '{{.OSType}}') -AllowFailure
    if ($result.ExitCode -ne 0) { throw 'Docker engine is unavailable. Start Docker Desktop and wait until the engine is running.' }
    if (($result.Output -split '\r?\n') -notcontains 'linux') { throw 'Switch Docker Desktop to Linux containers before starting this stack.' }
}

function Initialize-Deploy {
    Import-DeployEnv
    Assert-Docker
}

function Ensure-DeployNetwork {
    if ((Invoke-Docker @('network', 'inspect', 'tdai-memory-stack') -AllowFailure).ExitCode -ne 0) {
        Invoke-Docker @('network', 'create', 'tdai-memory-stack') | Out-Null
    }
}

function Get-Container([string]$Name) {
    $result = Invoke-Docker @('container', 'inspect', $Name) -AllowFailure
    if ($result.ExitCode -eq 0) { return ($result.Output | ConvertFrom-Json | Select-Object -First 1) }
}

function Start-DeployContainer {
    param([string]$Name, [string]$Image, [string[]]$Options, [hashtable]$Environment = @{})
    if ((Get-Setting 'PULL' '0') -eq '1') { Invoke-Docker @('pull', $Image) | Out-Null }
    Ensure-DeployNetwork
    if (Get-Container $Name) { Invoke-Docker @('rm', '-f', $Name) | Out-Null }
    $dockerArgs = @('run', '-d', '--name', $Name, '--network', 'tdai-memory-stack', '--add-host=host.docker.internal:host-gateway') + $Options
    $previous = @{}
    try {
        foreach ($key in $Environment.Keys) {
            $previous[$key] = [Environment]::GetEnvironmentVariable($key)
            [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key])
            # Pass only names: Docker reads the values from its process environment.
            # This preserves quotes/backslashes on PowerShell 5.1 and keeps keys out of argv.
            $dockerArgs += @('--env', $(if ([string]::IsNullOrEmpty($Environment[$key])) { "$key=" } else { $key }))
        }
        Write-Info "Starting $Name ($Image)"
        Invoke-Docker ($dockerArgs + $Image) | Out-Null
    } finally {
        foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key]) }
    }
}

function Wait-Healthy([string]$Name, [int]$Timeout = 90) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $container = Get-Container $Name
        if (-not $container -or $container.State.Status -ne 'running') { break }
        if (-not $container.State.Health -or $container.State.Health.Status -eq 'healthy') {
            Write-Ok "$Name ready"
            return
        }
        if ($container.State.Health.Status -eq 'unhealthy') { break }
        Start-Sleep -Seconds 2
    } while ($timer.Elapsed.TotalSeconds -lt $Timeout)
    Write-Host (Invoke-Docker @('logs', '--tail', '30', $Name) -AllowFailure).Output
    throw "$Name did not become healthy within $Timeout seconds. See docker logs $Name."
}

function Assert-Ports([string[]]$Names = @('MEMORY_CORE_PORT', 'PANEL_PORT', 'KNOWLEDGE_PORT', 'PROXY_PORT')) {
    $owned = @()
    foreach ($container in @('tdai-memory-core', 'tdai-memory-hub', 'tdai-proxy')) {
        $info = Get-Container $container
        if ($info -and $info.State.Status -eq 'running') {
            foreach ($line in ((Invoke-Docker @('port', $container)).Output -split "`n")) {
                if ($line -match ':(\d+)\s*$') { $owned += [int]$Matches[1] }
            }
        }
    }
    $listeners = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port })
    $seen = @()
    foreach ($name in $Names) {
        $port = 0
        if (-not [int]::TryParse((Get-Setting $name), [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
            throw "$name must be a port number between 1 and 65535."
        }
        if ($seen -contains $port) { throw "Multiple services use port $port. Choose distinct ports in .env." }
        $seen += $port
        if ($listeners -contains $port -and $owned -notcontains $port) { throw "Port $port ($name) is already in use. Change it in .env." }
    }
}

function Invoke-DeployHttp([string]$Url, [hashtable]$Headers = @{}, [object]$Body = $null) {
    $request = @{ Uri = $Url; Headers = $Headers; TimeoutSec = 15; UseBasicParsing = $true; ErrorAction = 'Stop' }
    if ($null -ne $Body) {
        $request.Method = 'Post'
        $request.ContentType = 'application/json; charset=utf-8'
        $request.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 10 -Compress))
    }
    try {
        $response = Invoke-WebRequest @request
        return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Content = $response.Content }
    } catch {
        $code = 0
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        return [pscustomobject]@{ StatusCode = $code; Content = '' }
    }
}

function Test-Llm([string]$Label, [string]$BaseUrl, [string]$ApiKey, [string]$Model, [string]$Protocol = 'openai') {
    $base = $BaseUrl.TrimEnd('/')
    $headers = @{ Authorization = "Bearer $ApiKey" }
    if ($Protocol -eq 'openai') {
        $base = $base -replace '/(?:chat/completions|messages)$', ''
        $response = Invoke-DeployHttp "$base/models" $headers
    } elseif ($Protocol -eq 'anthropic') {
        $url = if ($base.EndsWith('/messages')) { $base } elseif ($base.EndsWith('/v1')) { "$base/messages" } else { "$base/v1/messages" }
        $headers['x-api-key'] = $ApiKey
        $headers['anthropic-version'] = '2023-06-01'
        $response = Invoke-DeployHttp $url $headers @{ model = $Model; max_tokens = 1; messages = @(@{ role = 'user'; content = 'ping' }) }
    } else { throw 'MEMORY_LLM_PROTOCOL must be openai or anthropic.' }
    if ($response.StatusCode -ne 200) {
        throw "$Label LLM probe failed (HTTP $($response.StatusCode)). Check the URL, protocol and credentials, or use -SkipLlm if this provider has no probe endpoint."
    }
    Write-Ok "$Label LLM endpoint reachable"
}

function Test-ConfiguredLlms {
    Test-Llm 'memory' (Get-Setting 'MEMORY_LLM_BASE_URL') (Get-Setting 'MEMORY_LLM_API_KEY') (Get-Setting 'MEMORY_LLM_MODEL') (Get-Setting 'MEMORY_LLM_PROTOCOL' 'openai')
    $same = (Get-Setting 'MEMORY_LLM_PROTOCOL' 'openai') -eq 'openai'
    foreach ($pair in @(@('PROXY_UPSTREAM_URL', 'MEMORY_LLM_BASE_URL'), @('PROXY_UPSTREAM_API_KEY', 'MEMORY_LLM_API_KEY'), @('PROXY_UPSTREAM_MODEL', 'MEMORY_LLM_MODEL'))) {
        $same = $same -and (Get-Setting $pair[0]) -eq (Get-Setting $pair[1])
    }
    if (-not $same) { Test-Llm 'proxy' (Get-Setting 'PROXY_UPSTREAM_URL') (Get-Setting 'PROXY_UPSTREAM_API_KEY') (Get-Setting 'PROXY_UPSTREAM_MODEL') }
}

function Read-Setting([string]$Name, [switch]$Secret) {
    $current = Get-Setting $Name
    if ($current -eq 'REPLACE_ME') { $current = '' }
    if ($Secret) {
        $secure = Read-Host "$Name (hidden; Enter keeps current value)" -AsSecureString
        $credential = New-Object Management.Automation.PSCredential 'key', $secure
        $value = $credential.GetNetworkCredential().Password
    } else { $value = Read-Host "$Name [$current]" }
    if ([string]::IsNullOrWhiteSpace($value)) { $value = $current }
    Set-DeploySetting $Name $value
}

function Initialize-LlmSettings {
    foreach ($name in @('MEMORY_LLM_BASE_URL', 'MEMORY_LLM_API_KEY', 'MEMORY_LLM_MODEL', 'MEMORY_LLM_PROTOCOL')) {
        if ($name -eq 'MEMORY_LLM_PROTOCOL' -and -not (Get-Setting $name)) { $script:Settings[$name] = 'openai' }
        Read-Setting $name -Secret:($name -eq 'MEMORY_LLM_API_KEY')
    }
    if ((Read-Host 'Reuse memory LLM settings for proxy? [Y/n]') -notmatch '^[Nn]') {
        Set-DeploySetting 'PROXY_UPSTREAM_URL' (Get-Setting 'MEMORY_LLM_BASE_URL')
        Set-DeploySetting 'PROXY_UPSTREAM_API_KEY' (Get-Setting 'MEMORY_LLM_API_KEY')
        Set-DeploySetting 'PROXY_UPSTREAM_MODEL' (Get-Setting 'MEMORY_LLM_MODEL')
    } else {
        foreach ($name in @('PROXY_UPSTREAM_URL', 'PROXY_UPSTREAM_API_KEY', 'PROXY_UPSTREAM_MODEL')) { Read-Setting $name -Secret:($name -eq 'PROXY_UPSTREAM_API_KEY') }
    }
}

function New-DeployKey([string]$Prefix, [int]$Bytes = 24) {
    $buffer = New-Object byte[] $Bytes
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    $Prefix + ([BitConverter]::ToString($buffer).Replace('-', '').ToLowerInvariant())
}

function Write-DeployConfig([string]$Directory, [string]$Name, [hashtable]$Config) {
    $directoryPath = [IO.Path]::GetFullPath($Directory)
    [IO.Directory]::CreateDirectory($directoryPath) | Out-Null
    $path = Join-Path $directoryPath $Name
    # JSON is valid YAML and safely quotes API keys, backslashes and model names.
    Write-Utf8File $path ($Config | ConvertTo-Json -Depth 15)
    return $path
}

function Write-Endpoints {
    foreach ($item in @(@('Panel UI', 'PANEL_PORT', '/'), @('Knowledge API', 'KNOWLEDGE_PORT', '/v3/'), @('Memory Core', 'MEMORY_CORE_PORT', '/'), @('Proxy', 'PROXY_PORT', '/'))) {
        Write-Host ('  {0}: http://localhost:{1}{2}' -f $item[0], (Get-Setting $item[1]), $item[2])
    }
}
