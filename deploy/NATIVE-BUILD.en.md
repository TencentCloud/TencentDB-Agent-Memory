# Native Windows / Linux Build and Installation

[简体中文](NATIVE-BUILD.zh-CN.md)

These scripts package the four TypeScript components with portable Node.js 22: Core (8420), Knowledge (8424), Panel (8125), and Proxy (8096). Target machines do not need Node.js, npm, or Python, and do not run `npm install`.

Four artifact types are supported:

| System | Portable directory | Single installation package |
| --- | --- | --- |
| Windows x64 | Run scripts directly or register Windows services manually | `Setup.exe`, with a graphical wizard and pywin32 services |
| Linux x64 | Run scripts directly, optionally with systemd | Native `.deb`, managed by systemd after installation |

PyInstaller is not an official Python installer. It is used only on the Windows build machine to package the graphical installer and pywin32 service host. All four application components remain Node.js programs. Linux does not use PyInstaller.

## Networking and firewall

All four components listen on `0.0.0.0` by default so other machines can reach them through the server's IP address or DNS name. Local health checks and internal callbacks continue to use `127.0.0.1`. The local Panel URL is `http://127.0.0.1:8125/`; remote clients must replace the loopback address with the server's actual IP address or DNS name.

Automatic firewall configuration is enabled by default. It handles only the four inbound TCP component ports. It never disables the firewall or creates an all-port allow rule:

- The Windows installer creates `TdaiMemory-Core-TCP-In`, `TdaiMemory-Knowledge-TCP-In`, `TdaiMemory-Panel-TCP-In`, and `TdaiMemory-Proxy-TCP-In`. Clear the firewall option on the settings page to disable automatic configuration and remove rules previously created by this installer. Uninstallation also removes these rules.
- Manual Windows service installation from a portable directory configures the same rules by default. Add `-ConfigureFirewall $false` to `install.ps1` if this is not wanted.
- Linux uses `CONFIGURE_FIREWALL=1` in `config/settings.env`. Set it to `0` to disable automatic configuration and remove rules previously created by this installer. systemd installation and root initialization apply the setting automatically. Unprivileged process mode does not elevate itself; follow the installation output and run `sudo ./scripts/configure-firewall.sh --root "$PWD"` when needed.
- Linux supports an already running UFW or firewalld instance. It does not enable a firewall that was previously inactive. If neither UFW nor firewalld is active, the script explicitly reports that no host firewall rules are required. Uninstallation removes the UFW application rule or firewalld service created by this installer.

Cloud security groups, router port forwarding, and upstream access controls are outside the installer's scope. Allow the four ports there separately when required. Protect Core administrator keys, User Keys, upstream credentials, and management endpoints when exposing services to other machines; restrict source IP addresses where appropriate.

The Windows wizard supports Simplified Chinese and English on its welcome page. Bold/blue messages indicate installation stages and progress, while indented gray lines are raw PowerShell or system command output. Empty lines are filtered. PowerShell child windows are hidden, and the completion page summarizes the installation directory, Panel URL, deployment mode, client model, services, and firewall state.

## LLM configuration and deployment modes

Native deployment uses the same two LLM parameter groups as the official deployment:

- **Memory group**: `Base URL`, `API Key`, `Model`, and `Protocol` (`openai` or `anthropic`). Core and Knowledge share this group. Generated Knowledge configuration uses `LLM_MODE=custom` and reads the Memory group directly, while Panel sets `KNOWLEDGE_LLM_BINDING_SYNC` to `0`.
- **Proxy group**: `Upstream Base URL`, `Upstream API Key`, and `Upstream Model`. The Windows installer reuses the Memory group for Proxy by default; clear this option to configure a separate upstream. `Upstream Model` is retained for settings and client connection hints. It is not written as an unsupported `upstream.model` runtime field.

The Windows installer selects **full mode** by default and requires the same fields as the official Docker startup scripts. **Basic mode without LLM** is also available as an explicit native option: model inputs are disabled, model-dependent features such as memory extraction are unavailable, and Proxy uses `http://127.0.0.1:18096` as an unconfigured local placeholder upstream. This does not connect a real model. The non-interactive Linux `.deb` starts in basic mode by default; set `DEPLOYMENT_MODE=full` after configuring real model endpoints.

Later model changes follow the official configuration lifecycle: **edit the settings file, regenerate configuration, and restart services**. The native packages do not add online Panel model configuration or hot reload. On Windows, edit `config/settings.psd1` under the installation directory, then run these commands from an elevated PowerShell console:

