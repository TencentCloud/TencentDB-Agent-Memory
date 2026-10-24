#requires -Version 5.1
# Run with powershell.exe or pwsh.exe -NoProfile -File <this file>. No Docker/Pester required.
$ErrorActionPreference = 'Stop'
$sourceDir = Split-Path -Parent $PSScriptRoot
$testDir = Join-Path ([IO.Path]::GetTempPath()) ('tdai-deploy-' + [guid]::NewGuid().ToString('N'))
# Exercise native argument handling in a path containing spaces and non-ASCII characters.
$sandbox = Join-Path $testDir ('Windows ' + [char]0x90e8 + [char]0x7f72 + ' [test]')
$stateDir = Join-Path $testDir 'state'
$binDir = Join-Path $testDir 'bin'
$shell = (Get-Process -Id $PID).Path
$savedEnv = @{}
foreach ($key in @('PATH', 'ENV_FILE', 'TDAI_DEPLOY_TEST_STATE', 'LLM_API_KEY', 'PULL', 'TYPESAFE_API_KEY')) { $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key) }
Get-ChildItem Env: | Where-Object { $_.Name -match '^(MEMORY_|PROXY_|PANEL_|KNOWLEDGE_|MONGODB_|MONGO_|TDAI_METADATA_)' } | ForEach-Object { $savedEnv[$_.Name] = $_.Value }
$server = $null
$script:Passed = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
    $script:Passed++
    Write-Host "PASS: $Message"
}
function Set-Flag([string]$Name, [string]$Value = '1') { [IO.File]::WriteAllText((Join-Path $stateDir $Name), $Value) }
function Clear-Flag([string]$Name) { $path = Join-Path $stateDir $Name; if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path } }
function Read-DockerLog {
    @([IO.File]::ReadAllLines((Join-Path $stateDir 'docker.jsonl'), [Text.Encoding]::UTF8) | ForEach-Object { $_ | ConvertFrom-Json })
}
function Run-Entry([string]$Name, [string[]]$Options = @(), [bool]$Success = $true) {
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    $output = & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $sandbox $Name) @Options 2>&1
    $code = $LASTEXITCODE
    if (($code -eq 0) -ne $Success) { throw "Unexpected exit $code from ${Name}: $($output -join "`n")" }
    return ($output -join "`n")
}
function Count-Runs { @((Read-DockerLog) | Where-Object { $_.argv[0] -eq 'run' }).Count }

