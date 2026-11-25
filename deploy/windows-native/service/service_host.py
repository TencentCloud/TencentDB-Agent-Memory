import json
import logging
import os
import subprocess
import sys
import threading
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

import servicemanager
import win32event
import win32service
import win32serviceutil


COMPONENTS = {
    "TdaiMemoryCore": {
        "environment": "Core",
        "directory": "MemoryCore",
        "arguments": ["--import", "tsx", "src/gateway/server.ts"],
        "dependencies": [],
    },
    "TdaiMemoryKnowledge": {
        "environment": "Knowledge",
        "directory": "MemoryKnowledge",
        "arguments": [],
        "dependencies": ["TdaiMemoryCore"],
    },
    "TdaiMemoryPanel": {
        "environment": "Panel",
        "directory": "MemoryPanel",
        "arguments": ["dist/index.js"],
        "dependencies": ["TdaiMemoryKnowledge"],
    },
    "TdaiMemoryProxy": {
        "environment": "Proxy",
        "directory": "MemoryProxy",
        "arguments": [],
        "dependencies": ["TdaiMemoryPanel"],
    },
}


class NativeNodeService(win32serviceutil.ServiceFramework):
    _svc_description_ = "TencentDB Agent Memory native Windows component"

    def __init__(self, args):
        super().__init__(args)
        self.stop_event = threading.Event()
        self.stop_handle = win32event.CreateEvent(None, 0, 0, None)
        self.process = None
        self.root = Path(sys.executable).resolve().parent.parent
        self.logger = self._create_logger()

    def _create_logger(self):
        log_dir = self.root / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        logger = logging.getLogger(self._svc_name_)
        logger.setLevel(logging.INFO)
        if not logger.handlers:
            handler = RotatingFileHandler(
                log_dir / f"service-{self._svc_name_}.log",
                maxBytes=10 * 1024 * 1024,
                backupCount=8,
                encoding="utf-8",
            )
            handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
            logger.addHandler(handler)
        return logger

    def SvcStop(self):
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        self.stop_event.set()
        win32event.SetEvent(self.stop_handle)
        process = self.process
        if process and process.poll() is None:
            try:
                process.terminate()
            except OSError:
                pass

    def SvcShutdown(self):
        self.SvcStop()

    def _component_arguments(self):
        spec = COMPONENTS[self._svc_name_]
        if self._svc_name_ == "TdaiMemoryKnowledge":
            dist = self.root / "app" / "MemoryKnowledge" / "dist"
            entry = dist / "server.js"
            if not entry.exists():
                entry = dist / "server.mjs"
            return [str(entry)]
        if self._svc_name_ == "TdaiMemoryProxy":
            return [
                "--import",
                "tsx/esm",
                "src/index.ts",
                "--config",
                str(self.root / "config" / "proxy.yaml"),
            ]
        return spec["arguments"]

    def _start_process(self):
        spec = COMPONENTS[self._svc_name_]
        with (self.root / "config" / "environment.json").open("r", encoding="utf-8") as handle:
            environments = json.load(handle)
        environment = os.environ.copy()
        environment.update({key: str(value) for key, value in environments[spec["environment"]].items()})
        working_directory = self.root / "app" / spec["directory"]
        command = [str(self.root / "runtime" / "node" / "node.exe"), *self._component_arguments()]
        stdout_path = self.root / "logs" / f"{spec['environment'].lower()}.out.log"
        stderr_path = self.root / "logs" / f"{spec['environment'].lower()}.err.log"
        stdout = stdout_path.open("ab", buffering=0)
        stderr = stderr_path.open("ab", buffering=0)
        try:
            process = subprocess.Popen(
                command,
                cwd=working_directory,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP,
            )
        except Exception:
            stdout.close()
            stderr.close()
            raise
        return process, stdout, stderr

    def SvcDoRun(self):
        self.ReportServiceStatus(win32service.SERVICE_RUNNING)
        self.logger.info("Service started")
        while not self.stop_event.is_set():
            stdout = None
            stderr = None
            try:
                self.process, stdout, stderr = self._start_process()
                self.logger.info("Started Node.js process %s", self.process.pid)
                exit_code = self.process.wait()
                self.logger.warning("Node.js process exited with code %s", exit_code)
            except Exception:
                self.logger.exception("Failed to run Node.js process")
            finally:
                if stdout:
                    stdout.close()
                if stderr:
                    stderr.close()
            if not self.stop_event.wait(10):
                self.logger.info("Restarting Node.js process")
        self.logger.info("Service stopped")


def service_class(name):
    base = NativeNodeService
    return type(
        f"{name}Service",
        (base,),
        {
            "_svc_name_": name,
            "_svc_display_name_": f"TencentDB Agent Memory {name.removeprefix('TdaiMemory')}",
            "_svc_deps_": COMPONENTS[name]["dependencies"],
        },
    )


def main():
    name = Path(sys.executable).stem
    if name not in COMPONENTS:
        raise SystemExit(f"Rename the executable to one of: {', '.join(COMPONENTS)}")
    cls = service_class(name)
    if len(sys.argv) == 1:
        servicemanager.Initialize()
        servicemanager.PrepareToHostSingle(cls)
        servicemanager.StartServiceCtrlDispatcher()
    else:
        # Frozen services dispatch by executable name, not an importable PythonClass path.
        win32serviceutil.HandleCommandLine(cls, serviceClassString="")


if __name__ == "__main__":
    main()