```powershell
C:\tdai-memory\scripts\stop-all.ps1 -InstallDir C:\tdai-memory
C:\tdai-memory\scripts\Initialize-Configuration.ps1 `
  -InstallDir C:\tdai-memory `
  -SettingsPath C:\tdai-memory\config\settings.psd1
C:\tdai-memory\scripts\start-all.ps1 -InstallDir C:\tdai-memory
```

See “Build and install the .deb package” for the corresponding Linux commands.

## 1. Windows: build and install Setup.exe (recommended)

The build machine requires 64-bit Windows, PowerShell 5.1+, Git, Python 3.11+ with tkinter, and network access. Python is used only to build the installer and service host. Scripts create an isolated environment in `.cache/installer-python` and do not modify global Python or the system Node.js installation.

From the source root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\deploy\windows-native\build-windows-installer.ps1
```

By default, this builds the complete portable directory, compresses it into the wizard payload, and generates:

```text
deploy\windows-native\out\TencentDB-Agent-Memory-Setup-x64.exe
deploy\windows-native\out\TencentDB-Agent-Memory-Setup-x64.exe.sha256
```

To reuse a portable directory just built from the same source:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\deploy\windows-native\build-windows-installer.ps1 -SkipPayloadBuild
```

Copy the EXE and SHA256 file to the target machine. Run the EXE, approve UAC, and follow Welcome, Settings, Install, and Finish. Full mode requires the Memory group Base URL, API key, model, and protocol. Proxy reuses the Memory group by default; clear this option to enter a separate URL, API key, and model. Basic mode without LLM does not require model settings. The firewall option is selected by default. The wizard shows extraction percentage and file count, component copy progress, recursive permission updates, firewall configuration, service registration, and health checks.

After installation, use Windows Settings, Apps, Installed apps to uninstall. This removes services and installer-created firewall rules while preserving configuration and data. An elevated terminal can also run:

```powershell
& 'C:\tdai-memory\TdaiMemorySetup.exe' --uninstall --root 'C:\tdai-memory'
```

Validate the embedded offline payload with:

```powershell
.\TencentDB-Agent-Memory-Setup-x64.exe --check-payload
```

## 2. Windows: build a portable directory

Build requirements are the same as in the previous section. From the source root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\deploy\windows-native\build-windows-x64.ps1
```

The script installs npm dependencies, compiles and type-checks all four components, downloads and verifies portable Node.js, builds the pywin32 service host, and generates:

```text
deploy\windows-native\out\TencentDB-Agent-Memory-windows-x64\
```

Use `-SkipNpmInstall` only after script-only changes when local dependencies and compiled files are known to be complete. Do not add it to routine builds.

### Run directly without Windows services

Copy the entire generated directory to the target Windows machine, then run:

```powershell
Copy-Item .\config\settings.example.psd1 .\config\settings.psd1
notepad .\config\settings.psd1
```

The template defaults to `DeploymentMode = "Full"`. Full mode requires `LlmBaseUrl`, `LlmApiKey`, `LlmModel`, and `LlmProtocol` under Core, plus `UpstreamUrl`, `UpstreamApiKey`, and `UpstreamModel` under Proxy. Enter identical values when Proxy reuses Memory. For basic mode without LLM, set `DeploymentMode` to `"Basic"`, clear the model credentials and names, set `Core.EnableExtraction` to `$false`, and set `Proxy.UpstreamUrl` to `http://127.0.0.1:18096`. Knowledge has no separate model fields and inherits the Core Memory group automatically.

Initialize configuration and start:

```powershell
.\scripts\Initialize-Configuration.ps1 `
  -InstallDir (Get-Location).Path `
  -SettingsPath (Resolve-Path .\config\settings.psd1).Path
.\scripts\start-all.ps1
.\scripts\verify.ps1
```

The local Panel URL is `http://127.0.0.1:8125/`. Components listen on `0.0.0.0` by default. Process mode does not change Windows Firewall; review Networking and firewall and check cloud security groups before remote access.

Stop without deleting data:

```powershell
.\scripts\stop-all.ps1
```

### Register Windows services from the portable directory

From an elevated PowerShell console in the generated directory:

```powershell
.\install.ps1 -InstallDir C:\tdai-memory `
  -SettingsPath (Resolve-Path .\config\settings.psd1).Path
