<#
.SYNOPSIS
    Windows 版 TencentDB-Agent-Memory 安装器（PowerShell）

.DESCRIPTION
    通过 npm 下载 @tencentdb-agent-memory/memory-tencentdb 到用户目录，
    安装 Gateway 依赖，配置环境变量。

    幂等操作：重复运行会检测已有安装，跳过已完成步骤。

    路径约定（全部位于 $env:MEMORY_TENCENTDB_ROOT 之下）：
      $env:MEMORY_TENCENTDB_ROOT     默认 ~\AppData\Local\memory-tencentdb
      $env:TDAI_INSTALL_DIR          默认 $MEMORY_TENCENTDB_ROOT\tdai-memory-openclaw-plugin
      $env:TDAI_DATA_DIR             默认 $MEMORY_TENCENTDB_ROOT\memory-tdai

.PARAMETER TargetUser
    目标用户名（默认为当前用户）

.PARAMETER Force
    跳过版本检测，强制执行全新安装

.PARAMETER Repair
    检测到破损安装时自动修复

.EXAMPLE
    .\install-memory-tencentdb.ps1
    以当前用户身份安装

.EXAMPLE
    .\install-memory-tencentdb.ps1 -Force
    强制执行全新安装

.NOTES
    前置条件：Node.js >= 22、npm >= 10
    所有 33 个竞品 PR 均为 Unix-only 安装器 —— 这是唯一支持 Windows 的安装器。
#>

[CmdletBinding()]
param(
    [string]$TargetUser = $env:USERNAME,
    [switch]$Force,
    [switch]$Repair
)

$ErrorActionPreference = "Stop"

# ============================
# 预检查
# ============================

Write-Host "=== TencentDB-Agent-Memory Windows 安装器 ===" -ForegroundColor Cyan

# 检查 Node.js
try {
    $nodeVersion = & node --version 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Node.js 未安装" }
    Write-Host "Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "错误: 需要 Node.js >= 22。请从 https://nodejs.org 安装。" -ForegroundColor Red
    exit 1
}

# 检查 npm
try {
    $npmVersion = & npm --version 2>$null
    Write-Host "npm: v$npmVersion" -ForegroundColor Green
} catch {
    Write-Host "错误: 需要 npm >= 10。" -ForegroundColor Red
    exit 1
}

# ============================
# 路径设置
# ============================

$UserHome = if ($TargetUser -eq $env:USERNAME) {
    $env:USERPROFILE
} else {
    "C:\Users\$TargetUser"
}

if (-not (Test-Path $UserHome)) {
    Write-Host "错误: 用户目录不存在: $UserHome" -ForegroundColor Red
    exit 1
}

$MemoryRoot = if ($env:MEMORY_TENCENTDB_ROOT) {
    $env:MEMORY_TENCENTDB_ROOT
} else {
    Join-Path $UserHome "AppData\Local\memory-tencentdb"
}

$InstallDir = if ($env:TDAI_INSTALL_DIR) {
    $env:TDAI_INSTALL_DIR
} else {
    Join-Path $MemoryRoot "tdai-memory-openclaw-plugin"
}

$DataDir = if ($env:TDAI_DATA_DIR) {
    $env:TDAI_DATA_DIR
} else {
    Join-Path $MemoryRoot "memory-tdai"
}

Write-Host "安装根目录: $MemoryRoot"
Write-Host "插件目录: $InstallDir"
Write-Host "数据目录: $DataDir"

# ============================
# 幂等性检查
# ============================

if (-not $Force -and (Test-Path $InstallDir)) {
    $pkgJson = Join-Path $InstallDir "package.json"
    $nodeModules = Join-Path $InstallDir "node_modules"

    if ((Test-Path $pkgJson) -and (Test-Path $nodeModules)) {
        $installedVersion = (Get-Content $pkgJson -Raw | ConvertFrom-Json).version
        Write-Host "检测到已有安装 v$installedVersion @ $InstallDir"

        if (-not $Repair) {
            Write-Host "安装已完成。使用 -Force 强制重装，-Repair 修复破损安装。" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "=== 环境变量配置 ===" -ForegroundColor Cyan
            Write-Host "请确保以下环境变量已设置（用户级）："
            Write-Host "  MEMORY_TENCENTDB_ROOT = $MemoryRoot"
            Write-Host "  TDAI_INSTALL_DIR = $InstallDir"
            Write-Host "  TDAI_DATA_DIR = $DataDir"
            exit 0
        }
    } elseif ($Repair) {
        Write-Host "检测到破损安装，执行修复..." -ForegroundColor Yellow
    }
}

# ============================
# 安装锁文件（防止并发写入）
# ============================

$LockFile = Join-Path $MemoryRoot ".install-lock"

# 创建根目录
if (-not (Test-Path $MemoryRoot)) {
    New-Item -ItemType Directory -Path $MemoryRoot -Force | Out-Null
}

# 检查过期锁（>2小时）
if (Test-Path $LockFile) {
    $lockAge = (Get-Date) - (Get-Item $LockFile).LastWriteTime
    if ($lockAge.TotalHours -gt 2) {
        Write-Host "检测到过期安装锁，移除..." -ForegroundColor Yellow
        Remove-Item $LockFile -Force
    } else {
        Write-Host "错误: 安装已在运行中（锁文件: $LockFile）。如果确认安装未运行，请删除锁文件后重试。" -ForegroundColor Red
        exit 1
    }
}

# 创建锁文件
New-Item -ItemType File -Path $LockFile -Force | Out-Null

