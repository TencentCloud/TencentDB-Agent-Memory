param(
  [string]$InstallDir = (Split-Path -Parent $PSScriptRoot)
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\common.ps1")

$layout = Get-NativeLayout -InstallDir $InstallDir
if (-not (Test-Path -LiteralPath $layout.NodeExe)) {
  throw "Portable Node.js not found: $($layout.NodeExe)"
}
$environment = Read-NativeEnvironment -Path $layout.EnvironmentFile
$corePort = [int]$environment.Core.TDAI_GATEWAY_PORT
$knowledgePort = [int]$environment.Knowledge.PORT
$panelPort = [int]$environment.Panel.PORT
$proxyConfig = Join-Path $layout.ConfigDir "proxy.yaml"
$proxyPort = [int]((Get-Content -LiteralPath $proxyConfig -Raw | ConvertFrom-Json).server.port)

if (Test-NativeServiceSet) {
  Write-Host "正在启动 Core……"
  Start-Service -Name "TdaiMemoryCore"
  Wait-NativeHealth -Name "Core" -Url "http://127.0.0.1:$corePort/health" -TimeoutSeconds 90
  Initialize-NativeAdmin -Layout $layout -Port $corePort

  Write-Host "正在启动 Knowledge……"
  Start-Service -Name "TdaiMemoryKnowledge"
  Wait-NativeHealth -Name "Knowledge" -Url "http://127.0.0.1:$knowledgePort/health" -TimeoutSeconds 90
  Write-Host "正在启动 Panel……"
  Start-Service -Name "TdaiMemoryPanel"
  Wait-NativeHealth -Name "Panel" -Url "http://127.0.0.1:$panelPort/health" -TimeoutSeconds 90
  Write-Host "正在启动 Proxy……"
  Start-Service -Name "TdaiMemoryProxy"
  Wait-NativeHealth -Name "Proxy" -Url "http://127.0.0.1:$proxyPort/health" -TimeoutSeconds 90
  return
}

[IO.Directory]::CreateDirectory($layout.RunDir) | Out-Null
[IO.Directory]::CreateDirectory($layout.LogDir) | Out-Null
if (Test-Path -LiteralPath $layout.ProcessFile) {
  throw "A process registry already exists. Run stop-all.ps1 first: $($layout.ProcessFile)"
}

$started = @()
try {
  $core = Start-NativeComponent -Name "core" -Layout $layout -Environment $environment.Core `
    -WorkingDirectory (Join-Path $layout.AppDir "MemoryCore") -Arguments "--import tsx src/gateway/server.ts"
  $started += $core
  Save-NativeProcessRegistry -Layout $layout -Components $started
  Wait-NativeHealth -Name "Core" -Url "http://127.0.0.1:$corePort/health" -Process $core.Process -TimeoutSeconds 90
  Initialize-NativeAdmin -Layout $layout -Port $corePort

  $knowledgeEntry = Join-Path $layout.AppDir "MemoryKnowledge\dist\server.js"
  if (-not (Test-Path -LiteralPath $knowledgeEntry)) {
    $knowledgeEntry = Join-Path $layout.AppDir "MemoryKnowledge\dist\server.mjs"
  }
  $knowledge = Start-NativeComponent -Name "knowledge" -Layout $layout -Environment $environment.Knowledge `
    -WorkingDirectory (Join-Path $layout.AppDir "MemoryKnowledge") -Arguments "`"$knowledgeEntry`""
  $started += $knowledge
  Save-NativeProcessRegistry -Layout $layout -Components $started
  Wait-NativeHealth -Name "Knowledge" -Url "http://127.0.0.1:$knowledgePort/health" -Process $knowledge.Process -TimeoutSeconds 90

  $panel = Start-NativeComponent -Name "panel" -Layout $layout -Environment $environment.Panel `
    -WorkingDirectory (Join-Path $layout.AppDir "MemoryPanel") -Arguments "dist/index.js"
  $started += $panel
  Save-NativeProcessRegistry -Layout $layout -Components $started
  Wait-NativeHealth -Name "Panel" -Url "http://127.0.0.1:$panelPort/health" -Process $panel.Process -TimeoutSeconds 90

  $proxy = Start-NativeComponent -Name "proxy" -Layout $layout -Environment $environment.Proxy `
    -WorkingDirectory (Join-Path $layout.AppDir "MemoryProxy") `
    -Arguments "--import tsx/esm src/index.ts --config `"$proxyConfig`""
  $started += $proxy
  Save-NativeProcessRegistry -Layout $layout -Components $started
  Wait-NativeHealth -Name "Proxy" -Url "http://127.0.0.1:$proxyPort/health" -Process $proxy.Process -TimeoutSeconds 90
} catch {
  for ($index = $started.Count - 1; $index -ge 0; $index--) {
    $component = $started[$index]
    $process = Get-Process -Id $component.Id -ErrorAction SilentlyContinue
    if ($null -ne $process) {
      Stop-Process -Id $component.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -LiteralPath $layout.ProcessFile -Force -ErrorAction SilentlyContinue
  throw
}

Write-Host "All native processes are running. Panel: http://127.0.0.1:$panelPort/"
