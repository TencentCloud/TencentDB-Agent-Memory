import argparse
import base64
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import webbrowser
import winreg
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

import tkinter as tk
from tkinter import filedialog, messagebox, ttk


APP_NAME = "TencentDB Agent Memory"
VERSION = "1.0.2"
UNINSTALL_KEY = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\TdaiMemory"
LANGUAGE_NAMES = {"zh-CN": "简体中文", "en": "English"}
TRANSLATIONS = {
    "zh-CN": {
        "window_title": "TencentDB Agent Memory 安装向导",
        "language": "语言 / Language",
        "back": "< 上一步",
        "next": "下一步 >",
        "cancel": "取消",
        "close": "关闭",
        "finish": "完成",
        "browse": "浏览…",
        "welcome_title": "欢迎使用",
        "welcome_description": f"本向导将安装 {APP_NAME}，并注册四个原生 Windows 服务。",
        "welcome_body": "安装包已包含 Node.js、Python 服务宿主和全部依赖，目标机器无需另装运行环境。\n\n默认监听 0.0.0.0，对外提供 Core、Knowledge、Panel 和 Proxy 服务；防火墙开关可在下一页调整。配置和数据保存在你选择的安装目录。",
        "config_title": "安装配置",
        "config_description": "默认使用与官方一致的完整模式。也可选择无 LLM 基础模式，仅启动本地服务。",
        "deployment_mode": "运行模式",
        "full_mode": "完整模式（Memory、Knowledge 和 Proxy 使用 LLM）",
        "basic_mode": "无 LLM 基础模式（模型相关功能不可用）",
        "install_dir": "安装目录 *",
        "instance_name": "Panel 实例名称",
        "memory_group": "Memory 组（Core 与 Knowledge 共用）",
        "proxy_group": "Proxy 组（客户端请求上游）",
        "upstream_url": "Proxy Upstream Base URL *",
        "upstream_key": "Proxy Upstream API Key *",
        "upstream_model": "Proxy Upstream Model *",
        "core_url": "Memory LLM Base URL *",
        "core_key": "Memory LLM API Key *",
        "core_model": "Memory LLM Model *",
        "core_protocol": "Memory LLM Protocol *",
        "proxy_reuse": "Proxy 复用 Memory 组的 URL、API Key 和 Model",
        "firewall": "配置 Windows 防火墙入站规则（TCP 8420、8424、8125、8096）",
        "firewall_note": "默认开启，仅新增上述四个端口的允许规则，不会关闭防火墙。关闭开关时，请自行确认网络安全组和主机防火墙策略。",
        "start_install": "开始安装",
        "installing_title": "正在安装",
        "installing_description": "安装过程可能需要几分钟，请保持本窗口打开。",
        "log_legend": "阶段信息使用粗体/蓝色；缩进的灰色文本为 PowerShell 和系统命令的原始输出。",
        "complete_title": "安装完成",
        "complete_description": "四个服务已启动并通过健康检查。",
        "summary_title": "安装信息",
        "summary_directory": "安装目录",
        "summary_panel": "Panel 地址",
        "summary_services": "Windows 服务",
        "summary_services_value": "Core、Knowledge、Panel、Proxy：运行中",
        "summary_mode": "运行模式",
        "summary_model": "客户端模型",
        "full_mode_summary": "完整模式",
        "basic_mode_summary": "无 LLM 基础模式",
        "summary_firewall": "防火墙",
        "firewall_enabled": "已配置四个 TCP 入站允许规则",
        "firewall_disabled": "未自动配置，请自行检查网络访问策略",
        "network_note": "服务监听 0.0.0.0。局域网或公网客户端请使用本机实际 IP/域名访问；请妥善保护 User Key、上游密钥和管理接口。",
        "open_panel": "打开 Panel",
        "uninstall_title": "卸载",
        "uninstall_description": "将停止并移除四个 Windows 服务及本安装器创建的防火墙规则：\n{path}",
        "remove_services": "移除服务",
        "uninstall_done_title": "卸载完成",
        "uninstall_done": "服务和防火墙规则已移除，配置和数据仍保留。",
        "operation_failed": "操作失败",
        "invalid_config_title": "配置不完整",
        "required_fields": "请填写安装目录。",
        "invalid_memory_url": "Memory LLM Base URL 必须是完整的 HTTP(S) 地址。",
        "invalid_upstream": "Proxy Upstream Base URL 必须是完整的 HTTP(S) 地址。",
        "example_upstream": "请把示例地址替换为实际地址。",
        "incomplete_memory": "完整模式需要填写 Memory 组的 Base URL、API Key 和 Model。",
        "incomplete_proxy": "完整模式需要填写 Proxy 组的 Base URL、API Key 和 Model，或选择复用 Memory 组。",
        "choose_directory": "选择安装目录",
        "payload_missing": "安装包缺少内部负载：{path}",
        "unsafe_payload": "安装包包含不安全路径：{path}",
        "extract_start": "正在解压程序文件……",
        "extract_progress": "解包进度：{percentage}%（{completed}/{total} 个文件）",
        "install_services": "正在安装并配置 Windows 服务……",
        "script_failed": "安装脚本退出码为 {code}，请查看上方日志。",
        "clean_temp": "正在清理安装临时文件……",
        "save_uninstaller": "正在保存卸载程序并写入注册信息……",
        "installed": "安装完成。",
        "uninstall_script_failed": "卸载脚本退出码为 {code}。",
        "services_removed": "服务和防火墙规则已移除，配置和数据仍保留在安装目录。",
        "error_prefix": "错误：",
    },
    "en": {
        "window_title": "TencentDB Agent Memory Setup Wizard",
        "language": "Language / 语言",
        "back": "< Back",
        "next": "Next >",
        "cancel": "Cancel",
        "close": "Close",
        "finish": "Finish",
        "browse": "Browse…",
        "welcome_title": "Welcome",
        "welcome_description": f"This wizard installs {APP_NAME} and registers four native Windows services.",
        "welcome_body": "The package includes Node.js, the Python service host, and all dependencies. No additional runtime installation is required.\n\nServices listen on 0.0.0.0 by default. Core, Knowledge, Panel, and Proxy are available to other machines; the firewall option can be changed on the next page. Configuration and data are stored in the selected installation directory.",
        "config_title": "Installation Settings",
        "config_description": "Full mode matches the official configuration by default. Basic mode starts local services without LLM features.",
        "deployment_mode": "Deployment mode",
        "full_mode": "Full mode (Memory, Knowledge, and Proxy use an LLM)",
        "basic_mode": "Basic mode without LLM (model-dependent features unavailable)",
        "install_dir": "Installation directory *",
        "instance_name": "Panel instance name",
        "memory_group": "Memory group (shared by Core and Knowledge)",
        "proxy_group": "Proxy group (upstream for client requests)",
        "upstream_url": "Proxy Upstream Base URL *",
        "upstream_key": "Proxy Upstream API Key *",
        "upstream_model": "Proxy Upstream Model *",
        "core_url": "Memory LLM Base URL *",
        "core_key": "Memory LLM API Key *",
        "core_model": "Memory LLM Model *",
        "core_protocol": "Memory LLM Protocol *",
        "proxy_reuse": "Reuse the Memory group URL, API key, and model for Proxy",
        "firewall": "Configure Windows Firewall inbound rules (TCP 8420, 8424, 8125, 8096)",
        "firewall_note": "Enabled by default. Only allow rules for these four ports are added; the firewall itself is not disabled. If disabled, verify your network security group and host firewall policies yourself.",
        "start_install": "Install",
        "installing_title": "Installing",
        "installing_description": "Installation may take several minutes. Keep this window open.",
        "log_legend": "Stage messages use bold/blue text. Indented gray lines are raw output from PowerShell and system commands.",
        "complete_title": "Installation Complete",
        "complete_description": "All four services are running and passed their health checks.",
        "summary_title": "Installation Summary",
        "summary_directory": "Installation directory",
        "summary_panel": "Panel URL",
        "summary_services": "Windows services",
        "summary_services_value": "Core, Knowledge, Panel, Proxy: running",
        "summary_mode": "Deployment mode",
        "summary_model": "Client model",
        "full_mode_summary": "Full mode",
        "basic_mode_summary": "Basic mode without LLM",
        "summary_firewall": "Firewall",
        "firewall_enabled": "Four inbound TCP allow rules configured",
        "firewall_disabled": "Not configured automatically; check network access policies",
        "network_note": "Services listen on 0.0.0.0. LAN or Internet clients must use this machine's actual IP address or DNS name. Protect User Keys, upstream credentials, and management endpoints.",
        "open_panel": "Open Panel",
        "uninstall_title": "Uninstall",
        "uninstall_description": "This removes the four Windows services and the firewall rules created by this installer:\n{path}",
        "remove_services": "Remove Services",
        "uninstall_done_title": "Uninstall Complete",
        "uninstall_done": "Services and firewall rules were removed. Configuration and data were preserved.",
        "operation_failed": "Operation Failed",
        "invalid_config_title": "Incomplete Settings",
        "required_fields": "Enter the installation directory.",
        "invalid_memory_url": "The Memory LLM Base URL must be a complete HTTP(S) URL.",
        "invalid_upstream": "The Proxy Upstream Base URL must be a complete HTTP(S) URL.",
        "example_upstream": "Replace the example URL with the actual endpoint.",
        "incomplete_memory": "Full mode requires the Memory group Base URL, API key, and model.",
        "incomplete_proxy": "Full mode requires the Proxy group Base URL, API key, and model, or reuse of the Memory group.",
        "choose_directory": "Select Installation Directory",
        "payload_missing": "The installer payload is missing: {path}",
        "unsafe_payload": "The installer payload contains an unsafe path: {path}",
        "extract_start": "Extracting program files…",
        "extract_progress": "Extraction: {percentage}% ({completed}/{total} files)",
        "install_services": "Installing and configuring Windows services…",
        "script_failed": "The installation script exited with code {code}. Review the log above.",
        "clean_temp": "Removing temporary installation files…",
        "save_uninstaller": "Saving the uninstaller and registration information…",
        "installed": "Installation complete.",
        "uninstall_script_failed": "The uninstall script exited with code {code}.",
        "services_removed": "Services and firewall rules were removed. Configuration and data remain in the installation directory.",
        "error_prefix": "Error: ",
    },
}


