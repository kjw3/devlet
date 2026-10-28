#!/usr/bin/python3 -I
"""Record runtime-injected agent groups before unprivileged Tailscale SSH starts."""
import grp
import os
from pathlib import Path
import pwd
import subprocess
import sys


def inherited_groups(status, expected_uid):
    fields = dict(line.split(":", 1) for line in status.splitlines() if ":" in line)
    if any(int(uid) != expected_uid for uid in fields["Uid"].split()):
        raise ValueError("process must belong to the agent user")
    return sorted(set(map(int, fields["Groups"].split())))


def sync_groups(gids, user, lookup=grp.getgrgid, run=subprocess.run):
    for gid in gids:
        if gid == user.pw_gid:
            continue
        try:
            group = lookup(gid)
        except KeyError:
            # GPU runtimes can inject a numeric GID absent from /etc/group.
            name = f"devlet-gid-{gid}"
            run(["/usr/sbin/groupadd", "--gid", str(gid), name], check=True)
        else:
            if user.pw_name in group.gr_mem:
                continue
            name = group.gr_name
        run(["/usr/sbin/usermod", "--append", "--groups", name, user.pw_name], check=True)


def main():
    if os.geteuid() != 0:
        raise ValueError("must run as root through sudo")
    user = pwd.getpwnam("agent")
    if int(os.environ.get("SUDO_UID", str(user.pw_uid))) != user.pw_uid:
        raise ValueError("only the agent user may synchronize its groups")
    # Accept a PID, not caller-supplied GIDs. Only record groups the agent
    # process already has; never grant a new device group through this helper.
    pid = int(sys.argv[1])
    if pid <= 0:
        raise ValueError("invalid process ID")
    status = Path(f"/proc/{pid}/status").read_text()
    sync_groups(inherited_groups(status, user.pw_uid), user)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"[devlet-tailscale] group synchronization failed: {error}", file=sys.stderr)
        sys.exit(1)
