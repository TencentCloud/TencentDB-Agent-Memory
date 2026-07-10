@echo off
REM TencentDB-Agent-Memory Windows 安装器（cmd.exe 入口）
REM
REM 启动 PowerShell 安装脚本。支持右键"以管理员身份运行"。
REM
REM 用法：
REM   install-memory-tencentdb.bat          普通安装
REM   install-memory-tencentdb.bat -Force   强制重装
REM   install-memory-tencentdb.bat -Repair  修复破损安装

powershell -ExecutionPolicy Bypass -File "%~dp0install-memory-tencentdb.ps1" %*