def tr(language, key, **values):
    return TRANSLATIONS[language][key].format(**values)


def ps_string(value):
    return "'" + value.replace("'", "''") + "'"


def settings_text(values):
    extraction = "$true" if values["core_url"] else "$false"
    return f"""@{{
  DeploymentMode = '{values['deployment_mode']}'
  Core = @{{
    Host = '0.0.0.0'
    Port = 8420
    LlmBaseUrl = {ps_string(values['core_url'])}
    LlmApiKey = {ps_string(values['core_key'])}
    LlmModel = {ps_string(values['core_model'])}
    LlmProtocol = {ps_string(values['core_protocol'])}
    EnableExtraction = {extraction}
    PromptMode = 'code'
  }}
  Knowledge = @{{
    Host = '0.0.0.0'
    Port = 8424
  }}
  Panel = @{{
    Host = '0.0.0.0'
    Port = 8125
    InstanceId = 'default'
    InstanceName = {ps_string(values['instance_name'])}
  }}
  Proxy = @{{
    Host = '0.0.0.0'
    Port = 8096
    UpstreamUrl = {ps_string(values['upstream_url'])}
    UpstreamApiKey = {ps_string(values['upstream_key'])}
    UpstreamModel = {ps_string(values['upstream_model'])}
    EnableAuth = $true
    EnableTdai = $true
    EnableSessionInit = $false
  }}
}}
"""


