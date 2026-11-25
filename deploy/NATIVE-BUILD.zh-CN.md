# Windows / Linux 原生构建与安装

[English](NATIVE-BUILD.en.md)

这套脚本把四个 TypeScript 组件和便携 Node.js 22 一起发布：Core（8420）、Knowledge（8424）、Panel（8125）、Proxy（8096）。目标机器不需要安装 Node.js、npm、Python，也不需要执行 `npm install`。

支持四种产物：

| 系统 | 绿色目录 | 单个安装包 |
| --- | --- | --- |
| Windows x64 | 脚本直接运行，或手动注册 Windows 服务 | `Setup.exe`，图形向导安装并注册 pywin32 服务 |
| Linux x64 | 脚本直接运行，可选用 systemd | 原生 `.deb`，安装后由 systemd 管理 |

PyInstaller 不是 Python 官方安装器。这里只在 Windows 构建机上用它打包图形安装器和 pywin32 服务宿主，四个业务组件仍然是 Node.js 程序；Linux 不需要 PyInstaller。

## 网络与防火墙

四个组件默认监听 `0.0.0.0`，即允许其他机器通过本机 IP 或域名访问。本机健康检查和组件之间的内部回调仍使用 `127.0.0.1`。Panel 本机地址为 `http://127.0.0.1:8125/`，远程客户端应把回环地址替换为服务器实际 IP 或域名。

防火墙自动配置默认开启，只处理四个组件的入站 TCP 端口，不会关闭防火墙，也不会创建全端口放行规则：

- Windows 安装器创建 `TdaiMemory-Core-TCP-In`、`TdaiMemory-Knowledge-TCP-In`、`TdaiMemory-Panel-TCP-In`、`TdaiMemory-Proxy-TCP-In` 四条规则。配置页可取消“配置 Windows 防火墙入站规则”；取消后会同时清理本安装器以前创建的规则。卸载也会移除这些规则。
- Windows 绿色目录手动注册服务时，默认同样配置规则。不需要时给 `install.ps1` 增加 `-ConfigureFirewall $false`。
- Linux 在 `config/settings.env` 中通过 `CONFIGURE_FIREWALL=1` 开启，设为 `0` 时关闭并清理本安装器以前创建的规则。systemd 安装和普通 root 初始化会自动应用；普通用户进程模式不会擅自提权，可按安装输出用 `sudo ./scripts/configure-firewall.sh --root "$PWD"` 执行。
- Linux 支持已经运行的 UFW 和 firewalld。不会自动启用一个原本停用的防火墙；未检测到运行中的 UFW/firewalld 时会明确提示无需添加主机规则。卸载会清理本安装器创建的 UFW 应用规则或 firewalld 服务。

云安全组、路由器端口映射和上游访问控制不属于安装器管理范围，仍需单独放行上述端口。对外提供服务后，应妥善保护 Core 管理密钥、User Key、上游密钥和管理接口，必要时另外限制来源 IP。

Windows 安装向导首页可切换简体中文和 English。蓝色/粗体文本是安装阶段和进度，灰色缩进文本是 PowerShell 或系统命令的原始输出；空行会被过滤。PowerShell 子进程使用隐藏窗口，完成页显示安装目录、Panel 地址、运行模式、客户端模型、服务及防火墙摘要。

## 模型配置与运行模式

原生部署沿用官方的两组 LLM 参数：

- **Memory 组**：`Base URL`、`API Key`、`Model`、`Protocol`（`openai` 或 `anthropic`）。Core 和 Knowledge 共用这组配置；生成的 Knowledge 环境固定为 `LLM_MODE=custom`，直接读取 Memory 组，Panel 的 `KNOWLEDGE_LLM_BINDING_SYNC` 为 `0`。
- **Proxy 组**：`Upstream Base URL`、`Upstream API Key`、`Upstream Model`。Windows 安装器默认让 Proxy 复用 Memory 组，也可取消复用后填写另一组上游。`Upstream Model` 用于设置记录和客户端接入提示，不会写成 Proxy 运行时不存在的 `upstream.model` 字段。

Windows 安装器默认选择**完整模式**，两组必填项与官方 Docker 启动脚本一致。也可明确选择**无 LLM 基础模式**：模型输入会被禁用，记忆提取等模型功能不可用，Proxy 使用 `http://127.0.0.1:18096` 作为未配置的本机占位上游；这不代表已接入真实模型。Linux `.deb` 没有交互向导，首次默认以基础模式启动，配置实际模型后再切换为 `DEPLOYMENT_MODE=full`。

后续修改模型仍采用官方相同的配置生命周期：**修改设置文件 → 重新生成配置 → 重启服务**。原生包不新增 Panel 在线模型配置或热更新机制。Windows 修改安装目录下的 `config/settings.psd1` 后，在管理员 PowerShell 中依次执行下面的停止、配置生成和启动命令：