try {
    foreach ($key in @($savedEnv.Keys)) {
        if ($key -match '^(MEMORY_|PROXY_|PANEL_|KNOWLEDGE_|MONGODB_|MONGO_|TDAI_METADATA_|TYPESAFE_API_KEY)') { [Environment]::SetEnvironmentVariable($key, $null) }
    }
    foreach ($dir in @($sandbox, $stateDir, $binDir)) { [IO.Directory]::CreateDirectory($dir) | Out-Null }
    Get-ChildItem -LiteralPath $sourceDir -Filter '*.ps1' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $sandbox }
    Copy-Item -LiteralPath (Join-Path $sourceDir '.env.example') -Destination $sandbox
    $compiler = Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $framework = Split-Path -Parent $compiler
    $fakeDocker = Join-Path $binDir 'docker.exe'
    & $compiler /nologo ('/out:' + $fakeDocker) ('/reference:' + (Join-Path $framework 'System.Web.Extensions.dll')) (Join-Path $PSScriptRoot 'fake-docker.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile the test-only Docker fixture.' }
    $env:PATH = $binDir + [IO.Path]::PathSeparator + $env:PATH
    $env:ENV_FILE = Join-Path $sandbox '.env'
    $env:TDAI_DEPLOY_TEST_STATE = $stateDir
    $env:PULL = '0'
    # Use an ephemeral local endpoint for admin initialization and LLM probes.
    $listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback), 0
    $listener.Start(); $httpPort = $listener.LocalEndpoint.Port; $listener.Stop()
    $server = Start-Process -FilePath $fakeDocker -ArgumentList @('serve', $httpPort) -WindowStyle Hidden -PassThru
    for ($i = 0; $i -lt 100 -and -not (Test-Path -LiteralPath (Join-Path $stateDir 'server-ready')); $i++) { Start-Sleep -Milliseconds 50 }
    Assert-True (Test-Path -LiteralPath (Join-Path $stateDir 'server-ready')) 'Local HTTP fixture started'
    Copy-Item -LiteralPath (Join-Path $sandbox '.env.example') -Destination $env:ENV_FILE
    . (Join-Path $sandbox '_lib.ps1')
    Import-DeployEnv
    Assert-True ((Get-Setting 'MEMORY_LLM_BASE_URL') -eq 'REPLACE_ME') 'Template inline comments are excluded'
    Assert-True ($script:Settings.ContainsKey('MEMORY_CORE_GATEWAY_API_KEY') -and (Get-Setting 'MEMORY_CORE_GATEWAY_API_KEY' 'local') -eq '') 'Explicit empty gateway key stays empty'
    [IO.File]::AppendAllText($env:ENV_FILE, "`r`nCOMMENT_EMPTY=    # comment`r`n" + 'export LITERAL_VALUE=''$(throw "must not execute") # literal''' + "`r`n")
    Import-DeployEnv
    Assert-True ((Get-Setting 'COMMENT_EMPTY' 'fallback') -eq '' -and (Get-Setting 'LITERAL_VALUE') -eq '$(throw "must not execute") # literal') 'Empty comments, single quotes and literal command text are parsed without evaluation'
    $secret = 'test-$dollar#hash "quotes" C:\keys\token & more'
    Set-DeploySetting 'MEMORY_LLM_API_KEY' $secret
    Set-DeploySetting 'MEMORY_LLM_BASE_URL' "http://localhost:$httpPort/v1"
    Set-DeploySetting 'MEMORY_LLM_MODEL' 'mock-model'
    Set-DeploySetting 'PROXY_UPSTREAM_URL' "http://localhost:$httpPort/v1"
    Set-DeploySetting 'PROXY_UPSTREAM_API_KEY' $secret
    Set-DeploySetting 'PROXY_UPSTREAM_MODEL' 'mock-model'
    Set-DeploySetting 'MEMORY_CORE_PORT' ([string]$httpPort)
    # The HTTP fixture deliberately occupies the Core port. Treat it like a running managed container.
    [IO.File]::WriteAllText((Join-Path $stateDir 'containers.json'), ('{"tdai-memory-core":["-p","' + $httpPort + ':8420"]}'))
    Import-DeployEnv
    Assert-True ((Get-Setting 'MEMORY_LLM_API_KEY') -ceq $secret) 'Quotes, hashes, dollars, spaces and backslashes survive .env round-trip'
    $beforeEnv = [Environment]::GetEnvironmentVariable('LLM_API_KEY')
    $verifyOutput = Run-Entry 'verify.ps1'
    Assert-True ((Count-Runs) -eq 0 -and $verifyOutput -match 'Preflight passed') 'Preflight checks LLM without starting containers'

    $firstOutput = Run-Entry 'start-all.ps1' @('-NonInteractive', '-SkipLlm')
    Assert-True ((Count-Runs) -eq 3 -and $firstOutput -match 'All services are ready') 'One command starts Core, Hub and Proxy in order'
    $runs = @((Read-DockerLog) | Where-Object { $_.argv[0] -eq 'run' })
    Assert-True ((($runs | ForEach-Object { $_.argv[3] }) -join ',') -eq 'tdai-memory-core,tdai-memory-hub,tdai-proxy') 'Start order matches dependency order'
    $core = Get-Content -LiteralPath (Join-Path $sandbox '.memory-core-config/tdai-gateway.yaml') -Raw -Encoding UTF8 | ConvertFrom-Json
    $proxy = Get-Content -LiteralPath (Join-Path $sandbox '.proxy-config/config.yaml') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($core.llm.apiKey -ceq $secret -and $proxy.upstream.apiKey -ceq $secret) 'Generated YAML preserves special characters'
    $configBytes = [IO.File]::ReadAllBytes((Join-Path $sandbox '.proxy-config/config.yaml'))
    Assert-True (-not ($configBytes[0] -eq 239 -and $configBytes[1] -eq 187 -and $configBytes[2] -eq 191)) 'Container config is UTF-8 without BOM'
    Assert-True ($core.memory.promptMode -eq 'code' -and $proxy.auth.enabled -and $proxy.sessionInit.enabled -and $proxy.tdai.enabled) 'Default memory mode and full-stack switches match Bash deployment'
    Assert-True ($core.memory.persona.triggerMode -eq 'current' -and -not $core.memory.persona.jev) 'JEV remains disabled by default'
    Assert-True ($runs[0].argv -contains ((Join-Path $sandbox '.memory-core-config/tdai-gateway.yaml') + ':/data/config/tdai-gateway.yaml:ro')) 'Docker receives a single intact bind argument for a Chinese path with spaces and brackets'
    Assert-True ($runs[1].environment.LLM_API_KEY -ceq $secret -and ($runs[1].argv -join ' ') -notmatch [regex]::Escape($secret)) 'Docker inherits exact credentials without embedding them in argv'
    Assert-True ($runs[0].environment.TDAI_GATEWAY_API_KEY -eq '' -and $runs[1].environment.REMOTE_INSTANCE_KEY -eq '') 'Empty internal credential is consistent across services'
    Assert-True ($runs[1].environment.KNOWLEDGE_SERVICE_KEY -match '^ks-svc-' -and $runs[1].environment.KNOWLEDGE_SERVICE_KEY -eq $runs[1].environment.KNOWLEDGE_AUTH_TOKEN) 'Hub shares one generated Knowledge service key'
    $keyFile = Join-Path $sandbox '.admin-key'
    $firstKey = [IO.File]::ReadAllText($keyFile)
    Assert-True ($firstKey -match '^sk-mem-[a-f0-9]{32}$') 'Admin key is generated and verified against the HTTP API'
    $secondOutput = Run-Entry 'start-all.ps1' @('-NonInteractive', '-SkipLlm')
    Assert-True ([IO.File]::ReadAllText($keyFile) -ceq $firstKey) 'Admin key survives restart and HTTP 409'
    $lastHub = @((Read-DockerLog) | Where-Object { $_.argv[0] -eq 'run' -and $_.argv -contains 'tdai-memory-hub' })[-1]
    Assert-True ($lastHub.environment.KNOWLEDGE_SERVICE_KEY -eq $runs[1].environment.KNOWLEDGE_SERVICE_KEY) 'Knowledge service key survives restart'
    Run-Entry 'stop-all.ps1' | Out-Null
    Assert-True ((Test-Path -LiteralPath $keyFile) -and @((Read-DockerLog) | Where-Object { $_.argv[0] -eq 'volume' -and $_.argv[1] -eq 'rm' }).Count -eq 0) 'Normal stop preserves volumes and credentials'
    Assert-True ([Environment]::GetEnvironmentVariable('LLM_API_KEY') -ceq $beforeEnv) 'Deployment does not change caller credentials'

    # Negative paths must not run later components or announce success.
    Set-Flag 'daemon-down'
    $output = Run-Entry 'start-all.ps1' @('-NonInteractive') $false
    Assert-True ($output -match 'Start Docker Desktop' -and $output -notmatch 'All services are ready') 'Unavailable engine fails with an actionable message'
    Clear-Flag 'daemon-down'
    Set-Flag 'windows-engine'
    $output = Run-Entry 'verify.ps1' @('-SkipLlm') $false
    Assert-True ($output -match 'Linux containers') 'Windows-container engine is rejected'
    Clear-Flag 'windows-engine'
    [IO.File]::WriteAllText((Join-Path $stateDir 'containers.json'), ('{"tdai-memory-core":["-p","' + $httpPort + ':8420"]}'))
    Set-Flag 'fail-run' 'tdai-memory-core'
    $before = Count-Runs
    $output = Run-Entry 'start-all.ps1' @('-NonInteractive', '-SkipLlm') $false
    Assert-True ((Count-Runs) -eq ($before + 1) -and $output -match 'exit 17' -and $output -notmatch 'All services are ready') 'Nonzero Docker run stops the stack before Hub/Proxy'
    Clear-Flag 'fail-run'
    Set-Flag 'unhealthy' 'tdai-memory-core'
    $output = Run-Entry 'start-memory-core.ps1' @() $false
    Assert-True ($output -match 'synthetic container log' -and $output -match 'did not become healthy') 'Failed healthcheck shows logs and fails'
    Clear-Flag 'unhealthy'
    Set-Flag 'fail-init'
    $output = Run-Entry 'start-memory-core.ps1' @() $false
    Assert-True ($output -match 'initialization failed') 'Admin initialization failure is fatal'
    Clear-Flag 'fail-init'
    [IO.File]::WriteAllText($keyFile, '')
    $output = Run-Entry 'start-memory-core.ps1' @() $false
    Assert-True ($output -match 'Admin already exists') 'Existing admin with missing key is not reported as ready'
    [IO.File]::WriteAllText($keyFile, $firstKey)
    Set-DeploySetting 'PROXY_PORT' (Get-Setting 'PANEL_PORT')
    $output = Run-Entry 'verify.ps1' @('-SkipLlm') $false
    Assert-True ($output -match 'Multiple services use port') 'Duplicate configured ports fail preflight'
    Set-DeploySetting 'PROXY_PORT' '8096'
    Set-Flag 'fail-llm'
    $output = Run-Entry 'verify.ps1' @() $false
    Assert-True ($output -match 'HTTP 401') 'Invalid LLM credentials fail preflight'
    Clear-Flag 'fail-llm'
    Set-DeploySetting 'MEMORY_CORE_STORE_MODE' 'mongodb'
    Run-Entry 'start-memory-core.ps1' | Out-Null
    $mongoRun = @((Read-DockerLog) | Where-Object { $_.argv[0] -eq 'run' -and $_.argv -contains 'tdai-mongo-local' })[-1]
    $mongoCore = @((Read-DockerLog) | Where-Object { $_.argv[0] -eq 'run' -and $_.argv -contains 'tdai-memory-core' })[-1]
    $mongoProbe = @((Read-DockerLog) | Where-Object { $_.argv[0] -eq 'exec' })[-1]
    Assert-True ($mongoRun.argv -contains 'mongo-local-db:/data/db' -and $mongoCore.environment.MONGODB_ENDPOINT -eq 'mongodb://mongo-search:27017/?directConnection=true' -and $mongoCore.environment.TDAI_METADATA_MONGO_URI -eq $mongoCore.environment.MONGODB_ENDPOINT -and $mongoProbe.argv -contains "if (db.adminCommand('hello').isWritablePrimary === true) quit(0); else quit(1)") 'Local Mongo wiring retains volumes and an intact primary-election probe'
    Set-DeploySetting 'MONGODB_ENDPOINT' 'mongodb://external.test:27017/?directConnection=true'
    $mongoRunsBefore = @((Read-DockerLog) | Where-Object { $_.argv[0] -eq 'run' -and $_.argv -contains 'tdai-mongo-local' }).Count
    Run-Entry 'start-memory-core.ps1' | Out-Null
    $mongoCore = @((Read-DockerLog) | Where-Object { $_.argv[0] -eq 'run' -and $_.argv -contains 'tdai-memory-core' })[-1]
    Assert-True ($mongoCore.environment.MONGODB_ENDPOINT -eq 'mongodb://external.test:27017/?directConnection=true' -and @((Read-DockerLog) | Where-Object { $_.argv[0] -eq 'run' -and $_.argv -contains 'tdai-mongo-local' }).Count -eq $mongoRunsBefore) 'External Mongo configuration does not create another local Mongo container'
    Set-DeploySetting 'MEMORY_CORE_PERSONA_TRIGGER_MODE' 'jev'
    $before = Count-Runs
    $output = Run-Entry 'start-memory-core.ps1' @() $false
    Assert-True ((Count-Runs) -eq $before -and $output -match 'TYPESAFE_API_KEY') 'Missing JEV configuration fails before replacing containers'
    Set-DeploySetting 'MEMORY_CORE_JEV_ENDPOINT' 'https://decision.test/v1/systemone'
    Set-DeploySetting 'MEMORY_CORE_JEV_MODEL' 'test-jev-model'
    Set-DeploySetting 'TYPESAFE_API_KEY' 'synthetic-jev-key'
    Run-Entry 'start-memory-core.ps1' | Out-Null
    $jevConfigText = Get-Content -LiteralPath (Join-Path $sandbox '.memory-core-config/tdai-gateway.yaml') -Raw -Encoding UTF8
    $jevConfig = $jevConfigText | ConvertFrom-Json
    $jevRun = @((Read-DockerLog) | Where-Object { $_.argv[0] -eq 'run' -and $_.argv -contains 'tdai-memory-core' })[-1]
    Assert-True ($jevConfig.memory.persona.jev.apiKey -eq '${TYPESAFE_API_KEY}' -and $jevConfigText -notmatch 'synthetic-jev-key' -and $jevRun.environment.TYPESAFE_API_KEY -eq 'synthetic-jev-key') 'Opt-in JEV keeps the secret in the container environment instead of config or argv'
    Set-DeploySetting 'MEMORY_CORE_JEV_TIMEOUT_MS' '99'
    $output = Run-Entry 'start-memory-core.ps1' @() $false
    Assert-True ($output -match 'between 100 and 60000') 'Invalid JEV timeout fails early'
    Set-Flag 'fail-volume-rm'
    $output = Run-Entry 'stop-all.ps1' @('-Purge') $false
    Assert-True (Test-Path -LiteralPath $keyFile) 'Failed volume deletion keeps the admin key recoverable'
    Clear-Flag 'fail-volume-rm'
    Run-Entry 'stop-all.ps1' @('-Purge') | Out-Null
    Assert-True (-not (Test-Path -LiteralPath $keyFile) -and -not (Test-Path -LiteralPath (Join-Path $sandbox '.proxy-config/config.yaml'))) 'Explicit purge removes only generated credentials/config files'
    Write-Host "All $script:Passed checks passed on PowerShell $($PSVersionTable.PSVersion)."
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    foreach ($key in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnv[$key]) }
    # The resolved target must remain inside our uniquely created test directory.
    $resolved = [IO.Path]::GetFullPath($testDir)
    if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -match '^tdai-deploy-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
}