def bundled_path(filename):
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    bundled = base / filename
    if bundled.is_file() or hasattr(sys, "_MEIPASS"):
        return bundled
    return Path(__file__).resolve().parent.parent / "assets" / filename


def payload_path():
    return bundled_path("payload.zip")


def extract_payload(destination, on_output=None, language="zh-CN"):
    archive = payload_path()
    if not archive.is_file():
        raise RuntimeError(tr(language, "payload_missing", path=archive))
    destination = Path(destination).resolve()
    if os.name == "nt":
        destination = Path("\\\\?\\" + str(destination))
    with zipfile.ZipFile(archive) as zipped:
        members = zipped.infolist()
        for member in members:
            path = PurePosixPath(member.filename)
            if path.is_absolute() or ".." in path.parts:
                raise RuntimeError(tr(language, "unsafe_payload", path=member.filename))
        total_files = sum(not member.is_dir() for member in members)
        total_bytes = sum(member.file_size for member in members)
        completed_files = 0
        completed_bytes = 0
        last_percentage = -5
        for member in members:
            zipped.extract(member, destination)
            if member.is_dir():
                continue
            completed_files += 1
            completed_bytes += member.file_size
            percentage = completed_bytes * 100 // total_bytes if total_bytes else 100
            if on_output and (percentage >= last_percentage + 5 or completed_files == total_files):
                on_output(tr(language, "extract_progress", percentage=percentage, completed=completed_files, total=total_files), "progress")
                last_percentage = percentage