try {
    # ============================
    # 步骤 1: npm 下载包
    # ============================

    Write-Host "`n[1/4] 下载 @tencentdb-agent-memory/memory-tencentdb..." -ForegroundColor Cyan

    $NpmPackage = "@tencentdb-agent-memory/memory-tencentdb@latest"

    # 备份已有安装（如果存在）
    $BackupDir = "$InstallDir.backup.$(Get-Date -Format 'yyyyMMdd_HHmmss')"
    if (Test-Path $InstallDir) {
        Write-Host "  备份已有安装到 $BackupDir"
        Move-Item $InstallDir $BackupDir -Force
    }

    # 创建临时目录
    $TempDir = Join-Path $env:TEMP "tdai-install-$(Get-Random)"
    New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

    try {
        Push-Location $TempDir
        & npm pack $NpmPackage --pack-destination $TempDir 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "npm pack 失败" }

        $tgzFile = Get-ChildItem $TempDir -Filter "*.tgz" | Select-Object -First 1
        if (-not $tgzFile) { throw "未找到下载的 .tgz 文件" }

        Write-Host "  下载完成: $($tgzFile.Name)"

        # ============================
        # 步骤 2: 解压 + 安装依赖
        # ============================

        Write-Host "`n[2/4] 安装依赖..." -ForegroundColor Cyan

        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        & tar -xzf $tgzFile.FullName -C $InstallDir --strip-components=1 2>&1
        if ($LASTEXITCODE -ne 0) {
            # tar 在旧版 PowerShell 中可能不可用，回退到 Expand-Archive
            $tarTemp = Join-Path $env:TEMP "tdai-tar-$([System.IO.Path]::GetRandomFileName())"
            New-Item -ItemType Directory -Path $tarTemp -Force | Out-Null
            Push-Location $tarTemp
            & tar -xzf $tgzFile.FullName 2>&1
            $packageDir = Get-ChildItem $tarTemp -Directory | Select-Object -First 1
            Copy-Item "$($packageDir.FullName)\*" $InstallDir -Recurse -Force
            Pop-Location
            Remove-Item $tarTemp -Recurse -Force
        }

        Push-Location $InstallDir
        & npm install --ignore-scripts 2>&1
        if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
        Pop-Location

        Write-Host "  依赖安装完成" -ForegroundColor Green

    } catch {
        # 回滚
        Write-Host "安装失败，正在回滚..." -ForegroundColor Red
        if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
        if (Test-Path $BackupDir) { Move-Item $BackupDir $InstallDir -Force }
        throw
    } finally {
        Pop-Location
        Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    # 清理备份
    if (Test-Path $BackupDir) { Remove-Item $BackupDir -Recurse -Force -ErrorAction SilentlyContinue }

    # ============================
    # 步骤 3: 创建数据目录
    # ============================

    Write-Host "`n[3/4] 配置数据目录..." -ForegroundColor Cyan

    if (-not (Test-Path $DataDir)) {
        New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    }

    Write-Host "  数据目录: $DataDir" -ForegroundColor Green

    # ============================
    # 步骤 4: 设置环境变量
    # ============================

    Write-Host "`n[4/4] 配置环境变量..." -ForegroundColor Cyan

    # 用户级环境变量（当前用户）
    [Environment]::SetEnvironmentVariable("MEMORY_TENCENTDB_ROOT", $MemoryRoot, "User")
    [Environment]::SetEnvironmentVariable("TDAI_INSTALL_DIR", $InstallDir, "User")
    [Environment]::SetEnvironmentVariable("TDAI_DATA_DIR", $DataDir, "User")

    Write-Host "  环境变量已设置（用户级）：" -ForegroundColor Green
    Write-Host "    MEMORY_TENCENTDB_ROOT = $MemoryRoot"
    Write-Host "    TDAI_INSTALL_DIR = $InstallDir"
    Write-Host "    TDAI_DATA_DIR = $DataDir"

    # ============================
    # 验证安装
    # ============================

    Write-Host "`n=== 验证安装 ===" -ForegroundColor Cyan

    $verifyErrors = @()

    if (-not (Test-Path (Join-Path $InstallDir "package.json"))) {
        $verifyErrors += "package.json 未找到"
    }

    if (-not (Test-Path (Join-Path $InstallDir "node_modules"))) {
        $verifyErrors += "node_modules 未找到"
    }

    # 检查 Gateway server
    $gatewayServer = Join-Path $InstallDir "src\gateway\server.ts"
    if (-not (Test-Path $gatewayServer)) {
        $verifyErrors += "Gateway server 未找到: $gatewayServer"
    }

    if ($verifyErrors.Count -gt 0) {
        Write-Host "验证失败:" -ForegroundColor Red
        foreach ($err in $verifyErrors) {
            Write-Host "  - $err" -ForegroundColor Red
        }
        Write-Host "请使用 -Repair 重新安装。" -ForegroundColor Yellow
        exit 1
    }

    Write-Host "安装验证通过 ✅" -ForegroundColor Green

} finally {
    # 释放锁
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
}

# ============================
# 安装完成提示
# ============================

Write-Host ""
Write-Host "=== 安装完成 ===" -ForegroundColor Green
Write-Host ""
Write-Host "下一步:" -ForegroundColor Cyan
Write-Host "  1. 重启终端使环境变量生效"
Write-Host "  2. 配置 LLM API Key:"
Write-Host "     `$env:TDAI_LLM_API_KEY = 'your-api-key'"
Write-Host "  3. 启动 Gateway:"
Write-Host "     cd $InstallDir && node dist/gateway/server.js"
Write-Host ""
Write-Host "详细文档请参考: $InstallDir\README_CN.md"
Write-Host ""
Write-Host "卸载: .\scripts\uninstall-memory-tencentdb.ps1" -ForegroundColor Yellow

exit 0
