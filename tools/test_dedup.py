#!/usr/bin/env python3
"""Duplicate bodies: recorded, never enforced.

Same bytes arriving twice is not an error. It is what an at-least-once sender looks
like from here (a flush retried after a lost verdict), and it is also what a person
looks like when they send the same line twice. The cardinal sin of this channel is
losing mail, so the second copy is stored in FULL and the record merely says which
earlier id it matches.

Checks, and the two that matter are 4 (nothing is dropped) and 7 (the index never
leaks across senders):

  1-3  same body twice -> dup_of the first; different body -> no dup_of; three in a
       row chain to the previous copy, not to the original
  4    every copy is stored and addressable by its own id
  5    a different body is not a duplicate of anything
  6    a different sender with the same bytes gets NO dup_of (no cross-peer inference)
  7    an unreadable index costs the annotation, never the message
  7b   an index that cannot be written at all costs only the annotation
  7c   and the daemon keeps serving afterwards
  8    the digest never carries dup_of (it is an index of id/h/n only)
  9    the listing marks it, so a human sees it without opening the record

Mutation targets, RUN not just claimed. Each line names the mistake and the check that
must go red, and each was verified by making the mistake, watching the failure, and
reverting:

  drop the message on a duplicate         -> 4 red
  look up by body, ignore the sender      -> 6 red
  let the index write raise               -> 7b/7c red
  digest: leak dup_of                     -> 8 red ONLY if dg_build's whitelist is also
                                             removed. One layer alone survives, because
                                             dg_attach builds {id,h,n} and dg_build
                                             rebuilds them as {id,h,n}: two independent
                                             walls. Check 8 is a contract assertion, not
                                             a single-mistake detector, and saying so is
                                             more useful than pretending one edit breaks
                                             it.

Usage: python3 tools/test_dedup.py
"""
import base64
import glob
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

H = tempfile.mkdtemp(prefix="toragents-dedup-")
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

alice = AgentKeys.generate()
bob = AgentKeys.generate()
IA.save_peers({alice.public().fingerprint: {
    "onion": "a" * 56 + ".onion", "label": "alice", "added": time.time()},
    bob.public().fingerprint: {
        "onion": "b" * 56 + ".onion", "label": "bob", "added": time.time()}})

ENV = dict(os.environ, TORAGENTS_HOME=H, TORAGENTS_STATE=STATE)
daemon = subprocess.Popen([sys.executable, os.path.join(HERE, "inbox_agent.py"), "serve"],
                          env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def connect():
    for _ in range(50):
        try:
            return socket.create_connection(("127.0.0.1", port), timeout=5)
        except OSError:
            time.sleep(0.1)
    raise SystemExit("daemon never listened")


def send(keys, body):
    s = connect()
    try:
        IA.send_msg(s, {"op": "hello"})
        hello = IA.recv_msg(s)
        nonce = base64.b64decode(hello["nonce"])
        IA.send_msg(s, {"op": "send", "nonce": hello["nonce"], "body": body,
                        "pubkey": keys.public().to_dict(),
                        "sig": base64.b64encode(keys.sign(nonce + body.encode())).decode()})
        return IA.recv_msg(s)
    finally:
        s.close()


def records():
    out = []
    for p in sorted(glob.glob(os.path.join(STATE, "inbox", "*.json"))):
        with open(p) as f:
            out.append(json.load(f))
    return out


def by_id(mid):
    for r in records():
        if r.get("id") == mid:
            return r
    return None


results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  {name:58} {'PASS' if ok else 'FAIL'} {detail}")


try:
    BODY = "the same sentence, sent twice, on purpose"
    r1 = send(alice, BODY)
    time.sleep(0.05)
    r2 = send(alice, BODY)
    time.sleep(0.05)
    r3 = send(alice, BODY)

    a, b, c = by_id(r1["id"]), by_id(r2["id"]), by_id(r3["id"])
    check("1. the first copy has no dup_of", a is not None and "dup_of" not in a)
    check("2. the second names the first", b is not None and b.get("dup_of") == r1["id"],
          f"{b.get('dup_of')} vs {r1['id']}")
    check("3. the third names its immediate predecessor, not the original",
          c is not None and c.get("dup_of") == r2["id"],
          f"{c.get('dup_of')} vs {r2['id']}")

    ids = {r["id"] for r in records()}
    check("4. every copy is stored and addressable by its own id",
          {r1["id"], r2["id"], r3["id"]} <= ids, f"{len(ids)} record(s)")

    # A different body is not a duplicate of anything.
    r4 = send(alice, "a genuinely new sentence")
    check("5. a different body carries no dup_of",
          "dup_of" not in (by_id(r4["id"]) or {}))

    # Cross-sender: same bytes from someone else must NOT be reported as a duplicate,
    # or the index tells one peer what another peer said.
    r5 = send(bob, BODY)
    check("6. the same bytes from a DIFFERENT sender are not a duplicate",
          "dup_of" not in (by_id(r5["id"]) or {}),
          "cross-peer inference would be disclosure")

    # A broken index must not cost a letter, and there are TWO ways for it to break.
    # They hit different code -- unreadable content is swallowed by the lookup, an
    # unwritable index by the record -- so both are here. Mutation testing found the
    # gap: corrupting the JSON alone never reached the write guard, because a tolerant
    # load meant the save simply overwrote the mess. A guard nothing can reach is a
    # guard nobody has tested.
    with open(os.path.join(STATE, "bodies.json"), "w") as f:
        f.write("{not json")
    r6 = send(alice, "a body sent after the index broke")
    check("7. an unreadable index costs the annotation, never the message",
          r6.get("ok") and by_id(r6["id"]) is not None,
          f"stored={'yes' if by_id(r6['id']) else 'NO'}")

    # Now make the index genuinely unwritable: a directory where the file belongs.
    idx = os.path.join(STATE, "bodies.json")
    os.unlink(idx)
    os.mkdir(idx)
    r6b = send(alice, "a body sent while the index cannot be written")
    check("7b. an unwritable index also costs only the annotation",
          r6b.get("ok") and by_id(r6b["id"]) is not None,
          f"stored={'yes' if by_id(r6b['id']) else 'NO'}")
    check("7c. and the daemon is still serving after that", daemon.poll() is None,
          f"daemon exit={daemon.poll()}")
    os.rmdir(idx)

    # The digest is an index of id/h/n and nothing else: dup_of must not appear.
    dg = IA.dg_attach(STATE, peer_fp=alice.public().fingerprint, peer_label="alice")
    fields = {k for side in ("a", "b") for it in dg.get(side, []) for k in it}
    check("8. the digest never carries dup_of", fields <= {"id", "h", "n"}, str(fields))
finally:
    daemon.terminate()
    try:
        daemon.wait(timeout=5)
    except subprocess.TimeoutExpired:
        daemon.kill()

# The listing marks it, so a human sees it without opening the record.
proc = subprocess.run([sys.executable, os.path.join(HERE, "inbox_agent.py"), "inbox"],
                      capture_output=True, text=True, env=ENV, timeout=60)
check("9. the listing marks duplicates with ≡", "≡" in proc.stdout,
      [l for l in proc.stdout.splitlines() if "≡" in l][:1])

failed = [n for n, ok, _ in results if not ok]
print(f"\n  {len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