def remove_tree(path):
    path = Path(path).resolve()
    if os.name == "nt":
        path = Path("\\\\?\\" + str(path))
    shutil.rmtree(path)


def register_uninstaller(install_dir):
    setup_copy = install_dir / "TdaiMemorySetup.exe"
    if Path(sys.executable).resolve() != setup_copy.resolve():
        shutil.copy2(sys.executable, setup_copy)
    with winreg.CreateKey(winreg.HKEY_LOCAL_MACHINE, UNINSTALL_KEY) as key:
        winreg.SetValueEx(key, "DisplayName", 0, winreg.REG_SZ, APP_NAME)
        winreg.SetValueEx(key, "DisplayVersion", 0, winreg.REG_SZ, VERSION)
        winreg.SetValueEx(key, "Publisher", 0, winreg.REG_SZ, APP_NAME)
        winreg.SetValueEx(key, "InstallLocation", 0, winreg.REG_SZ, str(install_dir))
        winreg.SetValueEx(key, "DisplayIcon", 0, winreg.REG_SZ, str(setup_copy))
        winreg.SetValueEx(
            key,
            "UninstallString",
            0,
            winreg.REG_SZ,
            f'"{setup_copy}" --uninstall --root "{install_dir}"',
        )


def run_powershell(script, arguments, on_output):
    encoded_arguments = base64.b64encode(
        json.dumps([str(script), *arguments], ensure_ascii=False).encode("utf-8")
    ).decode("ascii")
    command = [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-Command",
        "& { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; try { $nativeArgs = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TDAI_NATIVE_PS_ARGS)) | ConvertFrom-Json; $scriptPath = [string]$nativeArgs[0]; $scriptParameters = @{}; for ($index = 1; $index -lt $nativeArgs.Count; $index += 2) { $parameterName = ([string]$nativeArgs[$index]).TrimStart('-'); $scriptParameters[$parameterName] = $nativeArgs[$index + 1] }; & $scriptPath @scriptParameters } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 } }",
    ]
    environment = os.environ.copy()
    environment["TDAI_NATIVE_PS_ARGS"] = encoded_arguments
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW,
        env=environment,
    )
    for line in process.stdout:
        line = line.strip()
        if line:
            on_output(line, "detail")
    return process.wait()


def install(values, on_output):
    language = values["language"]
    install_dir = Path(values["install_dir"]).resolve()
    temp = Path(tempfile.mkdtemp(prefix="tdai-memory-setup-"))
    try:
        on_output(tr(language, "extract_start"))
        extract_payload(temp / "payload", on_output, language)
        payload = temp / "payload"
        settings = temp / "settings.psd1"
        settings.write_text(settings_text(values), encoding="utf-8-sig")
        on_output(tr(language, "install_services"))
        result = run_powershell(
            payload / "install.ps1",
            [
                "-InstallDir",
                str(install_dir),
                "-SettingsPath",
                str(settings),
                "-ConfigureFirewall",
                True if values["firewall"] else False,
            ],
            on_output,
        )
        if result != 0:
            raise RuntimeError(tr(language, "script_failed", code=result))
    finally:
        on_output(tr(language, "clean_temp"))
        remove_tree(temp)
    on_output(tr(language, "save_uninstaller"))
    register_uninstaller(install_dir)
    on_output(tr(language, "installed"))


