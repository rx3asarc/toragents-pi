#!/usr/bin/env python3
"""Ban the liveness probe that infers death from an error it cannot read.

The question a probe answers is "is this process running". The question
os.kill(pid, 0) answers is "may I signal this process". Those are the same answer
only for processes you own. For everything else -- another user's daemon, and pid 1
itself -- the call raises PermissionError (EPERM) on a process that is very much
alive, and a handler that reads any OSError as "dead" turns "I was not allowed to
ask" into a fact about the world.

This repo has a lesson about that shape (docs/LESSONS.md, "A negative cannot be
inferred from an absence") and made the mistake four more times anyway, in one
extension and three places in the daemon. That is what a lesson without a checker
is worth, so this is the checker.

The rule is narrow on purpose: a handler that concludes DEAD must NAME the one
error that means dead -- ProcessLookupError (ESRCH). A handler that concludes ALIVE
is not a lie about absence and is allowed. A handler that names nothing is the
defect, because "any error" includes the errors that mean the opposite.

Usage:  python3 tools/lint_liveness.py [paths...]     (no args = this repo)
Exit:   0 = clean, 1 = findings, 2 = the lint itself failed.
"""
import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Call names that ask about a pid without touching it.
PROBES = {"kill", "killpg"}

# The only name that means "no such process" on every platform this runs on.
DEAD_NAMES = {"ProcessLookupError", "ESRCH"}

BROAD = {"Exception", "BaseException", "OSError", "IOError", "EnvironmentError"}


def _call_name(node):
    if not isinstance(node, ast.Call):
        return None
    f = node.func
    return getattr(f, "id", None) or getattr(f, "attr", None)


def _is_liveness_probe(node):
    """kill(pid, 0) / os.kill(pid, 0) / process.kill(pid, 0) -- signal zero."""
    if _call_name(node) not in PROBES:
        return False
    for arg in node.args:
        if isinstance(arg, ast.Constant) and arg.value == 0:
            return True
    return False


def _names_dead(handler):
    """Does the handler's own text carry ProcessLookupError / ESRCH?"""
    for sub in ast.walk(handler):
        if isinstance(sub, ast.Name) and sub.id in DEAD_NAMES:
            return True
        if isinstance(sub, ast.Attribute) and sub.attr in DEAD_NAMES:
            return True
        if isinstance(sub, ast.Constant) and sub.value in DEAD_NAMES:
            return True
    return False


def _handler_names(handler):
    """The exception names a handler catches, as written."""
    if handler.type is None:
        return ["<bare>"]
    t = handler.type
    if isinstance(t, ast.Name):
        return [t.id]
    if isinstance(t, ast.Attribute):
        return [t.attr]
    if isinstance(t, ast.Tuple):
        out = []
        for elt in t.elts:
            out.extend([elt.id] if isinstance(elt, ast.Name) else
                       [elt.attr] if isinstance(elt, ast.Attribute) else ["?"])
        return out
    return ["?"]


def _concludes_dead(handler):
    """A False going into a verdict: the handler is answering 'gone'."""
    for sub in ast.walk(handler):
        if isinstance(sub, ast.Return) and isinstance(sub.value, ast.Constant):
            if sub.value.value is False:
                return True
        if isinstance(sub, ast.Assign) and isinstance(sub.value, ast.Constant):
            if sub.value.value is False:
                return True
        # alive = False, or return {"alive": False} / (False, reason)
        if isinstance(sub, ast.Dict) and any(
                isinstance(v, ast.Constant) and v.value is False
                for v in sub.values):
            return True
        if isinstance(sub, ast.Tuple) and any(
                isinstance(v, ast.Constant) and v.value is False for v in sub.elts):
            return True
    return False


def scan_source(src, filename="<fixture>"):
    """Return findings: (line, handler text, why)."""
    try:
        tree = ast.parse(src, filename=filename)
    except SyntaxError as e:
        return [(e.lineno or 0, "<syntax error>", f"could not parse: {e.msg}")]
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Try):
            continue
        if not any(_is_liveness_probe(n) for n in ast.walk(node)):
            continue
        for handler in node.handlers:
            names = _handler_names(handler)
            if any(n in DEAD_NAMES for n in names):
                continue                      # it named the one that means gone
            if _names_dead(handler):
                continue                      # the body names ESRCH / ProcessLookupError
            if not _concludes_dead(handler):
                continue                      # answering "alive" is not a lie
            caught = ", ".join(names)
            why = (f"concludes dead on `except {caught}` without naming "
                   f"ProcessLookupError: EPERM is a live process you may not signal")
            out.append((handler.lineno, f"except {caught}", why))
    return out


def main(argv):
    paths = [Path(p) for p in argv[1:]] or sorted(ROOT.glob("*.py"))
    findings = 0
    for p in paths:
        try:
            src = p.read_text()
        except OSError as e:
            print(f"lint could not read {p}: {e}", file=sys.stderr)
            return 2
        for line, text, why in scan_source(src, str(p)):
            print(f"{p}:{line}: {text} -- {why}")
            findings += 1
    if findings:
        print(f"\n{findings} liveness probe(s) infer death from an unnamed error.")
        print("Ask one function: pid_alive() answers it with EPERM treated as alive.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