```

The script copies files, generates configuration, registers and starts `TdaiMemoryCore`, `TdaiMemoryKnowledge`, `TdaiMemoryPanel`, and `TdaiMemoryProxy`, creates four inbound firewall rules by default, and runs health checks. Recursively updating permissions on program files can take several minutes. Add `-ConfigureFirewall $false` to disable automatic firewall configuration.

Remove services and firewall rules while preserving configuration and data:

```powershell
C:\tdai-memory\scripts\uninstall.ps1 -InstallDir C:\tdai-memory
```

Add `-Purge` only when configuration, SQLite data, and logs should also be deleted.

## 3. Linux: build and install the .deb package

On a Debian 12 x86_64 build machine, from the source root:

```bash
./deploy/linux-native/build-linux-deb.sh
```

This builds the complete portable directory by default and then uses `dpkg-deb` to generate:

```text
deploy/linux-native/out/tdai-memory_1.0.2_amd64.deb
deploy/linux-native/out/tdai-memory_1.0.2_amd64.deb.sha256
```

Reuse a newly generated portable directory:

```bash
./deploy/linux-native/build-linux-deb.sh --skip-payload-build
```

Install on a target Debian 12 x86_64 machine. Other Debian or Ubuntu versions require separate native-module compatibility testing:

```bash
sudo apt install ./tdai-memory_1.0.2_amd64.deb
```

The installation root is `/opt/tdai-memory`. The package creates the `tdai-memory` system user, generates configuration, registers and starts four systemd services, applies the firewall setting, runs health checks, and prints a Panel, deployment-mode, client-model, and listening-address summary. The initial installation uses basic mode without LLM by default. Edit `config/settings.env`, set `DEPLOYMENT_MODE=full`, fill in `CORE_LLM_BASE_URL`, `CORE_LLM_API_KEY`, `CORE_LLM_MODEL`, `CORE_LLM_PROTOCOL`, `PROXY_UPSTREAM_URL`, `PROXY_UPSTREAM_API_KEY`, and `PROXY_UPSTREAM_MODEL`, and set `CORE_ENABLE_EXTRACTION=1`. Use identical values when Proxy reuses Memory. Then regenerate and restart:

```bash
sudo $EDITOR /opt/tdai-memory/config/settings.env
sudo /opt/tdai-memory/scripts/install.sh
sudo systemctl restart tdai-memory.target
sudo /opt/tdai-memory/scripts/verify.sh
```

Common management commands:

```bash
sudo systemctl status tdai-memory.target
sudo systemctl restart tdai-memory.target
sudo systemctl stop tdai-memory.target
sudo systemctl start tdai-memory.target
sudo journalctl -u tdai-memory-core.service -n 100
```

Removal deletes systemd units and installer-created firewall rules before preserving or purging application data. Remove the package while preserving generated configuration, SQLite data, and logs:

```bash
sudo apt remove tdai-memory
```

Purge everything only when intended:

```bash
sudo apt purge tdai-memory
```

## 4. Linux: build a portable directory

Linux native modules must match the target platform. Build on Debian 12 x86_64 rather than cross-building on Windows. The build machine needs Git, curl, tar/xz, dpkg-deb, Python 3, and a C/C++ toolchain for native npm fallback compilation.

From the source root:

```bash
chmod +x deploy/linux-native/build-linux-*.sh
./deploy/linux-native/build-linux-x64.sh
```

Output directory:

```text
deploy/linux-native/out/TencentDB-Agent-Memory-linux-x64/
```

Copy the entire directory to the target Linux x86_64 machine, then configure and run:

```bash
cd /path/to/TencentDB-Agent-Memory-linux-x64
cp config/settings.example.env config/settings.env
chmod 600 config/settings.env
$EDITOR config/settings.env
./scripts/install.sh
./scripts/start-all.sh
./scripts/verify.sh
```

`start-all.sh` uses ordinary background processes. PIDs are stored in `run/`, and logs are stored in `logs/`. Unprivileged initialization does not modify the firewall; run `configure-firewall.sh` with sudo when requested by the installation output. Stop with:

```bash
./scripts/stop-all.sh
```

For startup at boot, switch to systemd after configuration initialization:

```bash
sudo ./scripts/stop-all.sh
sudo ./scripts/install-systemd.sh
sudo systemctl enable --now tdai-memory.target
sudo ./scripts/verify.sh
```

Remove the systemd units and installer-created firewall rules associated with this directory:

```bash
sudo ./scripts/install-systemd.sh --remove
```

## 5. Directories and build caches

- Configuration: `config/` under the installation directory. Protect `admin.key`, upstream keys, and `.env` files as sensitive data.
- Data: `data/` under the installation directory. SQLite is used by default; no external database is required.
- Logs and PIDs: process mode writes `logs/` and `run/` under the installation directory. In systemd mode, use `journalctl -u <service-name>`.
- `.cache/`: build-machine-only cache for portable Node.js, isolated Python, and PyInstaller temporary files. Do not copy it to target machines.
- `out/`: build output. Portable directories and single installation packages can be retained independently.
