"""Run a CLI fixture in a real terminal, forwarding input/output to Node."""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

pid, terminal = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

def stop(_signal, _frame):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
try:
    while True:
        ready, _, _ = select.select([terminal, sys.stdin.fileno()], [], [])
        if terminal in ready:
            try:
                data = os.read(terminal, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(sys.stdout.fileno(), data)
        if sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            os.write(terminal, data)
    _, status = os.waitpid(pid, 0)
    pid = None
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except ProcessLookupError:
            pass
    os.close(terminal)
