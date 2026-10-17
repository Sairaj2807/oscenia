"""Run commands on the VPS (or upload a file) over SSH with a password, without writing it anywhere.

There are no SSH keys on the server yet, so scripted access needs the root password. It is read ONLY from the
environment of the one command you run; it is never written to a file, a script or a log:

    # Git Bash (note MSYS_NO_PATHCONV: Git Bash rewrites /paths into C:/Program Files/Git/...)
    MSYS_NO_PATHCONV=1 VPS_PW='…' python deploy/vps/ssh-run.py "systemctl is-active oscenia-api" "free -m"

    # PowerShell
    $env:VPS_PW='…'; python deploy/vps/ssh-run.py "systemctl is-active oscenia-api"

    # upload (SFTP), then use it
    MSYS_NO_PATHCONV=1 VPS_PW='…' python deploy/vps/ssh-run.py --put local-file.tgz /root/local-file.tgz

Needs `pip install paramiko`. Host and user default to the production server; override with VPS_HOST / VPS_USER.
Multi-line scripts: pass `"bash -s <<'EOS' … EOS"` as one argument.

RULES FOR THIS SERVER (see deploy/vps/README.md): it is shared with trading services. Read-only probes are free;
ask the owner before anything that changes it; never restart anything you did not create; reload Nginx, never
restart it.
"""

import os
import sys

try:
    import paramiko
except ImportError:
    sys.exit("pip install paramiko  (needed to talk SSH with a password)")

HOST = os.environ.get("VPS_HOST", "194.164.148.203")
USER = os.environ.get("VPS_USER", "root")
PASSWORD = os.environ.get("VPS_PW")
TIMEOUT = int(os.environ.get("VPS_TIMEOUT", "900"))


def main(argv: list[str]) -> int:
    if not PASSWORD:
        sys.exit("Set VPS_PW in the environment of this command (the password is never stored anywhere).")
    if not argv:
        sys.exit(__doc__)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=20, banner_timeout=30)
    try:
        if argv[0] == "--put":
            if len(argv) != 3:
                sys.exit("usage: --put LOCAL REMOTE")
            sftp = client.open_sftp()
            sftp.put(argv[1], argv[2])
            print(f"uploaded {argv[1]} -> {argv[2]} ({sftp.stat(argv[2]).st_size} bytes)")
            sftp.close()
            return 0

        status = 0
        for command in argv:
            print(f"\n$ {command}")
            _, out, err = client.exec_command(command, timeout=TIMEOUT)
            print(out.read().decode(errors="replace").rstrip())
            errors = err.read().decode(errors="replace").rstrip()
            if errors:
                print("[stderr]", errors)
            status = out.channel.recv_exit_status() or status
        return status
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
