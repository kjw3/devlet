#!/usr/bin/env python3
import configparser
import os
import shlex
import signal
import subprocess
import sys
import time
from pathlib import Path


def service_root() -> Path:
    home = Path(os.environ.get("HOME", "/tmp"))
    return home / ".devlet-services"


def pid_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def load_unit(unit_name: str) -> dict[str, object]:
    unit_path = Path.home() / ".config" / "systemd" / "user" / unit_name
    if not unit_path.is_file():
      raise FileNotFoundError(f"unit file not found: {unit_path}")

    parser = configparser.ConfigParser(interpolation=None, strict=False)
    parser.optionxform = str
    parser.read(unit_path)

    if not parser.has_section("Service"):
      raise ValueError(f"unit has no [Service] section: {unit_path}")

    service = parser["Service"]
    exec_start = service.get("ExecStart", "").strip()
    if not exec_start:
      raise ValueError(f"unit has no ExecStart: {unit_path}")

    working_directory = service.get("WorkingDirectory", "").strip() or str(Path.home())
    restart = service.get("Restart", "no").strip().lower() or "no"
    environment = []
    if parser.has_option("Service", "Environment"):
      raw_values = parser.get("Service", "Environment")
      for item in shlex.split(raw_values):
        if "=" in item:
          key, value = item.split("=", 1)
          environment.append((key, value))

    return {
      "path": unit_path,
      "exec_start": exec_start[1:] if exec_start.startswith("-") else exec_start,
      "working_directory": working_directory,
      "restart": restart,
      "environment": environment,
    }


def run_service(unit_name: str) -> int:
    svc_root = service_root()
    run_dir = svc_root / "run"
    log_dir = svc_root / "log"
    run_dir.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)

    unit = load_unit(unit_name)
    supervisor_pid_file = run_dir / f"{unit_name}.supervisor.pid"
    child_pid_file = run_dir / f"{unit_name}.pid"
    log_path = log_dir / f"{unit_name}.log"

    supervisor_pid_file.write_text(f"{os.getpid()}\n", encoding="utf-8")
    stop_requested = False
    child: subprocess.Popen[str] | None = None

    def handle_signal(signum, _frame):
        nonlocal stop_requested, child
        stop_requested = True
        if child and child.poll() is None:
            try:
                child.terminate()
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    env = os.environ.copy()
    for key, value in unit["environment"]:
        env[key] = value

    while not stop_requested:
        with log_path.open("a", encoding="utf-8") as log_file:
            log_file.write(f"[devlet-service] starting {unit_name}: {unit['exec_start']}\n")
            log_file.flush()
            child = subprocess.Popen(
                ["bash", "-lc", str(unit["exec_start"])],
                cwd=str(unit["working_directory"]),
                env=env,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            child_pid_file.write_text(f"{child.pid}\n", encoding="utf-8")
            exit_code = child.wait()
            log_file.write(f"[devlet-service] {unit_name} exited with code {exit_code}\n")
            log_file.flush()

        if stop_requested:
            break

        restart = str(unit["restart"])
        should_restart = restart == "always" or (restart == "on-failure" and exit_code != 0)
        if not should_restart:
            break
        time.sleep(1)

    try:
        child_pid_file.unlink()
    except FileNotFoundError:
        pass
    try:
        supervisor_pid_file.unlink()
    except FileNotFoundError:
        pass
    return 0


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] != "run":
        print("usage: devlet-service-runner run <unit>", file=sys.stderr)
        return 2
    return run_service(sys.argv[2])


if __name__ == "__main__":
    raise SystemExit(main())