def uninstall(install_dir, on_output, language):
    result = run_powershell(
        install_dir / "scripts" / "uninstall.ps1",
        ["-InstallDir", str(install_dir)],
        on_output,
    )
    if result != 0:
        raise RuntimeError(tr(language, "uninstall_script_failed", code=result))
    winreg.DeleteKey(winreg.HKEY_LOCAL_MACHINE, UNINSTALL_KEY)
    on_output(tr(language, "services_removed"))


class InstallerWindow:
    def __init__(self, uninstall_root=None):
        self.root = tk.Tk()
        self.language = "zh-CN"
        self.root.title(tr(self.language, "window_title"))
        icon = bundled_path("tencentdb-agent-memory-icon.ico")
        if icon.is_file():
            self.root.iconbitmap(default=str(icon))
        self.root.geometry("760x600")
        self.root.minsize(680, 520)
        self.uninstall_root = uninstall_root
        self.page = 0
        self.events = queue.Queue()
        self.completed_values = None
        self.firewall = tk.BooleanVar(value=True)
        self.deployment_mode = tk.StringVar(value="full")
        self.proxy_reuse = tk.BooleanVar(value=True)
        self.values = {
            "install_dir": tk.StringVar(value=r"C:\tdai-memory"),
            "instance_name": tk.StringVar(value="Local Windows"),
            "upstream_url": tk.StringVar(),
            "upstream_key": tk.StringVar(),
            "upstream_model": tk.StringVar(),
            "core_url": tk.StringVar(),
            "core_key": tk.StringVar(),
            "core_model": tk.StringVar(),
            "core_protocol": tk.StringVar(value="openai"),
        }
        self.container = ttk.Frame(self.root, padding=24)
        self.container.pack(fill="both", expand=True)
        self.navigation = ttk.Frame(self.root, padding=(24, 0, 24, 18))
        self.navigation.pack(fill="x")
        self.back_button = ttk.Button(self.navigation, command=self.go_back)
        self.back_button.pack(side="left")
        self.next_button = ttk.Button(self.navigation, command=self.go_next)
        self.next_button.pack(side="right")
        self.cancel_button = ttk.Button(self.navigation, command=self.root.destroy)
        self.cancel_button.pack(side="right", padx=8)
        if uninstall_root:
            self.show_uninstall()
        else:
            self.show_page()

    def t(self, key, **values):
        return tr(self.language, key, **values)

    def clear_container(self):
        for child in self.container.winfo_children():
            child.destroy()

    def add_heading(self, title, description):
        ttk.Label(self.container, text=title, font=("Segoe UI", 18, "bold")).pack(anchor="w")
        ttk.Label(self.container, text=description, wraplength=690).pack(anchor="w", pady=(8, 20))

    def add_language_selector(self):
        frame = ttk.Frame(self.container)
        frame.pack(fill="x", pady=(0, 18))
        ttk.Label(frame, text=self.t("language")).pack(side="left")
        self.language_combo = ttk.Combobox(
            frame,
            state="readonly",
            values=list(LANGUAGE_NAMES.values()),
            width=14,
        )
        self.language_combo.current(list(LANGUAGE_NAMES).index(self.language))
        self.language_combo.pack(side="left", padx=(10, 0))
        self.language_combo.bind("<<ComboboxSelected>>", self.change_language)

    def change_language(self, _event=None):
        self.language = list(LANGUAGE_NAMES)[self.language_combo.current()]
        self.root.title(self.t("window_title"))
        self.show_page()

    def configure_log(self):
        self.log.tag_configure("stage", font=("Segoe UI", 9, "bold"), spacing1=6, spacing3=2)
        self.log.tag_configure("progress", foreground="#1668b4", spacing1=2, spacing3=2)
        self.log.tag_configure("detail", foreground="#5b6573", lmargin1=20, lmargin2=20, font=("Consolas", 9))
        self.log.tag_configure("error", foreground="#b42318", font=("Segoe UI", 9, "bold"), spacing1=6)

    def show_page(self):
        self.clear_container()
        self.root.title(self.t("window_title"))
        self.back_button.configure(text=self.t("back"))
        self.cancel_button.configure(text=self.t("cancel"), command=self.root.destroy)
        self.back_button.state(["!disabled"])
        self.next_button.state(["!disabled"])
        self.cancel_button.state(["!disabled"])
        if self.page == 0:
            self.root.geometry("760x600")
            self.root.minsize(680, 520)
            self.add_language_selector()
            self.add_heading(self.t("welcome_title"), self.t("welcome_description"))
            ttk.Label(self.container, text=self.t("welcome_body"), wraplength=690).pack(anchor="w")
            self.back_button.state(["disabled"])
            self.next_button.configure(text=self.t("next"))
        elif self.page == 1:
            self.root.geometry("820x800")
            self.root.minsize(740, 700)
            self.add_heading(self.t("config_title"), self.t("config_description"))
            mode = ttk.LabelFrame(self.container, text=self.t("deployment_mode"), padding=(12, 8))
            mode.pack(fill="x", pady=(0, 10))
            ttk.Radiobutton(mode, text=self.t("full_mode"), variable=self.deployment_mode, value="full", command=self.update_config_state).pack(anchor="w")
            ttk.Radiobutton(mode, text=self.t("basic_mode"), variable=self.deployment_mode, value="basic", command=self.update_config_state).pack(anchor="w", pady=(4, 0))

            general = ttk.Frame(self.container)
            general.pack(fill="x", pady=(0, 10))
            for row, name in enumerate(("install_dir", "instance_name")):
                ttk.Label(general, text=self.t(name)).grid(row=row, column=0, sticky="w", pady=4, padx=(0, 12))
                ttk.Entry(general, textvariable=self.values[name], width=72).grid(row=row, column=1, sticky="ew", pady=4)
            ttk.Button(general, text=self.t("browse"), command=self.choose_directory).grid(row=0, column=2, padx=(8, 0))
            general.columnconfigure(1, weight=1)

            memory = ttk.LabelFrame(self.container, text=self.t("memory_group"), padding=(12, 8))
            memory.pack(fill="x", pady=(0, 10))
            self.memory_inputs = []
            for row, (name, secret) in enumerate((("core_url", False), ("core_key", True), ("core_model", False))):
                ttk.Label(memory, text=self.t(name)).grid(row=row, column=0, sticky="w", pady=4, padx=(0, 12))
                entry = ttk.Entry(memory, textvariable=self.values[name], show="*" if secret else "", width=66)
                entry.grid(row=row, column=1, sticky="ew", pady=4)
                self.memory_inputs.append(entry)
            ttk.Label(memory, text=self.t("core_protocol")).grid(row=3, column=0, sticky="w", pady=4, padx=(0, 12))
            protocol = ttk.Combobox(memory, textvariable=self.values["core_protocol"], values=("openai", "anthropic"), state="readonly", width=20)
            protocol.grid(row=3, column=1, sticky="w", pady=4)
            self.memory_inputs.append(protocol)
            memory.columnconfigure(1, weight=1)

            proxy = ttk.LabelFrame(self.container, text=self.t("proxy_group"), padding=(12, 8))
            proxy.pack(fill="x", pady=(0, 10))
            self.proxy_reuse_button = ttk.Checkbutton(proxy, text=self.t("proxy_reuse"), variable=self.proxy_reuse, command=self.update_config_state)
            self.proxy_reuse_button.grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 6))
            self.proxy_inputs = []
            for row, (name, secret) in enumerate((("upstream_url", False), ("upstream_key", True), ("upstream_model", False)), start=1):
                ttk.Label(proxy, text=self.t(name)).grid(row=row, column=0, sticky="w", pady=4, padx=(0, 12))
                entry = ttk.Entry(proxy, textvariable=self.values[name], show="*" if secret else "", width=66)
                entry.grid(row=row, column=1, sticky="ew", pady=4)
                self.proxy_inputs.append(entry)
            proxy.columnconfigure(1, weight=1)

            ttk.Checkbutton(self.container, text=self.t("firewall"), variable=self.firewall).pack(anchor="w", pady=(2, 4))
            ttk.Label(self.container, text=self.t("firewall_note"), wraplength=750, foreground="#5b6573").pack(anchor="w")
            self.update_config_state()
            self.next_button.configure(text=self.t("start_install"))
        elif self.page == 2:
            self.root.geometry("760x620")
            self.root.minsize(680, 520)
            self.add_heading(self.t("installing_title"), self.t("installing_description"))
            self.progress = ttk.Progressbar(self.container, mode="indeterminate")
            self.progress.pack(fill="x", pady=(0, 8))
            self.progress.start(12)
            ttk.Label(self.container, text=self.t("log_legend"), foreground="#5b6573").pack(anchor="w", pady=(0, 8))
            self.log = tk.Text(self.container, wrap="word", state="disabled", font=("Segoe UI", 9))
            self.log.pack(fill="both", expand=True)
            self.configure_log()
            self.back_button.state(["disabled"])
            self.next_button.state(["disabled"])
            self.cancel_button.state(["disabled"])
        elif self.page == 3:
            self.root.geometry("760x560")
            self.root.minsize(680, 540)
            self.add_heading(self.t("complete_title"), self.t("complete_description"))
            summary = ttk.LabelFrame(self.container, text=self.t("summary_title"), padding=16)
            summary.pack(fill="x", pady=(0, 16))
            values = self.completed_values or {"install_dir": "", "firewall": False}
            rows = [
                (self.t("summary_directory"), values["install_dir"]),
                (self.t("summary_panel"), "http://127.0.0.1:8125/  (0.0.0.0:8125)"),
                (self.t("summary_services"), self.t("summary_services_value")),
                (self.t("summary_mode"), self.t("full_mode_summary" if values["deployment_mode"] == "full" else "basic_mode_summary")),
                (self.t("summary_model"), values["upstream_model"] or "—"),
                (self.t("summary_firewall"), self.t("firewall_enabled" if values["firewall"] else "firewall_disabled")),
            ]
            for row, (label, value) in enumerate(rows):
                ttk.Label(summary, text=label, font=("Segoe UI", 9, "bold")).grid(row=row, column=0, sticky="nw", padx=(0, 16), pady=5)
                ttk.Label(summary, text=value, wraplength=500).grid(row=row, column=1, sticky="w", pady=5)
            summary.columnconfigure(1, weight=1)
            ttk.Label(self.container, text=self.t("network_note"), wraplength=690, foreground="#5b6573").pack(anchor="w")
            self.back_button.state(["disabled"])
            self.next_button.state(["!disabled"])
            self.next_button.configure(text=self.t("finish"))
            self.cancel_button.state(["!disabled"])
            self.cancel_button.configure(text=self.t("open_panel"), command=lambda: webbrowser.open("http://127.0.0.1:8125/"))

    def show_uninstall(self):
        self.clear_container()
        self.root.title(self.t("window_title"))
        self.back_button.configure(text=self.t("back"))
        self.cancel_button.configure(text=self.t("cancel"), command=self.root.destroy)
        self.add_heading(self.t("uninstall_title"), self.t("uninstall_description", path=self.uninstall_root))
        self.progress = ttk.Progressbar(self.container, mode="indeterminate")
        ttk.Label(self.container, text=self.t("log_legend"), foreground="#5b6573").pack(anchor="w", pady=(0, 8))
        self.log = tk.Text(self.container, wrap="word", state="disabled", font=("Segoe UI", 9))
        self.log.pack(fill="both", expand=True)
        self.configure_log()
        self.back_button.state(["disabled"])
        self.next_button.configure(text=self.t("remove_services"))
        self.next_button.state(["!disabled"])

    def update_config_state(self):
        basic = self.deployment_mode.get() == "basic"
        for widget in self.memory_inputs:
            if basic:
                widget.configure(state="disabled")
            elif isinstance(widget, ttk.Combobox):
                widget.configure(state="readonly")
            else:
                widget.configure(state="normal")
        self.proxy_reuse_button.configure(state="disabled" if basic else "normal")
        for widget in self.proxy_inputs:
            widget.configure(state="disabled" if basic or self.proxy_reuse.get() else "normal")

    def choose_directory(self):
        selected = filedialog.askdirectory(title=self.t("choose_directory"), parent=self.root)
        if selected:
            self.values["install_dir"].set(selected)

    def validate(self):
        values = {name: variable.get().strip() for name, variable in self.values.items()}
        if not values["install_dir"]:
            raise ValueError(self.t("required_fields"))
        values["deployment_mode"] = self.deployment_mode.get()
        values["proxy_reuse"] = bool(self.proxy_reuse.get())
        if values["deployment_mode"] == "basic":
            values.update({
                "core_url": "",
                "core_key": "",
                "core_model": "",
                "core_protocol": "openai",
                "upstream_url": "http://127.0.0.1:18096",
                "upstream_key": "",
                "upstream_model": "",
            })
        else:
            if not all(values[name] for name in ("core_url", "core_key", "core_model")):
                raise ValueError(self.t("incomplete_memory"))
            if values["proxy_reuse"]:
                values["upstream_url"] = values["core_url"]
                values["upstream_key"] = values["core_key"]
                values["upstream_model"] = values["core_model"]
            if not all(values[name] for name in ("upstream_url", "upstream_key", "upstream_model")):
                raise ValueError(self.t("incomplete_proxy"))
            for name, error in (("core_url", "invalid_memory_url"), ("upstream_url", "invalid_upstream")):
                parsed = urlparse(values[name])
                if parsed.scheme not in ("http", "https") or not parsed.netloc:
                    raise ValueError(self.t(error))
                if parsed.hostname == "llm-upstream.example.com":
                    raise ValueError(self.t("example_upstream"))
        values["firewall"] = bool(self.firewall.get())
        values["language"] = self.language
        return values

    def go_next(self):
        if self.uninstall_root:
            self.next_button.state(["disabled"])
            self.cancel_button.state(["disabled"])
            self.progress.pack(fill="x", pady=(0, 10), before=self.log)
            self.progress.start(12)
            self.run_worker(uninstall, {"install_dir": self.uninstall_root}, uninstall_mode=True)
            return
        if self.page == 0:
            self.page = 1
            self.show_page()
        elif self.page == 1:
            try:
                values = self.validate()
            except ValueError as error:
                messagebox.showerror(self.t("invalid_config_title"), str(error), parent=self.root)
                return
            self.completed_values = values.copy()
            self.page = 2
            self.show_page()
            self.run_worker(install, values)
        elif self.page == 3:
            self.root.destroy()

    def go_back(self):
        if self.page == 1:
            self.page = 0
            self.show_page()

    def append_log(self, text, kind="stage"):
        text = text.strip()
        if not text:
            return
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n", kind)
        self.log.see("end")
        self.log.configure(state="disabled")

    def run_worker(self, function, values, uninstall_mode=False):
        def emit(message, kind="stage"):
            self.events.put(("log", kind, message))

        def target():
            try:
                if uninstall_mode:
                    function(Path(values["install_dir"]), emit, self.language)
                else:
                    function(values, emit)
                self.events.put(("success", uninstall_mode))
            except Exception as error:
                self.events.put(("error", str(error)))

        threading.Thread(target=target, daemon=True).start()
        self.root.after(100, self.poll_events)

    def poll_events(self):
        try:
            while True:
                event = self.events.get_nowait()
                if event[0] == "log":
                    self.append_log(event[2], event[1])
                elif event[0] == "success":
                    if event[1]:
                        messagebox.showinfo(self.t("uninstall_done_title"), self.t("uninstall_done"), parent=self.root)
                        self.root.destroy()
                        return
                    self.page = 3
                    self.show_page()
                    return
                else:
                    self.progress.stop()
                    self.append_log(self.t("error_prefix") + event[1], "error")
                    messagebox.showerror(self.t("operation_failed"), event[1], parent=self.root)
                    self.cancel_button.state(["!disabled"])
                    self.cancel_button.configure(text=self.t("close"), command=self.root.destroy)
                    return
        except queue.Empty:
            pass
        self.root.after(100, self.poll_events)

    def run(self):
        self.root.mainloop()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-payload", action="store_true")
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--root")
    arguments = parser.parse_args()
    if arguments.check_payload:
        temporary = Path(tempfile.mkdtemp(prefix="tdai-payload-check-"))
        try:
            extract_payload(temporary)
        finally:
            remove_tree(temporary)
        print("Payload extraction passed.")
        return
    if arguments.uninstall and not arguments.root:
        parser.error("--uninstall requires --root")
    InstallerWindow(arguments.root if arguments.uninstall else None).run()


if __name__ == "__main__":
    main()
