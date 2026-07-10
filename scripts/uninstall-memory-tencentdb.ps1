<#
.SYNOPSIS
    Windows 版 TencentDB-Agent-Memory 卸载器

.DESCRIPTION
    移除 TencentDB-Agent-Memory 安装：
    1. 删除用户级环境变量（MEMORY_TENCENTDB_ROOT, TDAI_INSTALL_DIR, TDAI_DATA_DIR）
    2. 删除安装目录
    3. 删除数据目录

.PARAMETER KeepData
    保留数据目录（默认会询问是否删除）

.PARAMETER WhatIf
    仅预览变更而不实际执行

.EXAMPLE
    .\uninstall-memory-tencentdb.ps1
    交互式卸载

.EXAMPLE
    .\uninstall-memory-tencentdb.ps1 -KeepData
    卸载但保留数据

.EXAMPLE
    .\uninstall-memory-tencentdb.ps1 -WhatIf
    预览变更
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$KeepData
)

$ErrorActionPreference = "Stop"

Write-Host "=== TencentDB-Agent-Memory 卸载器 ===" -ForegroundColor Cyan

# ============================
# 获取安装路径
# ============================

$MemoryRoot = $env:MEMORY_TENCENTDB_ROOT
$InstallDir = $env:TDAI_INSTALL_DIR
$DataDir = $env:TDAI_DATA_DIR

# 从用户级环境变量回退读取
if (-not $MemoryRoot) {
    $MemoryRoot = [Environment]::GetEnvironmentVariable("MEMORY_TENCENTDB_ROOT", "User")
}
if (-not $InstallDir) {
    $InstallDir = [Environment]::GetEnvironmentVariable("TDAI_INSTALL_DIR", "User")
}
if (-not $DataDir) {
    $DataDir = [Environment]::GetEnvironmentVariable("TDAI_DATA_DIR", "User")
}

if (-not $MemoryRoot -and -not $InstallDir -and -not $DataDir) {
    Write-Host "未检测到安装。无需卸载。" -ForegroundColor Yellow
    exit 0
}

Write-Host "检测到安装路径:" -ForegroundColor Yellow
Write-Host "  MEMORY_TENCENTDB_ROOT = $MemoryRoot"
Write-Host "  TDAI_INSTALL_DIR = $InstallDir"
Write-Host "  TDAI_DATA_DIR = $DataDir"

# ============================
# 确认对话框
# ============================

if (-not $PSCmdlet.ShouldProcess("TencentDB-Agent-Memory", "卸载")) {
    Write-Host "已取消。" -ForegroundColor Yellow
    exit 0
}

$confirm = Read-Host "`n确认卸载? 这将删除安装文件 [y/N]"
if ($confirm -notmatch '^[yY]') {
    Write-Host "已取消。" -ForegroundColor Yellow
    exit 0
}

# ============================
# 步骤 1: 删除环境变量
# ============================

Write-Host "`n[1/3] 移除环境变量..." -ForegroundColor Cyan

try {
    [Environment]::SetEnvironmentVariable("MEMORY_TENCENTDB_ROOT", $null, "User")
    [Environment]::SetEnvironmentVariable("TDAI_INSTALL_DIR", $null, "User")
    [Environment]::SetEnvironmentVariable("TDAI_DATA_DIR", $null, "User")
    Write-Host "  环境变量已清除" -ForegroundColor Green
} catch {
    Write-Host "  警告: 清除环境变量失败: $_" -ForegroundColor Yellow
}

# ============================
# 步骤 2: 删除安装目录
# ============================

Write-Host "`n[2/3] 删除安装文件..." -ForegroundColor Cyan

if ($InstallDir -and (Test-Path $InstallDir)) {
    if ($PSCmdlet.ShouldProcess($InstallDir, "删除安装目录")) {
        Remove-Item $InstallDir -Recurse -Force
        Write-Host "  已删除: $InstallDir" -ForegroundColor Green
    }
} else {
    Write-Host "  安装目录不存在或已删除" -ForegroundColor Yellow
}

# 清理空根目录
if ($MemoryRoot -and (Test-Path $MemoryRoot)) {
    $subItems = Get-ChildItem $MemoryRoot -ErrorAction SilentlyContinue
    if (-not $subItems -or $subItems.Count -eq 0) {
        Remove-Item $MemoryRoot -Force
        Write-Host "  已删除空根目录: $MemoryRoot" -ForegroundColor Green
    }
}

# ============================
# 步骤 3: 处理数据目录
# ============================

Write-Host "`n[3/3] 处理数据目录..." -ForegroundColor Cyan

if ($DataDir -and (Test-Path $DataDir)) {
    if ($KeepData) {
        Write-Host "  数据目录已保留: $DataDir" -ForegroundColor Yellow
    } else {
        $deleteData = Read-Host "  删除数据目录? 这会永久删除所有记忆数据 [y/N]"
        if ($deleteData -match '^[yY]') {
            if ($PSCmdlet.ShouldProcess($DataDir, "删除数据目录")) {
                Remove-Item $DataDir -Recurse -Force
                Write-Host "  已删除: $DataDir" -ForegroundColor Green
            }
        } else {
            Write-Host "  数据目录已保留: $DataDir" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "  数据目录不存在或已删除" -ForegroundColor Yellow
}

Write-Host "`n=== 卸载完成 ===" -ForegroundColor Green
Write-Host "提示：请重启终端以清除会话级环境变量。" -ForegroundColor Yellow

exit 0