```powershell
C:\tdai-memory\scripts\stop-all.ps1 -InstallDir C:\tdai-memory
C:\tdai-memory\scripts\Initialize-Configuration.ps1 `
  -InstallDir C:\tdai-memory `
  -SettingsPath C:\tdai-memory\config\settings.psd1
C:\tdai-memory\scripts\start-all.ps1 -InstallDir C:\tdai-memory
```

Linux 的对应命令见“生成并安装 .deb”一节。

## 一、Windows：生成并安装 Setup.exe（推荐）

构建机需要 64 位 Windows、PowerShell 5.1+、Git、Python 3.11+（含 tkinter）和可用的网络连接。Python 只用于构建安装器和服务宿主，脚本会在 `.cache/installer-python` 创建隔离环境，不修改全局 Python，也不修改系统 Node.js。

在源码根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\deploy\windows-native\build-windows-installer.ps1
```

该命令默认先完整构建绿色目录，再压缩并嵌入安装向导，生成：

```text
deploy\windows-native\out\TencentDB-Agent-Memory-Setup-x64.exe
deploy\windows-native\out\TencentDB-Agent-Memory-Setup-x64.exe.sha256
```

如果刚才已经构建过同一源码的绿色目录，可复用它：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\deploy\windows-native\build-windows-installer.ps1 -SkipPayloadBuild
```

将 EXE 和 SHA256 文件复制到目标机器。双击 EXE，通过 UAC 后按“欢迎 → 配置 → 安装 → 完成”操作。默认完整模式需要填写 Memory 组的 Base URL、API Key、Model、Protocol；Proxy 默认复用 Memory 组，取消复用后需单独填写 URL、API Key 和 Model。选择无 LLM 基础模式时无需填写模型参数。防火墙开关默认勾选。安装界面会显示解包百分比、文件数、组件复制进度、递归权限设置、防火墙配置以及服务注册和健康检查结果。

安装完成后可从 Windows“设置 → 应用 → 已安装的应用”卸载；默认移除服务及安装器创建的防火墙规则，但保留配置和数据。也可在管理员终端执行：

```powershell
& 'C:\tdai-memory\TdaiMemorySetup.exe' --uninstall --root 'C:\tdai-memory'
```

安装包的离线负载自检命令为：

```powershell
.\TencentDB-Agent-Memory-Setup-x64.exe --check-payload
```

## 二、Windows：生成绿色目录

构建机要求与上一节相同。在源码根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\deploy\windows-native\build-windows-x64.ps1
```

脚本会依次安装 npm 依赖、编译和类型检查四个组件、下载并校验便携 Node.js、构建 pywin32 服务宿主，最后生成：

```text
deploy\windows-native\out\TencentDB-Agent-Memory-windows-x64\
```

以后只改了脚本、且本机依赖和编译文件仍完整时，才使用 `-SkipNpmInstall` 跳过依赖安装；日常构建不要加。

### 直接使用绿色目录，不安装服务

把整个生成目录复制到目标 Windows 机器，进入该目录：

```powershell
Copy-Item .\config\settings.example.psd1 .\config\settings.psd1
notepad .\config\settings.psd1
```

模板默认 `DeploymentMode = "Full"`。完整模式需填写 Core 下的 `LlmBaseUrl`、`LlmApiKey`、`LlmModel`、`LlmProtocol`，以及 Proxy 下的 `UpstreamUrl`、`UpstreamApiKey`、`UpstreamModel`；两组相同时手动填写相同值。若只需无 LLM 基础模式，将 `DeploymentMode` 改为 `"Basic"`，清空两组模型参数，把 `Core.EnableExtraction` 设为 `$false`，并将 `Proxy.UpstreamUrl` 设为 `http://127.0.0.1:18096`。Knowledge 不需要单独的模型字段，会自动继承 Core 的 Memory 组配置。

然后初始化配置并启动：

```powershell
.\scripts\Initialize-Configuration.ps1 `
  -InstallDir (Get-Location).Path `
  -SettingsPath (Resolve-Path .\config\settings.psd1).Path
.\scripts\start-all.ps1
.\scripts\verify.ps1
```

Panel 本机地址为 `http://127.0.0.1:8125/`。四个组件默认监听 `0.0.0.0`；普通进程模式不会修改 Windows 防火墙，远程访问前需按“网络与防火墙”一节检查主机防火墙和云安全组。

停止但不删除数据：

```powershell
.\scripts\stop-all.ps1
```

### 绿色目录手动注册 Windows 服务

在**管理员 PowerShell** 中，从生成目录执行：

```powershell
.\install.ps1 -InstallDir C:\tdai-memory `
  -SettingsPath (Resolve-Path .\config\settings.psd1).Path
