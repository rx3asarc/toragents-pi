#!/usr/bin/env python3
"""`reach` answers three different questions and must not collapse them.

The failure this closes: a boolean "is the peer up" rounded every absence of
evidence to "down". The classes below are the ones tools/measure_publish.py
measured against two real tori; here the requirement is that they reach the human
AND that exactly one of them is allowed to say "down".

  socks-rep 0x04  no descriptor  -> UNKNOWN (not published yet is not "not there")
  socks-rep 0x05  listener refused -> DOWN   (their tor found it; their daemon did not)
  0x00 + nonce    handshake done -> UP
  0x00 + silence  wedged daemon  -> UNKNOWN
  socks unreachable              -> UNKNOWN, and explicitly not the peer's fault

Checks:

  1-5  one check per class, through a fake SOCKS5 server that speaks the protocol
  6    "down" is claimed only for 0x05
  7    a local fault never blames the peer
  8    --json emits the documented shape
  9    the text form names the class and the next action

Mutation targets, stated so this file can be shown to fail: map 0x04 to "down" and
check 6 goes red; classify an unreachable socks port as the peer's failure and check
7 goes red; drop the nonce check and check 3 goes red.

Usage: python3 tools/test_reach.py
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
AGENT = os.path.join(ROOT, "inbox_agent.py")
sys.path.insert(0, ROOT)

H = tempfile.mkdtemp(prefix="toragents-reach-")
STATE = os.path.join(H, "state")
os.makedirs(os.path.join(STATE, "inbox"), exist_ok=True)
os.environ["TORAGENTS_HOME"] = H
os.environ["TORAGENTS_STATE"] = STATE

import inbox_agent as IA  # noqa: E402
from wire import AgentKeys  # noqa: E402

ONION = "a" * 56 + ".onion"


def _read_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


class FakeSocks(threading.Thread):
    """A SOCKS5 server that answers with a chosen reply and then behaves.

    mode: "reply"  -> send `rep` and stop
          "daemon" -> send 0x00, then answer hello with a nonce
          "silent" -> send 0x00, then say nothing at all
    """

    def __init__(self, rep, mode="reply"):
        super().__init__(daemon=True)
        self.rep = rep
        self.mode = mode
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(4)
        self.port = self.srv.getsockname()[1]

    def run(self):
        try:
            conn, _ = self.srv.accept()
        except OSError:
            return
        with conn:
            try:
                _read_exact(conn, 3)                       # greeting
                conn.sendall(b"\x05\x00")
                head = _read_exact(conn, 4)                # ver, cmd, rsv, atyp
                if head is None:
                    return
                atyp = head[3]
                if atyp == 0x03:                            # domain name
                    n = _read_exact(conn, 1)
                    _read_exact(conn, (n[0] if n else 0) + 2)
                elif atyp == 0x01:                          # ipv4
                    _read_exact(conn, 4 + 2)
                else:                                       # ipv6
                    _read_exact(conn, 16 + 2)
                if self.rep != 0x00:
                    conn.sendall(bytes([0x05, self.rep, 0x00, 0x01])
                                 + b"\x00\x00\x00\x00" + b"\x00\x00")
                    return
                conn.sendall(b"\x05\x00\x00\x01" + b"\x00\x00\x00\x00" + b"\x00\x00")
                if self.mode == "silent":
                    time.sleep(8)
                    return
                # daemon: read the framed hello, answer with a nonce
                _read_exact(conn, 4)
                conn.sendall(len(json.dumps({"ok": True, "nonce": "N" * 44}).encode())
                             .to_bytes(4, "big")
                             + json.dumps({"ok": True, "nonce": "N" * 44}).encode())
                time.sleep(0.2)
            except OSError:
                return

    def stop(self):
        try:
            self.srv.close()
        except OSError:
            pass


results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  {name:56} {'PASS' if ok else 'FAIL'} {detail}")


def probe(port, timeout=5.0):
    return IA.reach_probe(ONION, timeout=timeout, socks_port=port)


# ------------------------------------------------------- 1-5: one per class ---
s = FakeSocks(0x04); s.start()
r = probe(s.port); s.stop()
check("1. 0x04 -> descriptor-missing / unknown",
      r["state"] == "descriptor-missing" and r["verdict"] == "unknown",
      f"{r['state']}/{r['verdict']}")

s = FakeSocks(0x05); s.start()
r = probe(s.port); s.stop()
check("2. 0x05 -> service-refused / down",
      r["state"] == "service-refused" and r["verdict"] == "down",
      f"{r['state']}/{r['verdict']}")

s = FakeSocks(0x00, mode="daemon"); s.start()
r = probe(s.port); s.stop()
check("3. handshake with a nonce -> connected / up",
      r["state"] == "connected" and r["verdict"] == "up",
      f"{r['state']}/{r['verdict']}")

s = FakeSocks(0x00, mode="silent"); s.start()
r = probe(s.port, timeout=2.0); s.stop()
check("4. connected then silence -> connected-no-handshake / unknown",
      r["state"] == "connected-no-handshake" and r["verdict"] == "unknown",
      f"{r['state']}/{r['verdict']}")

dead = socket.socket(); dead.bind(("127.0.0.1", 0)); dead_port = dead.getsockname()[1]
dead.close()                                    # nothing listens here now
r = probe(dead_port)
check("5. unreachable socks -> local-error / unknown",
      r["state"] == "local-error" and r["verdict"] == "unknown",
      f"{r['state']}/{r['verdict']}")

# ---------------------------------------------------- 6-7: the two promises ---
s = FakeSocks(0x04); s.start()
r1 = probe(s.port); s.stop()
s = FakeSocks(0x05); s.start()
r2 = probe(s.port); s.stop()
r3 = probe(dead_port)
downs = [x["state"] for x in (r1, r2, r3) if x["verdict"] == "down"]
check("6. only 0x05 is allowed to say 'down'",
      downs == ["service-refused"], str(downs))
check("7. a local fault never blames the peer",
      r3["state"] == "local-error" and "says nothing" in r3["next"],
      r3["next"][:48])

# ------------------------------------------------------------- 8: json shape ---
IA.save_peers({AgentKeys.generate().public().fingerprint: {
    "onion": ONION, "label": "probe", "added": time.time()}})
ENV = dict(os.environ, TORAGENTS_HOME=H, TORAGENTS_STATE=STATE,
           TORAGENTS_SOCKS=str(dead_port))
proc = subprocess.run([sys.executable, AGENT, "reach", "--to", "probe", "--json"],
                      capture_output=True, text=True, env=ENV, timeout=60)
try:
    doc = json.loads(proc.stdout)
except ValueError:
    doc = {}
keys = {"v", "peer", "onion", "port", "socks", "state", "verdict", "elapsed",
        "detail", "next"}
check("8. --json emits the documented shape",
      keys <= set(doc) and doc.get("verdict") in ("up", "down", "unknown"),
      ",".join(sorted(keys - set(doc))) or "all keys present")
check("9. --json exits 2 when the answer is not 'up'", proc.returncode == 2,
      f"rc={proc.returncode}")

# ------------------------------------------------------------ 10: text form ---
proc = subprocess.run([sys.executable, AGENT, "reach", "--to", "probe"],
                      capture_output=True, text=True, env=ENV, timeout=60)
out = proc.stdout + proc.stderr
check("10. the text form names the class and the next action",
      "local-error" in out and "next:" in out and "UNKNOWN" in out,
      out.strip().splitlines()[-1][:56] if out.strip() else "")

failed = [n for n, ok, _ in results if not ok]
print(f"\n  {len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
