#!/usr/bin/env python3
"""`inbox update`: the rename trap, made unfallible.

Measured on this project on 2026-10-20: the repo file is toragents_watch.ts and the
installer writes it out as toragents-inbox.ts. So `git pull` updates the SOURCE, pi
keeps loading the OLD copy, and `/reload` reloads the stale file faithfully. Every
symptom of a missing feature is present and the cause is a filename.

Ten checks. The ones that matter are 1 (the rename), 2 (byte-identity after it), 6
(idempotence), and 9 (exit 2 = copied but unverified, which is a different answer
from 0 "done" and from 1 "broken").

Mutation targets, stated so this file can be shown to fail: copy toragents_watch.ts
to toragents_watch.ts instead of toragents-inbox.ts and check 1 goes red; write the
file without checking the hash and check 6 goes red; return 0 after copying and check
9 goes red; drop the .bak and check 8 goes red.

Usage: python3 tools/test_update.py
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
AGENT = os.path.join(ROOT, "inbox_agent.py")

H = tempfile.mkdtemp(prefix="toragents-update-")
STATE = os.path.join(H, "state")
os.makedirs(os.path.join(STATE, "sent"), exist_ok=True)
os.environ["TORAGENTS_HOME"] = H
os.environ["TORAGENTS_STATE"] = STATE

# A fake source tree with the REAL file names and a version literal in each.
SRC = os.path.join(H, "src")
EXT = os.path.join(H, "pi", "agent", "extensions")
os.makedirs(os.path.join(SRC, "_lib"), exist_ok=True)


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


write(os.path.join(SRC, "toragents_watch.ts"), 'export const EXT_VERSION = "5";\n// watch\n')
write(os.path.join(SRC, "toragents-panel.ts"), "export const PANEL_VERSION = 4;\n// panel\n")
for n in ("transcript", "side-column", "policy"):
    write(os.path.join(SRC, "_lib", f"toragents-{n}.ts"), f"// {n}\n")
write(os.path.join(SRC, "inbox_agent.py"), 'AGENT_VERSION = "2"\n')

ENV = dict(os.environ, TORAGENTS_HOME=H, TORAGENTS_STATE=STATE,
           PI_CODING_AGENT_DIR=os.path.dirname(EXT))


def run(*args):
    return subprocess.run([sys.executable, AGENT, *args], capture_output=True,
                          text=True, env=ENV, timeout=120)


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  {name:60} {'PASS' if ok else 'FAIL'} {detail}")


# ------------------------------------------------------------- 1-2: the trap --
r = run("update", "--from", SRC)
dest = os.path.join(EXT, "toragents-inbox.ts")
check("1. toragents_watch.ts installs AS toragents-inbox.ts", os.path.isfile(dest),
      os.path.basename(dest))
check("2. the installed copy is byte-identical to the source",
      os.path.isfile(dest) and sha(dest) == sha(os.path.join(SRC, "toragents_watch.ts")))
check("3. the repo name is NOT what lands in pi",
      not os.path.exists(os.path.join(EXT, "toragents_watch.ts")))
check("4. _lib files land beside the panel",
      all(os.path.isfile(os.path.join(EXT, "_lib", f"toragents-{n}.ts"))
          for n in ("transcript", "side-column", "policy")))
check("5. the version literal is reported, not guessed",
      "(EXT_VERSION 5)" in r.stdout and "(PANEL_VERSION 4)" in r.stdout,
      r.stdout.splitlines()[0] if r.stdout else "")

# ----------------------------------------------------------- 6-7: idempotent --
before = {p: os.path.getmtime(os.path.join(EXT, p)) for p in os.listdir(EXT)
          if p.endswith(".ts")}
r2 = run("update", "--from", SRC)
check("6. a second run copies nothing", "already current" in r2.stdout, r2.stdout.strip()[:60])
check("7. and does not touch mtimes (no needless rewrite)",
      all(os.path.getmtime(os.path.join(EXT, p)) == m for p, m in before.items()))

# --------------------------------------------------------------- 8: backup ----
write(os.path.join(SRC, "toragents_watch.ts"), 'export const EXT_VERSION = "6";\n// watch v6\n')
r3 = run("update", "--from", SRC)
check("8. an overwritten extension keeps a .bak", os.path.isfile(dest + ".bak"))
check("9. next version reported after the copy", "(EXT_VERSION 6)" in r3.stdout,
      r3.stdout.splitlines()[0] if r3.stdout else "")

# ------------------------------------------------------- 10: exit codes -------
check("10. exit 2 = copied, reload pending (not 0 'done')", r3.returncode == 2,
      f"rc={r3.returncode}")
check("11. exit 0 when there is nothing to do", r2.returncode == 0, f"rc={r2.returncode}")

# ------------------------------------------------------- 12: missing source ---
r4 = run("update", "--from", os.path.join(H, "nope"))
check("12. a missing source tree exits 1 with the clone command",
      r4.returncode == 1 and "git clone" in (r4.stderr + r4.stdout),
      (r4.stderr or r4.stdout).strip().splitlines()[0][:56] if (r4.stderr or r4.stdout) else "")

# ----------------------------------------------------------- 13: --pull guard --
r5 = run("update", "--from", SRC, "--pull")
check("13. --pull refuses a tree that is not a git checkout",
      r5.returncode == 1 and "not a git checkout" in (r5.stderr + r5.stdout),
      (r5.stderr or r5.stdout).strip()[:48])

# --------------------------------------------------------- 14: daemon drift ---
r6 = run("update", "--from", SRC)
check("14. daemon drift is reported, not silently fixed",
      "daemon" in r6.stdout and "--agent" in r6.stdout,
      [l for l in r6.stdout.splitlines() if "daemon" in l][:1])

failed = [n for n, ok, _ in results if not ok]
print(f"\n  {len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
