import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import zipfile


def create_payload(package_dir, payload):
    walk_root = Path("\\\\?\\" + str(package_dir)) if os.name == "nt" else package_dir
    with zipfile.ZipFile(payload, "w", zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        for root, directories, files in os.walk(walk_root):
            directories.sort()
            files.sort()
            for filename in files:
                source = Path(root) / filename
                archive.write(source, source.relative_to(walk_root).as_posix())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    arguments = parser.parse_args()
    package_dir = arguments.package_dir.resolve()
    output_dir = arguments.output_dir.resolve()
    work_dir = arguments.work_dir.resolve()
    payload = work_dir / "payload.zip"
    work_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    create_payload(package_dir, payload)
    # https://tencentcloud.github.io/TencentDB-Agent-Memory/assets/tencentdb-agent-memory-icon-source.png
    icon = Path(__file__).resolve().parent.parent / "assets" / "tencentdb-agent-memory-icon.ico"
    if not icon.is_file():
        raise FileNotFoundError(f"Installer icon not found: {icon}")
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--onefile",
            "--windowed",
            "--uac-admin",
            "--noupx",
            "--icon",
            str(icon),
            "--name",
            "TencentDB-Agent-Memory-Setup-x64",
            "--distpath",
            str(output_dir),
            "--workpath",
            str(work_dir / "pyinstaller-work"),
            "--specpath",
            str(work_dir / "pyinstaller-spec"),
            "--add-data",
            f"{payload};.",
            "--add-data",
            f"{icon};.",
            str(Path(__file__).with_name("installer.py")),
        ],
        check=True,
    )
    setup = output_dir / "TencentDB-Agent-Memory-Setup-x64.exe"
    digest = hashlib.sha256()
    with setup.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    checksum = setup.with_suffix(setup.suffix + ".sha256")
    checksum.write_text(f"{digest.hexdigest()}  {setup.name}\n", encoding="ascii")
    print(f"Windows installer created: {setup}")


if __name__ == "__main__":
    main()
