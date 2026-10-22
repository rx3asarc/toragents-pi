#!/usr/bin/env python3
"""Durable send: queue first, send second, and prove the queue is real.

The defect this closes shipped on 2026-10-20: `send` wrote an intent row into
sent/ and dialled, and nothing retained the body as work to do. Two letters died
mid-dial and sat for an hour while the sender's own record said `pending`, which
a human read as a receipt.

Eleven checks, and the interesting ones are the refusals and the recovery:

  1-3  a failed dial leaves the body QUEUED, with its error, and exits non-zero
  4-5  a successful dial removes the item -- a queue that never drains is a leak
  6    --direct does not queue (or the flusher would enqueue what it is draining)
  7-8  flush drains the queue and reports what remains via the exit code
  9    flush refuses to retry an AMBIGUOUS item without --retry-ambiguous
  10   `recover` requeues bodies stranded by the old path
  11   the on-disk format is the one tools/outbox.py already writes

Mutation targets, stated so this file can be shown to fail: move `outbox_queue`
after the dial (the old order) and check 1 goes red; delete the item before the
verdict and check 4 goes red; drop the ambiguous guard and check 9 goes red.

Usage: python3 tools/test_durable_send.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
AGENT = os.path.join(ROOT, "inbox_agent.py")
sys.path.insert(0, ROOT)

H = tempfile.mkdtemp(prefix="toragents-durable-")
STATE = os.path.join(H, "state")
os.makedirs(os.path.join(STATE, "sent"), exist_ok=True)
os.environ["TORAGENTS_HOME"] = H
os.environ["TORAGENTS_STATE"] = STATE

import inbox_agent as IA  # noqa: E402
from wire import AgentKeys  # noqa: E402

# A peer that can be looked up but never dialled: the onion is syntactically fine
# and the socks port points at nothing. This is the shape of the real failure --
# the peer exists in peers.json and their tor has no descriptor yet.
peer = AgentKeys.generate()
IA.save_peers({peer.public().fingerprint: {
    "onion": "a" * 56 + ".onion", "label": "ghost", "added": time.time()}})
# Mint an identity, or `send` exits 2 from need_keys() before it ever dials -- and
# a test that fails on a missing key proves nothing about the queue.
IA.keys(create=True)

# The dial ladder is ours to shorten; a real 30/60/120/180 ladder would make this
# test take ten minutes to prove a three-second fact.
ENV = dict(os.environ, TORAGENTS_HOME=H, TORAGENTS_STATE=STATE,
           TORAGENTS_SOCKS="1", TORAGENTS_DIAL_LADDER="1")

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  {name:58} {'PASS' if ok else 'FAIL'} {detail}")


def cli(*args, env=None, stdin=None):
    return subprocess.run([sys.executable, AGENT, *args], capture_output=True,
                          text=True, env=env or ENV, timeout=180, input=stdin)


def body_file(text):
    p = os.path.join(H, f"body-{abs(hash(text))}.txt")
    with open(p, "w") as f:
        f.write(text)
    return p


def queued():
    return IA.outbox_items()


# ---------------------------------------------------------------- 1-3: fail --
r = cli("send", "--to", "ghost", "--body-file", body_file("a letter that will not land"))
items = queued()
check("1. a failed dial leaves the body queued", len(items) == 1,
      f"{len(items)} item(s)")
check("2. the failure exits non-zero", r.returncode != 0, f"rc={r.returncode}")
item = items[0][1] if items else {}
check("3. the item carries the peer's own error words",
      bool(item.get("last_error")) and int(item.get("attempts") or 0) >= 1,
      str(item.get("last_error"))[:48])

# --------------------------------------------------------------- 4-5: drain --
# Drive the queue with a stub sender so the test does not need tor: this is the
# same escape hatch tools/outbox.py has, which is what keeps the two drainers
# swappable.
stub = os.path.join(H, "stub-send.py")
with open(stub, "w") as f:
    f.write("#!/usr/bin/env python3\n"
            "import sys, json\n"
            "json.dump({'ok': True, 'id': 'deadbeef1234'}, sys.stdout)\n"
            "sys.exit(0)\n")
sent_items_before = len(queued())
r = cli("outbox", "flush", env=dict(ENV, TORAGENTS_SEND_CMD=f"{sys.executable} {stub}"))
check("4. flush drains a queued item on an ok verdict", len(queued()) == sent_items_before - 1,
      f"{sent_items_before} -> {len(queued())}")
check("5. a drained queue exits 0 (the supervisor contract)", r.returncode == 0,
      f"rc={r.returncode}")

# ------------------------------------------------------------ 6: --direct ----
n_before = len(queued())
cli("send", "--direct", "--to", "ghost", "--body-file", body_file("direct, no queue"))
check("6. --direct dials without queueing a second copy", len(queued()) == n_before,
      f"{n_before} -> {len(queued())}")

# ------------------------------------------------------- 7-8: flush verdicts --
cli("send", "--to", "ghost", "--body-file", body_file("still undeliverable"))
n_before = len(queued())
r = cli("outbox", "flush", env=dict(ENV, TORAGENTS_SEND_CMD=f"{sys.executable} {stub}"))
check("7. flush sends a waiting item", len(queued()) == n_before - 1,
      f"{n_before} -> {len(queued())}")

# A flusher that reports 0 while items remain would be told "done" forever.
with open(os.path.join(H, "fail-send.py"), "w") as f:
    f.write("import sys, json\njson.dump({'ok': False, 'error': 'peer said no'}, sys.stdout)\n"
            "sys.exit(1)\n")
cli("send", "--to", "ghost", "--body-file", body_file("a body the peer will refuse"))
r = cli("outbox", "flush", env=dict(ENV, TORAGENTS_SEND_CMD=f"{sys.executable} {H}/fail-send.py"))
check("8. a refused item stays queued and flush exits 2",
      len(queued()) >= 1 and r.returncode == 2, f"rc={r.returncode}, {len(queued())} pending")

# ------------------------------------------------- 9: ambiguous is not retried --
path, it = queued()[0]
it = dict(it or {})
it["ambiguous"] = True
it["last_error"] = "TIMEOUT -- may or may not have arrived"
IA._atomic_json(path, it)
before = len(queued())
r = cli("outbox", "flush", env=dict(ENV, TORAGENTS_SEND_CMD=f"{sys.executable} {stub}"))
still = [x for _, x in queued() if isinstance(x, dict) and x.get("ambiguous")]
check("9. flush refuses an ambiguous item without --retry-ambiguous",
      len(still) == 1 and len(queued()) == before, f"ambiguous kept={len(still)}")
for p, x in queued():
    IA.outbox_remove(p)

# ------------------------------------------------------------ 10: recover ----
# A stranded row is what the old send path left behind: state pending, body
# retained, nothing that would ever retry it.
with open(os.path.join(STATE, "sent", "stranded0001.json"), "w") as f:
    json.dump({"local_id": "stranded0001", "state": "pending",
               "at": time.time() - 3600, "to": "ghost", "onion": "a" * 56 + ".onion",
               "len": 20, "sha256": "0" * 32, "body": "a stranded last word"}, f)
r = cli("recover")
recovered = [x for _, x in queued() if isinstance(x, dict)
             and x.get("body") == "a stranded last word"]
check("10. recover requeues a stranded pending body", len(recovered) == 1,
      f"{len(recovered)} requeued")
r2 = cli("recover")
check("10b. recover is idempotent (does not queue it twice)",
      len([x for _, x in queued() if isinstance(x, dict)
           and x.get("body") == "a stranded last word"]) == 1)

# ------------------------------------------------- 11: format compatibility ----
# The queue is only a shared contract if tools/outbox.py can read what we write.
r = subprocess.run([sys.executable, os.path.join(HERE, "outbox.py"),
                    "--state", STATE, "list"], capture_output=True, text=True, timeout=60)
check("11. tools/outbox.py reads the queue inbox_agent.py wrote",
      r.returncode == 2 and "ghost" in r.stdout,
      f"rc={r.returncode}")

failed = [n for n, ok, _ in results if not ok]
print(f"\n  {len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
