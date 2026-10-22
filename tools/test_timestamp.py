#!/usr/bin/env python3
"""The sender-attested timestamp, tested through the real handler on localhost.

A message carries two clocks: `received` (ours) and `sent_at` (the sender's, if
they signed one). The rules under test:

  * a valid ts+tsig is stored as `sent_at` (seconds, derived from the peer's ms)
  * a bad or absent tsig drops the timestamp, NEVER the message
  * an old sender (no ts at all) is still accepted, with no `sent_at`
  * a ts with a tampered signature must not be stored

Mutation targets, stated so the file can be shown to fail: make _accept store
`sent_at` without verifying tsig, or refuse the message when tsig is bad, and the
corresponding check here must go red.

Usage: python3 tools/test_timestamp.py
"""
import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

# Point the module at a throwaway state BEFORE importing it (same guard as
# test_wire.py: importing first writes into the real ~/.toragents).
H = tempfile.mkdtemp(prefix="toragents-ts-")
STATE = os.path.join(H, "state")
os.makedirs(os.path.join(STATE, "inbox"), exist_ok=True)
os.environ["TORAGENTS_HOME"] = H
os.environ["TORAGENTS_STATE"] = STATE

import inbox_agent as IA  # noqa: E402
from wire import AgentKeys  # noqa: E402

port = 0
for candidate in range(18900, 19000):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", candidate))
        port = candidate
        break
    except OSError:
        continue
    finally:
        s.close()

with open(os.path.join(STATE, "config.json"), "w") as f:
    json.dump({"local_port": port, "socks_port": 1}, f)

peer = AgentKeys.generate()
IA.save_peers({peer.public().fingerprint: {
    "onion": "test.onion", "label": "peer", "added": time.time()}})

env = dict(os.environ, TORAGENTS_HOME=H, TORAGENTS_STATE=STATE)
daemon = subprocess.Popen([sys.executable, os.path.join(HERE, "inbox_agent.py"), "serve"],
                          env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def connect():
    for _ in range(50):
        try:
            return socket.create_connection(("127.0.0.1", port), timeout=5)
        except OSError:
            time.sleep(0.1)
    raise SystemExit("daemon never listened")


def hello(sock):
    IA.send_msg(sock, {"op": "hello"})
    return IA.recv_msg(sock)


def send(sock, keys, body, nonce_tok, *, ts=None, tsig=None, corrupt_tsig=False):
    nonce = base64.b64decode(nonce_tok)
    payload = {
        "op": "send",
        "nonce": nonce_tok,
        "body": body,
        "pubkey": keys.public().to_dict(),
        "sig": base64.b64encode(keys.sign(nonce + body.encode())).decode(),
    }
    if ts is not None:
        payload["ts"] = ts
        sig = keys.sign(nonce + b"toragents-ts1" + str(int(ts)).encode("ascii"))
        if corrupt_tsig:
            sig = bytes([sig[0] ^ 1]) + sig[1:]
        payload["tsig"] = base64.b64encode(tsig if tsig is not None else sig).decode()
    IA.send_msg(sock, payload)
    return IA.recv_msg(sock)


def stored():
    d = os.path.join(STATE, "inbox")
    names = [n for n in os.listdir(d) if n.endswith(".json")]
    out = []
    for n in sorted(names):
        with open(os.path.join(d, n)) as f:
            out.append(json.load(f))
    return out


results = []
def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  {name:56} {'PASS' if ok else 'FAIL'} {detail}")


try:
    # 1 happy path: a valid ts is stored as sent_at, in seconds
    s = connect(); r = hello(s)
    ts = int(time.time() * 1000)
    r = send(s, peer, "with a clock", r["nonce"], ts=ts)
    check("1. ts+tsig accepted", bool(r and r.get("ok")), str(r.get("id", "")))
    s.close()
    recs = stored()
    check("2. sent_at stored, in seconds",
          len(recs) == 1 and abs(recs[0].get("sent_at", -1) - ts / 1000.0) < 0.01,
          f"sent_at={recs[0].get('sent_at')}")

    # 2 a tampered tsig drops the timestamp, keeps the message
    s = connect(); r = hello(s)
    ts2 = int(time.time() * 1000)
    r = send(s, peer, "tampered clock", r["nonce"], ts=ts2, corrupt_tsig=True)
    check("3. tampered tsig: message still accepted", bool(r and r.get("ok")))
    s.close()
    recs = stored()
    tampered = [x for x in recs if x.get("body") == "tampered clock"]
    check("4. tampered tsig: no sent_at stored",
          len(tampered) == 1 and "sent_at" not in tampered[0])

    # 3 an old sender (no ts) is accepted, no sent_at
    s = connect(); r = hello(s)
    r = send(s, peer, "old sender", r["nonce"])
    check("5. old sender (no ts) accepted", bool(r and r.get("ok")))
    s.close()
    recs = stored()
    old = [x for x in recs if x.get("body") == "old sender"]
    check("6. old sender: no sent_at", len(old) == 1 and "sent_at" not in old[0])

    # 4 a ts with a missing tsig is dropped, message kept
    s = connect(); r = hello(s)
    r = send(s, peer, "no tsig", r["nonce"], ts=int(time.time() * 1000), tsig=b"")
    check("7. ts without tsig: message accepted", bool(r and r.get("ok")))
    s.close()
    recs = stored()
    notsig = [x for x in recs if x.get("body") == "no tsig"]
    check("8. ts without tsig: no sent_at", len(notsig) == 1 and "sent_at" not in notsig[0])

    # 5 a ts that is not a number is dropped, message kept
    s = connect(); r = hello(s)
    nonce = base64.b64decode(r["nonce"])
    payload = {
        "op": "send", "nonce": r["nonce"], "body": "string clock",
        "pubkey": peer.public().to_dict(),
        "sig": base64.b64encode(peer.sign(nonce + b"string clock")).decode(),
        "ts": "not-a-number",
        "tsig": base64.b64encode(peer.sign(nonce + b"toragents-ts1" + b"not-a-number")).decode(),
    }
    IA.send_msg(s, payload)
    r = IA.recv_msg(s)
    check("9. non-numeric ts: message accepted", bool(r and r.get("ok")))
    s.close()
    recs = stored()
    strc = [x for x in recs if x.get("body") == "string clock"]
    check("10. non-numeric ts: no sent_at", len(strc) == 1 and "sent_at" not in strc[0])
finally:
    daemon.terminate()
    try:
        daemon.wait(timeout=5)
    except subprocess.TimeoutExpired:
        daemon.kill()

failed = [n for n, ok, _ in results if not ok]
print(f"\n  {len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
