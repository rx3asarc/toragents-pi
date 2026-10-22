#!/usr/bin/env python3
"""pid_alive: "may I signal it" is not "is it running".

Four places in this repo answered the liveness question with `os.kill(pid, 0)` and
read any OSError as death. EPERM is not death -- it is a live process owned by
somebody else, which on a laptop is pid 1 and on a shared box is most things. So a
front desk that was very much alive read as gone, and untargeted mail went to the
next window that asked.

These tests exist because the wrong answer is invisible without them: the probe
returns a plausible boolean either way, and the only symptom is mail arriving at a
window that should not have had it.

The rule the tests pin, in one line: only ESRCH means gone.
"""
import errno
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import inbox_agent as ia                                          # noqa: E402


def raise_oserror(code):
    def _raise(*a, **k):
        raise OSError(code, os.strerror(code))
    return _raise


class PidAlive(unittest.TestCase):
    def test_1_a_live_process_is_alive(self):
        self.assertIs(ia.pid_alive(os.getpid()), True)

    def test_2_esrch_is_the_only_answer_that_means_gone(self):
        with mock.patch("inbox_agent.os.kill", raise_oserror(errno.ESRCH)):
            self.assertIs(ia.pid_alive(4242), False)

    def test_3_eperm_is_a_live_process_you_may_not_signal(self):
        # The bug: the same raise as ESRCH, so a handler that caught OSError could
        # not tell them apart, and every laptop has one of these -- pid 1.
        with mock.patch("inbox_agent.os.kill",
                        side_effect=PermissionError(errno.EPERM, "not permitted")):
            self.assertIs(ia.pid_alive(1), True)

    def test_4_an_unanticipated_error_is_not_evidence_of_absence(self):
        # EINVAL, EINTR, anything else: we do not know, and "do not know" must not
        # shut a window out of delivery. The cheap direction is a stale window that
        # reads mail it should not; the expensive one is mail delivered to nobody.
        with mock.patch("inbox_agent.os.kill", raise_oserror(errno.EINVAL)):
            self.assertIs(ia.pid_alive(999), True)

    def test_5_garbage_pids_are_false_without_probing(self):
        # kill(-1, 0) signals every process you own; kill(0, 0) the process group.
        # A recorded pid is read from a file, so validate before asking.
        for junk in (0, -1, None, "abc", 3.5, True):
            with self.subTest(pid=junk):
                with mock.patch("inbox_agent.os.kill") as k:
                    self.assertIs(ia.pid_alive(junk), False)
                    k.assert_not_called()

    def test_6_a_dead_pid_is_dead_when_the_os_actually_says_so(self):
        # No patching: the real syscall, one pid that cannot exist.
        self.assertIs(ia.pid_alive(999_999_999), False)

    def test_7_the_three_call_sites_use_the_one_answer(self):
        # The lint enforces this by shape; this asserts the wiring, because a helper
        # that exists and is not called is the failure this repo keeps having.
        import lint_liveness                                          # noqa: E402

        path = os.path.join(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))), "inbox_agent.py")
        with open(path) as f:
            src = f.read()
        self.assertEqual(lint_liveness.scan_source(src, path), [],
                         "a liveness probe outside pid_alive() -- it infers death")
        self.assertGreaterEqual(src.count("pid_alive(pid)"), 3,
                                "the call sites stopped using the helper")


if __name__ == "__main__":
    unittest.main(verbosity=2)
