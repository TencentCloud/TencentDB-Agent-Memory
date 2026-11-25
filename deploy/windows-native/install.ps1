param(
  [string]$InstallDir = "C:\tdai-memory",
  [string]$SettingsPath,
  [switch]$ConfigureOnly,
  [bool]$ConfigureFirewall = $true
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$scriptSource = Join-Path $PSScriptRoot "scripts"
if (-not (Test-Path -LiteralPath (Join-Path $scriptSource "Initialize-Configuration.ps1"))) {
  $scriptSource = $PSScriptRoot
}
. (Join-Path $scriptSource "lib\common.ps1")
. (Join-Path $scriptSource "service\New-ServiceDefinition.ps1")

if (-not $SettingsPath) {
  $SettingsPath = Join-Path $PSScriptRoot "config\settings.psd1"
}
if (-not (Test-Path -LiteralPath $SettingsPath)) {
  throw "Settings file not found. Copy config\settings.example.psd1 to config\settings.psd1 and edit it first."
}
if (-not $ConfigureOnly) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Service installation requires an elevated PowerShell console. Use -ConfigureOnly for process-mode validation."
  }
  Stop-NativeServiceSet
}

$layout = Get-NativeLayout -InstallDir $InstallDir
if ($layout.Root -eq [IO.Path]::GetFullPath($PSScriptRoot)) {
  throw "InstallDir must differ from the package directory."
}
[IO.Directory]::CreateDirectory($layout.Root) | Out-Null
Write-Host "正在复制程序文件到 $($layout.Root)……"
foreach ($component in @("MemoryCore", "MemoryKnowledge", "MemoryPanel", "MemoryProxy")) {
  Write-Host "正在复制 $component……"
  Invoke-Robocopy -Source (Join-Path $PSScriptRoot "app\$component") -Destination (Join-Path $layout.AppDir $component)
}
Write-Host "正在复制便携 Node.js 运行时……"
Invoke-Robocopy -Source (Join-Path $PSScriptRoot "runtime") -Destination (Join-Path $layout.Root "runtime")
Write-Host "正在复制 Windows 服务宿主……"
Invoke-Robocopy -Source (Join-Path $PSScriptRoot "service") -Destination $layout.ServiceDir
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot "licenses")) {
  Invoke-Robocopy -Source (Join-Path $PSScriptRoot "licenses") -Destination (Join-Path $layout.Root "licenses")
}
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot "LICENSE.txt")) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "LICENSE.txt") -Destination (Join-Path $layout.Root "LICENSE.txt") -Force
}
Write-Host "正在复制管理脚本……"
Invoke-Robocopy -Source $scriptSource -Destination (Join-Path $layout.Root "scripts") `
  -ExcludedDirectories @((Join-Path $scriptSource "out"), (Join-Path $scriptSource ".cache"), (Join-Path $scriptSource ".runtime"))
Write-Host "程序文件复制完成。"

if ($ConfigureOnly) {
  & (Join-Path $layout.Root "scripts\Initialize-Configuration.ps1") -InstallDir $layout.Root -SettingsPath $SettingsPath
  Write-Host "Configuration-only installation completed: $($layout.Root)"
  return
}

Write-Host "正在生成配置并设置敏感文件权限……"
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$aclRules = @(
  "/grant:r",
  "*${currentSid}:(OI)(CI)F",
  "*S-1-5-32-544:(OI)(CI)F",
  "*S-1-5-18:(OI)(CI)F",
  "*S-1-5-19:(OI)(CI)R"
)
[IO.Directory]::CreateDirectory($layout.ConfigDir) | Out-Null
Invoke-Icacls -Target $layout.ConfigDir -Arguments (@("/inheritance:r") + $aclRules)
foreach ($file in Get-ChildItem -LiteralPath $layout.ConfigDir -File) {
  Invoke-Icacls -Target $file.FullName -Arguments @("/inheritance:r", "/grant:r", "*${currentSid}:F", "*S-1-5-32-544:F", "*S-1-5-18:F", "*S-1-5-19:R")
}
& (Join-Path $layout.Root "scripts\Initialize-Configuration.ps1") -InstallDir $layout.Root -SettingsPath $SettingsPath

foreach ($path in @($layout.DataDir, $layout.LogDir, $layout.RunDir)) {
  Write-Host "正在设置数据目录权限：$path"
  Invoke-Icacls -Target $path -Arguments @("/inheritance:r", "/grant:r", "*${currentSid}:(OI)(CI)M", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "*S-1-5-19:(OI)(CI)M")
  # Keep existing files accessible on reinstall; inheritance-only recursive replacement leaves their DACLs empty.
  Invoke-Icacls -Target $path -Arguments @("/grant", "*${currentSid}:M", "*S-1-5-32-544:F", "*S-1-5-18:F", "*S-1-5-19:M", "/T")
}
foreach ($path in @($layout.AppDir, (Join-Path $layout.Root "runtime"), $layout.ServiceDir)) {
  Write-Host "正在递归设置服务账户对目录及全部子文件的读取权限（文件较多，可能需要数分钟）：$path"
  Invoke-Icacls -Target $path -Arguments @("/grant", "*S-1-5-19:(OI)(CI)RX", "/T")
}

if ($ConfigureFirewall) {
  Write-Host "正在配置四个组件的 Windows 防火墙入站规则……"
  & (Join-Path $layout.Root "scripts\Configure-Firewall.ps1") -InstallDir $layout.Root
} else {
  Write-Host "防火墙自动配置已关闭，正在清理本安装器以前创建的规则……"
  & (Join-Path $layout.Root "scripts\Configure-Firewall.ps1") -InstallDir $layout.Root -Remove
}

foreach ($name in @("TdaiMemoryCore", "TdaiMemoryKnowledge", "TdaiMemoryPanel", "TdaiMemoryProxy")) {
  Write-Host "正在准备 $name 服务程序……"
  New-NativeServiceDefinition -Layout $layout -Name $name
}

foreach ($name in @("TdaiMemoryCore", "TdaiMemoryKnowledge", "TdaiMemoryPanel", "TdaiMemoryProxy")) {
  if ($null -eq (Get-Service -Name $name -ErrorAction SilentlyContinue)) {
    Write-Host "正在注册 $name（LocalService，自动启动）……"
    $exe = Join-Path $layout.ServiceDir "$name.exe"
    & $exe --startup auto --username "NT AUTHORITY\LocalService" install
    if ($LASTEXITCODE -ne 0) {
      throw "pywin32 failed to install $name with exit code $LASTEXITCODE"
    }
  }
}
$serviceDeadline = [DateTime]::UtcNow.AddSeconds(30)
while (-not (Test-NativeServiceSet)) {
  if ([DateTime]::UtcNow -ge $serviceDeadline) {
    throw "Windows services were registered but did not become visible within 30 seconds."
  }
  Start-Sleep -Milliseconds 250
}
Write-Host "四个服务注册完成，正在依次启动并检查健康状态……"
& (Join-Path $layout.Root "scripts\start-all.ps1") -InstallDir $layout.Root
& (Join-Path $layout.Root "scripts\verify.ps1") -InstallDir $layout.Root
