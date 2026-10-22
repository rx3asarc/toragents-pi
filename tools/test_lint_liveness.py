#!/usr/bin/env python3
"""Both directions, by mutation -- a lint that cannot fire is not a lint.

MUST FLAG: the shape that shipped in four places (one extension, three in the
daemon). MUST NOT FLAG: the shapes that are correct -- naming ProcessLookupError,
answering "alive" on EPERM, and a probe used for something that is not a verdict.

Every fixture is also mutated to prove the verdict is caused by the thing the rule
names, not by the fixture merely existing.
"""
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

HERE = Path(__file__).resolve().parent
LINT = HERE / "lint_liveness.py"
sys.path.insert(0, str(HERE))
import lint_liveness as L                                    # noqa: E402

# --- fixtures: the shapes we shipped, and the shapes we must allow -----------
MUST_FLAG = {
    "the daemon's three sites, verbatim":
        '''
        def live_pids(recs):
            out = {}
            for rec in recs:
                pid = rec.get("pid")
                alive = False
                if isinstance(pid, int) and pid > 0:
                    try:
                        os.kill(pid, 0)
                        alive = True
                    except OSError:
                        alive = False
                out[rec["label"]] = alive
            return out
        ''',
    "a bare except that answers dead":
        '''
        def probe(pid):
            try:
                os.kill(pid, 0)
            except:
                return False
            return True
        ''',
    "a result envelope with alive=False":
        '''
        def probe(pid):
            try:
                os.kill(pid, 0)
                return {"alive": True}
            except Exception:
                return {"alive": False}
        ''',
    "dead as one member of a returned pair":
        '''
        def probe(pid):
            try:
                os.kill(pid, 0)
                return True, "ok"
            except PermissionError:
                return False, "not permitted"
        ''',
}

MUST_NOT_FLAG = {
    "the fix: only ESRCH means gone":
        '''
        def pid_alive(pid):
            if not isinstance(pid, int) or pid <= 0:
                return False
            try:
                os.kill(pid, 0)
                return True
            except ProcessLookupError:
                return False
            except OSError:
                return True
        ''',
    "narrow handler, no ambiguity":
        '''
        def probe(pid):
            try:
                os.kill(pid, 0)
                return True
            except ProcessLookupError:
                return False
        ''',
    "EPERM read as alive":
        '''
        def probe(pid):
            try:
                os.kill(pid, 0)
                return True
            except PermissionError:
                return True
            except OSError:
                return True
        ''',
    "a kill that is not a heartbeat (signal 9, no verdict)":
        '''
        def stop(pid):
            try:
                os.kill(pid, 9)
            except OSError:
                return False
        ''',
    "the handler names ESRCH in its body rather than its clause":
        '''
        def probe(pid):
            try:
                os.kill(pid, 0)
                return True
            except OSError as e:
                if e.errno == ESRCH:
                    return False
                raise
        ''',
}

# --- mutations: each must flip the verdict for the stated reason -------------
FLAG_MUTATIONS = {
    "the daemon's three sites, verbatim":
        ("except OSError:", "except ProcessLookupError:", "it now names the one that means gone"),
    "a bare except that answers dead":
        ("return False", "return True", "answering alive is not a lie about absence"),
    "a result envelope with alive=False":
        ('return {"alive": False}', 'return {"alive": True}', "the envelope no longer says dead"),
    "dead as one member of a returned pair":
        ("return False, \"not permitted\"", "return True, \"not permitted\"", "no dead verdict"),
}
NONFLAG_MUTATIONS = {
    "the fix: only ESRCH means gone":
        ("except ProcessLookupError:", "except OSError:", "it now catches everything again"),
    "narrow handler, no ambiguity":
        ("except ProcessLookupError:", "except OSError:", "widened to the lie"),
    "a kill that is not a heartbeat (signal 9, no verdict)":
        ("os.kill(pid, 9)", "os.kill(pid, 0)", "signal zero makes it a liveness probe"),
}


def flags(src):
    return L.scan_source(textwrap.dedent(src))


def check(label, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {label}{('  -- ' + detail) if detail and not ok else ''}")
    return ok


def main():
    ok = True
    for name, src in MUST_FLAG.items():
        found = flags(src)
        ok &= check(f"flags: {name}", bool(found), "no finding, expected one")
        if found:
            ok &= check(f"  reason is stated: {name}",
                        "ProcessLookupError" in found[0][2] or "EPERM" in found[0][2],
                        found[0][2])

    for name, src in MUST_NOT_FLAG.items():
        found = flags(src)
        ok &= check(f"allows: {name}", not found,
                    f"flagged at line {found[0][0]}: {found[0][2]}" if found else "")

    for name, (old, new, why) in FLAG_MUTATIONS.items():
        mutant = MUST_FLAG[name].replace(old, new)
        ok &= check(f"mutation silences it ({why}): {name}", not flags(mutant))

    for name, (old, new, why) in NONFLAG_MUTATIONS.items():
        mutant = MUST_NOT_FLAG[name].replace(old, new)
        ok &= check(f"mutation makes it fire ({why}): {name}", bool(flags(mutant)))

    # --- the command contract: one command, no args, nonzero on a finding ----
    with tempfile.TemporaryDirectory() as tmp:
        dirty = Path(tmp) / "dirty.py"
        dirty.write_text(textwrap.dedent(MUST_FLAG["the daemon's three sites, verbatim"]))
        r = subprocess.run([sys.executable, str(LINT), str(dirty)],
                           capture_output=True, text=True, timeout=60)
        ok &= check("exit 1 on a finding", r.returncode == 1, f"exit {r.returncode}")
        ok &= check("prints file:line", f"{dirty}:" in r.stdout, r.stdout[:80])

        clean = Path(tmp) / "clean.py"
        clean.write_text(textwrap.dedent(MUST_NOT_FLAG["the fix: only ESRCH means gone"]))
        r = subprocess.run([sys.executable, str(LINT), str(clean)],
                           capture_output=True, text=True, timeout=60)
        ok &= check("exit 0 when clean", r.returncode == 0, f"exit {r.returncode}")

        # and the repo itself, since that is the reason this exists
        r = subprocess.run([sys.executable, str(LINT)],
                           capture_output=True, text=True, timeout=60)
        ok &= check("this repo is clean", r.returncode == 0, r.stdout[:200])

    print("\n" + ("all lint self-tests pass" if ok else "LINT SELF-TEST FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
