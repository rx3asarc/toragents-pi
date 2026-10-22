#!/usr/bin/env python3
"""Clock skew: estimated from two clocks, and never rounded to "in sync".

The timestamp field (PR #1) gives every message two clocks. Their difference is
transit time PLUS skew, and one message cannot split them apart -- so this does not
try. It takes the MINIMUM across samples, because transit is non-negative and the
smallest difference is therefore the sample least polluted by network time.

That makes the number a LOWER BOUND on their skew, and every surface says so. The
tempting bug is to treat the min as the offset exactly; the worse bug is to report
"in sync" when no peer has ever sent a timestamp, which is what "no samples" reads
as if you let it default to zero.

Checks:

  1-2  no samples -> unknown, and specifically NOT "0 / in sync"
  3    the min is taken, not the mean: one slow message cannot inflate the estimate
  4-5  sign: they are ahead -> negative offset, reported as ahead
  6-7  thresholds: ok / note / skewed at the documented boundaries
  8    spread = median - min, so a wide spread is visible as "transit varies"
  9    the CLI emits the documented JSON and the right exit code
  10   doctor prints a clock line, and only when there is something to say

Mutation targets, RUN not just claimed:

  use the mean instead of the min        -> 3 red
  flip the sign of the offset            -> 4 and 5 red
  return offset_s=0 when there are none  -> 1 and 2 red

All three verified by making the mistake, watching the failure, and reverting.

Usage: python3 tools/test_skew.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

H = tempfile.mkdtemp(prefix="toragents-skew-")
STATE = os.path.join(H, "state")
os.makedirs(os.path.join(STATE, "inbox"), exist_ok=True)
os.environ["TORAGENTS_HOME"] = H
os.environ["TORAGENTS_STATE"] = STATE

import inbox_agent as IA  # noqa: E402
from wire import AgentKeys  # noqa: E402

FP = "aa" * 16
ENV = dict(os.environ, TORAGENTS_HOME=H, TORAGENTS_STATE=STATE)


def msg(mid, received, sent_at, fp=FP):
    rec = {"id": mid, "received": received, "from_fingerprint": fp,
           "from_label": "peer", "body": "x"}
    if sent_at is not None:
        rec["sent_at"] = sent_at
    with open(os.path.join(STATE, "inbox", f"{int(received)}-{mid}.json"), "w") as f:
        json.dump(rec, f)


def clear():
    for n in os.listdir(os.path.join(STATE, "inbox")):
        os.unlink(os.path.join(STATE, "inbox", n))


results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  {name:58} {'PASS' if ok else 'FAIL'} {detail}")


# ---------------------------------------------------- 1-2: absence of evidence --
est = IA.clock_estimate([])
check("1. no samples -> offset None, state unknown",
      est["offset_s"] is None and est["state"] == "unknown",
      f"{est['offset_s']}/{est['state']}")
check("2. and explicitly NOT '0 / in sync'",
      "indistinguishable" in est["why"] or "no message" in est["why"],
      est["why"][:44])

# ------------------------------------------------------------- 3: min, not mean --
# Transit varies wildly; skew does not. The estimate must track the floor.
deltas = [2.0, 3.0, 900.0, 4.0]
est = IA.clock_estimate(deltas)
check("3. the minimum is used, not the mean", abs(est["offset_s"] - 2.0) < 1e-9,
      f"offset={est['offset_s']}")

# ------------------------------------------------------------------- 4-5: sign --
est = IA.clock_estimate([-90.0, -91.0])
check("4. a peer 90s AHEAD reports a negative offset", est["offset_s"] < 0,
      f"offset={est['offset_s']}")
check("5. and the words say 'ahead', not 'behind'", "ahead" in est["why"],
      est["why"][:52])

# ------------------------------------------------------------- 6-7: thresholds --
ok = IA.clock_estimate([3.0])
note = IA.clock_estimate([30.0])
skewed = IA.clock_estimate([300.0])
check("6. <=5s is ok", ok["state"] == "ok", ok["state"])
check("7. 5..60s is a note, >60s is skewed",
      note["state"] == "note" and skewed["state"] == "skewed",
      f"{note['state']}/{skewed['state']}")

# ---------------------------------------------------------------- 8: spread ----
est = IA.clock_estimate([1.0, 5.0, 50.0])
check("8. spread is median - min, so varying transit is visible",
      abs(est["spread_s"] - 4.0) < 1e-9, f"spread={est['spread_s']}")

# ------------------------------------------------------- 9: the CLI + exit code --
clear()
for i in range(5):
    msg(f"m{i}", 1000.0 + i, 1000.0 + i - 2.0)      # 2s of transit, no skew
proc = subprocess.run([sys.executable, os.path.join(HERE, "inbox_agent.py"),
                       "clock", "--json"], capture_output=True, text=True,
                      env=ENV, timeout=60)
try:
    doc = json.loads(proc.stdout)
except ValueError:
    doc = {}
peer = (doc.get("peers") or {}).get(FP[:12]) or (doc.get("peers") or {}).get("peer")
check("9. --json emits n/offset_s/spread_s/state/why and exits 0 when fine",
      peer is not None and {"n", "offset_s", "spread_s", "state", "why"} <= set(peer)
      and proc.returncode == 0,
      f"rc={proc.returncode}, keys={sorted(peer or {})}")

# A different clock: 10 minutes of skew must change the exit code.
clear()
for i in range(5):
    msg(f"s{i}", 2000.0 + i, 2000.0 + i - 600.0)
proc = subprocess.run([sys.executable, os.path.join(HERE, "inbox_agent.py"),
                       "clock", "--json"], capture_output=True, text=True,
                      env=ENV, timeout=60)
check("10. a skewed peer exits 2 (not 'fine')", proc.returncode == 2,
      f"rc={proc.returncode}")

# ------------------------------------------------------------- 11: doctor line --
proc = subprocess.run([sys.executable, os.path.join(HERE, "inbox_agent.py"), "doctor"],
                      capture_output=True, text=True, env=ENV, timeout=180)
check("11. doctor prints a clock line when there is skew to report",
      "clock" in proc.stdout and "samples" in proc.stdout,
      [l for l in proc.stdout.splitlines() if l.startswith("clock")][:1])

# And stays silent when there are no timestamps at all.
clear()
proc = subprocess.run([sys.executable, os.path.join(HERE, "inbox_agent.py"), "doctor"],
                      capture_output=True, text=True, env=ENV, timeout=180)
check("12. doctor stays silent with no timestamps (a note nobody needs is noise)",
      "clock " not in proc.stdout, "no clock line")

failed = [n for n, ok, _ in results if not ok]
print(f"\n  {len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