```

安装脚本会复制文件、生成配置、注册并启动 `TdaiMemoryCore`、`TdaiMemoryKnowledge`、`TdaiMemoryPanel`、`TdaiMemoryProxy`，默认创建四条防火墙入站规则，最后执行健康检查。递归设置程序目录权限时文件较多，可能需要数分钟。不需要自动配置防火墙时，在安装命令末尾增加 `-ConfigureFirewall $false`。

卸载服务和防火墙规则但保留配置和数据：

```powershell
C:\tdai-memory\scripts\uninstall.ps1 -InstallDir C:\tdai-memory
```

只有确认要删除配置、SQLite 数据和日志时才加 `-Purge`。

## 三、Linux：生成并安装 .deb

在 Debian 12 x86_64 构建机的源码根目录执行：

```bash
./deploy/linux-native/build-linux-deb.sh
```

它默认先完整构建绿色目录，再调用 `dpkg-deb`，生成：

```text
deploy/linux-native/out/tdai-memory_1.0.2_amd64.deb
deploy/linux-native/out/tdai-memory_1.0.2_amd64.deb.sha256
```

复用刚生成的绿色目录：

```bash
./deploy/linux-native/build-linux-deb.sh --skip-payload-build
```

在目标 Debian 12 x86_64 机器上安装（其他 Debian/Ubuntu 版本需先验证原生模块兼容性）：

```bash
sudo apt install ./tdai-memory_1.0.2_amd64.deb
```

安装根目录固定为 `/opt/tdai-memory`。安装脚本会创建 `tdai-memory` 系统用户、生成配置、注册并启动四个 systemd 服务、应用防火墙开关，然后检查健康状态并输出 Panel、运行模式、客户端模型和监听地址摘要。首次安装默认使用无 LLM 基础模式。编辑 `config/settings.env`，设置 `DEPLOYMENT_MODE=full`，填写 `CORE_LLM_BASE_URL`、`CORE_LLM_API_KEY`、`CORE_LLM_MODEL`、`CORE_LLM_PROTOCOL`、`PROXY_UPSTREAM_URL`、`PROXY_UPSTREAM_API_KEY`、`PROXY_UPSTREAM_MODEL`，并设置 `CORE_ENABLE_EXTRACTION=1`；Proxy 复用 Memory 时两组填写相同值。随后重新生成配置并重启：

```bash
sudo $EDITOR /opt/tdai-memory/config/settings.env
sudo /opt/tdai-memory/scripts/install.sh
sudo systemctl restart tdai-memory.target
sudo /opt/tdai-memory/scripts/verify.sh
```

常用管理命令：

```bash
sudo systemctl status tdai-memory.target
sudo systemctl restart tdai-memory.target
sudo systemctl stop tdai-memory.target
sudo systemctl start tdai-memory.target
sudo journalctl -u tdai-memory-core.service -n 100
```

卸载时会移除 systemd 单元及本安装器创建的防火墙规则。保留生成的配置、SQLite 数据和日志：

```bash
sudo apt remove tdai-memory
```

确认全部删除时才执行：

```bash
sudo apt purge tdai-memory
```

## 四、Linux：生成绿色目录

Linux 原生模块必须与目标平台一致，因此请在 **Debian 12 x86_64 构建机**上执行，不要在 Windows 上交叉生成 Linux 包。构建机需要 Git、curl、tar/xz、dpkg-deb，以及 npm 原生模块回退编译所需的 Python 3 和 C/C++ 工具链。

在源码根目录执行：

```bash
chmod +x deploy/linux-native/build-linux-*.sh
./deploy/linux-native/build-linux-x64.sh
```

输出目录：

```text
deploy/linux-native/out/TencentDB-Agent-Memory-linux-x64/
```

将整个目录复制到目标 Linux x86_64 机器，然后配置并运行：

```bash
cd /path/to/TencentDB-Agent-Memory-linux-x64
cp config/settings.example.env config/settings.env
chmod 600 config/settings.env
$EDITOR config/settings.env
./scripts/install.sh
./scripts/start-all.sh
./scripts/verify.sh
```

`start-all.sh` 使用普通后台进程，PID 在 `run/`，日志在 `logs/`。普通用户初始化不会修改防火墙；需要时按输出用 sudo 执行 `configure-firewall.sh`。停止：

```bash
./scripts/stop-all.sh
```

需要开机自启时，可在初始化配置后改用 systemd：

```bash
sudo ./scripts/stop-all.sh
sudo ./scripts/install-systemd.sh
sudo systemctl enable --now tdai-memory.target
sudo ./scripts/verify.sh
```

移除这套目录对应的 systemd 单元和本安装器创建的防火墙规则：

```bash
sudo ./scripts/install-systemd.sh --remove
```

## 五、目录和缓存说明

- 配置：安装目录下 `config/`，其中 `admin.key`、上游 Key 和 `.env` 文件应按敏感信息保管。
- 数据：安装目录下 `data/`，默认使用 SQLite，不依赖外部数据库。
- 日志与 PID：普通进程模式写入安装目录下 `logs/`、`run/`；systemd 模式可用 `journalctl -u 服务名` 查看日志。
- `.cache/`：仅是构建机缓存，用于便携 Node.js、隔离 Python 和 PyInstaller 临时文件，不需要复制到目标机器。
- `out/`：构建产物；既可以保留绿色目录，也可以继续生成安装包，两者互不影响。
