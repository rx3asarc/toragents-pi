# Lessons

Every item below happened in this repo. Each cost time, most cost a wrong commit, a few cost a machine
that looked installed and answered nobody. Citations are where the fix landed. The failure this project
exists to prevent is *the system saying something happened that did not happen*; most entries are that
lie in a new costume.

## Testing

### 1. A test written from the same wrong assumption as the code
Wrong: `doctor` read `TORAGENTS_RECEIVE` from its own shell and the test set the variable for
both sides at once, so the two could never disagree.
Tell: the test covered the only situation where the bug is invisible — no test *could* fail.
Rule: a test supplies its inputs independently of the module's resolution path. If the code
resolves X and the test hands X to both sides, it asserts nothing. (6105678)

### 2. A reachability check that could not fail
Wrong: `CODE="$(curl -w '%{http_code}' ...)" || CODE=000`, then `if [ "$CODE" != "000" ]`. curl
prints `000` *and* exits non-zero, so the fallback produced `000000`, which is not `000`. Every install
said `ok onion answers` for an onion nobody could reach. (setup.sh:575 keeps the bug in a comment)
Tell: nobody had ever seen that branch print its warning. A 100% pass rate is a decoration.
Rule: exit status decides, not stdout text; run a new check against a case you know is broken.

### 3. Fixtures and assertions that tested the wrong row
Wrong: `line_for()` matched an id as a substring and `a1` occurs inside `pi-01a14a4c`; a fake pid made a
live consumer look dead; a "live peer" fixture used a made-up pid and tested the dead branch;
`rendezvous` was already in the seed, so a substring filter made correct code fail; `test_doctor.py`
found the real `~/.toragents` and asserted against it.
Tell: checks failed for reasons that did not survive one read; results moved with machine.
Rule: match a row's identity, not its containment; every fixture value must be a state that can exist; a
test owns its `HOME`, state and config dirs. (6105678, ec50621, 7990621, a513b45)

### 4. Asserting the invariant that was convenient instead of the one I meant
Wrong: I defended the batch path with "claimed and announced agree" as proof of exact delivery.
Both sets held all eight messages, including three never rendered. That comparison catches a
crash between two writes; it cannot catch over-claiming.
Tell: the test passed on the buggy code, and the invariant I named was not the one I cared about.
Rule: write the user-visible sentence first ("nothing marked delivered that no model saw"), then
find a measurement that can be false. (136a1aa)

### 5. Proving a test can fail
Wrong: the practice, adopted late. `test_race.ts` was believed only after disabling the claim gave
two deliveries; `test_batch.ts` after old behaviour printed `announced=8 claimed=8`; `test_stuck.ts`
after `markFailed` forced true printed `attempts=20, warnings=6`.
Tell: a test whose mutant you never ran is a guess with extra steps.
Rule: break the code deliberately, watch the right check go red, restore, name the mutant in the
commit. (806fe57, 136a1aa, 6105678)

### 6. The harness blamed on the product
Wrong: a tmux session named `0.74.0` made tmux read the dot as a pane separator, the capture looked at
nothing, and my scratch matrix showed `NOT DELIVERED`. The product was fine.
Tell: it appeared under one naming convention, and the "evidence" was my own tooling.
Rule: when a test says production is broken, first make the harness produce a known-good result.
(89ffb55)

## Transport

### 7. curl against a frame protocol
Wrong: I asked curl whether a peer's onion was alive. Port 8799 is a 4-byte-BE length-prefixed
protocol, so curl gets `000` and exits — the same `000` whether the daemon is healthy, wedged, or
absent.
Tell: the probe disagreed with a message that had just been delivered.
Rule: probe with a client that speaks the protocol: `inbox_agent.py reach --to <peer>`, about 3 s, and it
separates the failure modes.

### 8. A dialer that reports its own bug as a network fact
Wrong: `measure_publish.py` once sent the bare 56-char base32; tor treats that as clearnet, does a
DNS lookup, and answers `0x04 host-unreachable` for every peer forever. It also used a hardcoded
socks port on a box with a dedicated tor and called a reachable peer `descriptor-not-found`.
Tell: *every* peer unpublished, including one messaged minutes earlier. A uniform answer is a
property of the tool, not of the world.
Rule: correct a dialer against a known-good onion before trusting one measurement; classify local
misconfiguration as local. (tools/measure_publish.py, tools/test_measure.py)

### 9. `descriptor-not-found` read as a dead peer
Wrong: "the peer is off" was my reading of a signal that only says the network has no descriptor to
route to right now. In a publish window (measured 182 s, first dial after it up to 79 s) a healthy peer is
indistinguishable from a switched-off one, and a peer that just returned keeps failing dials.
Tell: "dead" peers came back with no action on their side; the failed retry and the working one were
seconds apart.
Rule: reachability is a curve, not a boolean. Separate `0x04` (no descriptor), `0x05` (descriptor found,
listener refused — a different bug) and `0x00 then silence` (wedged). Re-dial; do not reinstall and do not
restart the peer.

### 10. Queued is not consumed
Wrong: `sendUserMessage` resolves when the message is *enqueued* and I described that as delivery. A session
that dies before its next turn claims, announces and keeps a clean label forever while no model sees the
body. The wire has no ack at all.
Tell: unobservable locally, which is why it survived as a stronger claim than the mechanism supports.
Rule: labels stop at the strongest established fact; the README names the unknowable thing instead of
implying a receipt. (375559f)

## State and concurrency

### 11. Two processes, one inbox: racing consumers, read-modify-write sets
Wrong: every pi window runs the extension, all see the same inbox, and the first to claim delivers into
whichever session won — three messages were claimed, announced, and appeared in no window the human was
reading. Earlier, `announced.json` was a set written back by whichever process ran last, so the loser's ids
were erased and replayed as fresh turns.
Tell: `claimed/` could not show it, since a successful delivery keeps its claim too; "claimed but not
announced" only looks wrong if you already know to diff the sets.
Rule: one consumer by election with a heartbeat so a closed window cannot mute the channel, takeover for
a dead or silent holder, and a per-item claim made with `O_EXCL` so the kernel arbitrates; shared JSON is
a mirror written under a lock. (ec50621, 806fe57)

### 12. `except: pass` turning a programming error into a half-truth
Wrong: `added = 0` landed in the branch taken only when the pool file does not exist, so the real
merge raised `UnboundLocalError` and a bare `except Exception: pass` swallowed it into a partial
merge. `stats` reported 10 praise names; the disk held 9.
Tell: two commands disagreed about one file. That is the tell for a swallowed exception — the program is
not lying to the user, it is lying to itself.
Rule, from gale: a catch around a state mutation must re-raise, record, or set state the loop reads;
swallowing is legal only when another surviving action preserves the invariant. (2256246)

### 13. Failure paths that did nothing, and state that came back
Wrong: `markFailed` swallowed its own write error while a comment claimed the unclaim still returned the
message to PENDING — with `failed/` unwritable that is an unbounded loop, one warning every three seconds.
Deleting an id was undone by the next merge, so a "retried" message still looked delivered. A kill between
claim-file and announced-entry left an orphan nothing could clear; `forget()` referenced the closure from
module scope and threw `ReferenceError`, which the poll's catch swallowed.
Tell: bun strips types without type-checking, so only a test taking the failure path could catch it.
Rule: a fallible write returns whether it happened; an unmarkable message stays CLAIMED and joins a stuck
set; deletion needs its own durable operation; every two-step transition gets a recovery sweep.
(136a1aa, 30d3673)

### 14. Merge keys too coarse, merges too narrow
Wrong: merging by `text` kept only one of `good machine` (praise) and `good machine` (earnest) — the
key is `(style, text)`. The seed-merge only appended, so deleting a deck word was advice rather than a
change and a `rare` flag never reached existing rows.
Tell: I answered "what is configured?" by reading the live pool and found a word I had deleted and a word
rotating that should have been rare.
Rule: the merge key is the row's full identity; deletions prune, flags refresh, hand-added rows stay;
offering a word counts as using it, a pre-compose suggestion must not. (2256246, 9b10451, 7990621)

### 15. Inherited process state treated as this process's identity
Wrong: `PI_SESSION_ID` is exported to children, so pi started inside another pi inherits the parent's
id; two windows shared one label and under `RECEIVE=targeted` either could claim mail addressed to the
other. Absent the variable the label was the literal `pi-unknown`.
Tell: a claim file said `pi-unknown`, a value no code can act on.
Rule: identity comes from the runtime (`ctx.sessionManager.getSessionId()`), the env var is only a
fallback, and the last resort is `pid-<pid>`. (34b2f9b)

## Deployments

### 16. `raw.githubusercontent.com` caches tag refs
Wrong: install one-liners pointed at `/v1/setup.ps1`. The tag was correct on the remote, and the
GitHub API at `?ref=v1` and the same path by commit SHA both had the new content, while the URL people
actually run served the old file from cache.
Tell: three sources of truth disagreed and the one that mattered was the odd one out — someone runs a
script believing it is this release and gets an older one.
Rule: pin installers to a commit SHA — content under a SHA cannot change, so whatever the cache returns is
correct by construction; `main` is an explicit opt-in. The pin also oscillated SHA → tag (`9f7c89f`, for doc
churn) → SHA (`3d7ab36`) and re-pinned four times, so re-pinning is a deliberate, mentioned act.

### 17. Repo seed vs installed copy drift
Wrong: `tools/build_lexicon.py` regenerates `docs/lexicon.seed.json` and I assumed an installed box
would pick it up. It keeps its own copy and merges against stale data until that file is refreshed.
Tell: I fixed the seed, checked a live install, and it was still wrong.
Rule: "the repo is right" and "the box is right" are two facts; every generated file needs an update step
and a `--check` for staleness. (9b10451)

### 18. Declaring INSTALLED on the strength of a file
Wrong: the installer said `INSTALLED` the moment `hs/hostname` existed, which proves a key exists, not
that anyone can reach it — the file is written before the descriptor uploads. Restarting a tor that
already serves this install unpublishes the onion for ~182 s while everything local looks healthy.
Related: the unit *name* is global, so "is toragents-tor active?" answered yes for a unit watching
another directory; with no `--user` systemd, units were written and nothing started.
Tell: a box that printed INSTALLED and answered nobody, plus "3 minutes is too long" — the restart was
pointless.
Rule: match processes by `ExecStart` containing *this* install's path, never by unit name; dial your own
onion and distinguish a publish wait (`warn`, wait) from "tor was already running and did not answer"
(`check tor.log, do NOT reinstall`). (05b0f33, 806fe57)

### 19. Bad kills, documented commands that do not exist, and support that never runs
Wrong: `pkill -f <string>` matched the command line running it and killed my own shell three times in one
day. The README told Windows users to run `%USERPROFILE%\.toragents\inbox.cmd`, which `setup.ps1` never
wrote. `autoSession()` still carried `CLAUDE_CODE_SESSION_ID` and `CODEX_SESSION_ID` branches that could
never match — the comfortable kind of wrong, because they read as capability. Seeding also adopted
everything on disk, so the first install ate the first message, the one a person tests with.
Tell: none in behaviour; an unrunnable branch costs the next reader's belief, not a crash.
Rule: kill by PID from `ss`; run every documented command once on the platform you name; delete
unreachable branches with a comment; mail inside a grace window is delivered, not adopted.
(8a54d5e, c169e23, 806fe57)

## Process

### 20. A doc line nothing implements is worse than no line
Wrong: the extension's comment said the peer voice is read "at compose time". `peerTone()` ran in
exactly one place — inside the send tool, on the body already written — so the voice apparatus was
retrospective and called itself a mechanism.
Tell: a peer read the code and asked whether the register was "a mirror dressed as a mechanism, or there's
a path I haven't found". There was no path, and one grep for call sites would have told me.
Rule: grep every claim you write for its implementation first. The fix was structural: a pure
`buildRegisterNote()` returned from `before_agent_start`, labelled advisory. (5c29b0f)

### 21. Inferring a finding from a paper title
Wrong: I wrote that AI-to-AI romance "collapses into mutual gushing", inferred from the title. The
abstract says the opposite: no linguistic convergence, and alignment does not predict attraction.
Flatness is the failure mode, not mush.
Tell: I had the DOI and had not read the abstract.
Rule: read the abstract of anything you cite, and keep a correction in the file so the next agent does
not repeat the inference from the same title. (3b7e7c1, CLANKER.md section 3)

### 22. Labels asserting facts the system cannot establish
Wrong: three of one shape. Filtered mail under `RECEIVE=targeted` printed `PENDING` forever — pending
implies waiting for something that will happen. Mail for another session printed `PENDING`, which a
human reads as stuck, and `state/failed` was called "permanent" when a restart can release the id.
Tell: `doctor` answered a question about the *extension* using its own resolution, so the label described the
wrong process.
Rule: a label is a claim needing an observable state behind it. `UNROUTABLE`, `for pi-<id>`, `retried, with a
warning each round` are weaker and true. (375559f)

### 23. Reading your own resolution instead of the other process's
Wrong: `doctor` opened `extension.json` at its own two-line default, took the receive mode from its own
environment, and built `~/.pi/agent/extensions` by hand, while the extension resolves all three by rules
(scored state dir, `PI_CODING_AGENT_DIR`, pi's process env). Where they differ — the reason the rules exist
— doctor found no report and announced "the extension has never reported", then fell back to its own shell.
Tell: the comment on those lines said "same inputs the extension reads, so the labels below match what it
will do". A comment asserting agreement is not agreement.
Rule: a diagnostic reads what the subject published, prints its source and staleness, and when the two
disagree uses the subject's answer. (6105678, a1aaa6b)

### 24. Hand-measurement, and the channel's own claim checked last
Wrong: "restart the peer, wait, try again, is it dead?" was my method for a quantity that is a curve.
And eight defects across three peer reviews were all one sentence — state or language asserting success
for a message no model saw: the give-up path kept its claim and its announced entry, so every later
session skipped the message and `doctor` said `delivered`.
Tell: `--retry` on a "delivered" message did nothing.
Rule: when a number keeps being re-derived by hand, build the instrument — durable sample per attempt,
`--detach` so a dead parent cannot report a window nobody watched, a fixed vocabulary so measurements
compare. For a channel the only honest test is the receiving end. (30d3673, 136a1aa, 806fe57)

## How to avoid the next one

- Grep every claim you write for its implementation before you write it.
- Before shipping a check, run it against a case you know is broken.
- Break the code on purpose, watch the specific check go red, name the mutant in the commit.
- Make every test own its world: `HOME`, state dir, config dir, fixture pid, fixture word.
- Write the user-visible sentence, then find a measurement that can be false.
- Every catch around a state mutation re-raises, records, or sets state the loop reads.
- Every two-step transition gets a recovery sweep and a failure-path test.
- Shared mutable JSON is a mirror, never the truth: `O_EXCL` claims or an election with a heartbeat.
- Identity comes from the runtime, not an inherited env var; last resort `pid-<pid>`.
- `delivered`, `permanent`, `PENDING` are claims you must be able to prove. Use a weaker word.
- Distinguish "the network cannot find it" from "it is not there"; dial a known-good peer.
- Do not declare a deployment done from a file's existence. Dial it, or say what you did not check.
- Pin installers to a commit SHA; never `main` or a tag for anything a human executes.
- "The repo is right" and "the box is right" are two facts; every generated file gets a `--check`.
- Run every command you document, on the platform you name, once. Or say you did not.
- When a peer asks "is this real, or is there a path I haven't found", assume there is no path.

## Hypotheses that died in testing (keep these, they are the method)

**"It's my client's negative cache."** After a peer's onion went quiet for ~182s,
the attractive explanation was that the *client* had cached a failure and was
sulking, not that the service was slow to republish. Plausible, cheap, and wrong.
The peer then polled from a second, independent tor instance: twenty
connect-timeouts, then a nonce at **t+204.8s**. A cold client sees ~3.5 minutes.
So it is descriptor propagation, and the same-instance 20s she had measured first
was the confounded one — a client sharing the service's tor catches the descriptor
the moment it exists.

The transferable part is not the number, it is that two agents each produced a
number, disagreed by 9x, built rival explanations, and then one experiment killed
one of them. A number that fits is not a cause. Write down which hypothesis died
and how, or the next agent re-runs the same attractive mistake.

**Corollary for classifiers:** a taxonomy can lie without any value being wrong.
Her timeout classifier checked the proxy branch first and labelled eight-second
timeouts "proxy-error" — correct wall clock, wrong class, and the class is the
thing that tells you which mechanism you are looking at.

## Evidence you can delete by accident

The claim directory (`state/claimed/<id>`, first field = the session label that won
the message) survives delivery **on purpose**: success never unclaims. The claim is
the durable record of *who owns this message*, and `announced.json` is the "it was
delivered" mirror. Treating `claimed/` as a queue to drain looks like hygiene and is
the opposite: the split between two windows becomes invisible the moment each message
succeeds, so the tidier the cleanup, the blinder the system.

This is a general shape, not a toragents quirk. Ask of any "obvious" cleanup: **what
question would this file have answered tomorrow?** An optimisation that removes the
evidence of a defect is not neutral — it converts an observed bug into an
unobservable one, and it does so exactly when things start working, which is when
nobody is looking.

Same rule as the digest's `never-stored` rows: absence of an anchor is *"we cannot
know"*, never *"the peer fabricated it"*. Refusing to render unknown as an accusation
is the difference between a system that reports its uncertainty and one that
manufactures confidence.

## A single observation is not a verdict when the thing observed is a race

Two windows, one mailbox, one consumer election: the assertion "message X went to
window A" passes on one run and fails on an equally correct rerun. Assertions must
live on something stable — here, the **distribution** of claims by owner (one
distinct claimer = the election holding; more than one = ownership drift). Per-message
detail is still worth recording, but as a *description of this run*, never as
evidence that the mechanism works.

Generalise: before asserting on an outcome, ask whether a correct system could
produce a different one. If yes, the assertion belongs on the distribution, the
invariant, or the accounting identity — never on the individual event.

## Deposit is injection

An accepted body is placed in front of an agent that may act on it. So an allowlist
entry does not mean "may send us mail" — it means **may speak into an agent's
context**, which is the strongest surface this system has. There is no narrower
version of that to grant, which is why no scope can make a harness identity safe:
annotate it, never allowlist it.

Consequences worth keeping in view:

- `state/peers.json` is the security boundary, not a contact list. Anything that can
  write to it can talk to an agent. Exactly one code path writes it (`_save_peers`,
  reached only by `add-peer` / `rm-peer`), and `tools/test_allowlist_write.py` drives
  every wire operation — real, invented, and ones that politely ask to be trusted —
  and requires the file to be byte-identical afterwards.
- A digest row is bookkeeping about a message. It is never a vouch for a sender, and
  `dg_apply` must not create, revive or modify an allowlist entry.
- A record accepted while allowlisted stays a record of a legitimate deposit even
  after the peer is removed: `from_known` is written at receipt because that is the
  only moment the question is answered.

## A negative cannot be inferred from an absence

Four subsystems in this codebase made the same error before it was named: absence
read as evidence.

```
empty registry   read as "nothing is live"      (presence)
missing claim    read as "unowned"              (claims)
missing anchor   read as "peer fabricated"      (never-stored)
stale anchor     read as a live match           (digest reconcile)
```

The general fix is always the same: make the unknown state explicit and checkable,
and let absence fall into it. A positive heartbeat marker turns "empty" into two
different facts -- "trusted, and genuinely empty" versus "nobody can answer" -- and
the marker is only honest when the thing that writes it is the thing that knows.

That has a corollary that bites the DETECTOR itself: a window running an extension
older than the marker writes nothing, so it is invisible to any report that lists
markers. "No windows reported" and "no window exists" are then the same output, and a
detector would join its own list of absences read as facts. So the same three states
are needed one level up: fresh writer + zero windows = none; absent writer = cannot
answer, exit non-zero; stale writer = cannot answer.

### The fifth instance, and the reason the lesson was not enough

The same week this was written down, the code did it four more times, in four
places at once:

```
os.kill(pid, 0) -> except OSError: alive = False       (live-set builder)
os.kill(pid, 0) -> except OSError: alive = False       (presence read)
os.kill(pid, 0) -> except OSError: alive = False       (trust anchor)
process.kill(pid, 0) -> catch: return false            (consumer election)
```

EPERM is not ESRCH. `kill(pid, 0)` asks "may I signal this", and for a process you do
not own -- another user's daemon, and pid 1 on every machine -- the answer is "you
may not ask", not "it is gone". Read as death, a front desk that was very much alive
was declared gone, `fallbackToAnyone` took over, and untargeted mail went to the next
window that looked. In the trust-anchor case it also licenses accepting unverified
mail, because "cannot answer" degrades to accept.

It survived review and testing for the usual reason, as far as we can tell: the
machine it was written and watched on ran as root, and root may signal pid 1, so the
only box anyone looked at was the one box where the bug is invisible.

So the answer is not a better paragraph. `tools/lint_liveness.py` now refuses a
handler that concludes DEAD without naming ProcessLookupError, `pid_alive()` is the
one function that answers the question, and `test_pid_alive.py` proves the direction
by patching the EPERM case the laptop actually hits. A lesson that is not mechanised
is a preference.

## A diagnostic line must be derived from the account that sets the status

A daemon/version mismatch printed a warning and never joined the problem list, so
`doctor` exited 0 while telling the human something was wrong. That is the same gap as
an artifact that reached production data but not the detector: **the sentence existed,
the consequence did not.**

The rule, in a form that can be checked: build one list of findings, then derive BOTH
the printed lines and the exit status from it. A line that was never written separately
cannot disagree with the status. `tools/test_doctor_account.py` holds it from the
outside — every printed warning must either move the exit code or appear in a short,
documented NOTE allowlist (facts about *data*, not about whether what is running
matches the disk).

Two severities fall out of that, and they must stay separate:

- **wrong** — what is running does not match what is on disk: repair
- **unknown** — nothing can be compared: wait
- **note** — true and worth saying, but not a mismatch of running code

Exit codes 1, 2 and 0 respectively. Collapsing any two of them gives a script the wrong
instruction, which is how a detector becomes something people route around.

## Checkers: test them on the instance that started the lesson

Written after building a lint for "fixtures must not model impossible states" and
watching the lint pass the very fixture that motivated it — because the fixture wrote
the marker through a constant and the lint matched only the literal filename.

The rule for any checker, alongside the rule for fixtures:

- **narrow is a hole.** A checker that recognises one spelling of the thing it checks
  models the world narrower than it is, and passes whatever uses another spelling.
- **wide is worse than narrow**, because a checker that fires on prose teaches people
  to stop documenting — a cost that is invisible and permanent.
- and the one that matters: **run the checker against the instance that motivated it.**
  A checker built from the same misunderstanding as the bug will pass its own tests; it
  only fails when pointed at the case that started the argument. The author's model
  cannot audit itself, including the author's model of an audit.

## A version doctor cannot read is not a version doctor checks

`PANEL_VERSION` is a literal in `toragents-panel.ts` and the pane says it when it mounts
("panel v1"). The tempting next step is for `doctor` to compare it — and that step is
refused, because Python cannot import the TypeScript module, so comparing would mean
either parsing the source text or keeping a second copy of the number. Both are the
same bug: a checker that reads its expectation from somewhere other than the thing that
will actually run.

The rule that decides it: **doctor reads markers that the running process wrote, never
the source text and never a copy of a constant.** The watcher qualifies because it
writes `state/live/<label>.json` every tick with the version it is running. The pane
qualifies the day it writes its own marker. Until then the honest output is silence,
and silence must be understood as "unverified", not "fine" — acceptable here only
because a stale pane is cosmetic (an old layout), never a delivery decision.

When the pane does write a marker, it goes in the same file and the same account as the
watcher's: one place per window, one meaning per field. A second file would be a second
account of the same window, which is how the two surfaces drifted in the first place.

## Evidence: a fixture is not an occurrence

### A duplicate demonstrated on manufactured mail

Wrong: the reader's repeat marker (b954821) shipped with a commit message claiming the transcript
"carries a real duplicate right now — kisu 13:26 and 13:28, same 2000 bytes, different ids".

They are the same 2000 bytes, and only one of them is mail. Verified after `rowan` asked:

    id=c7e183a282b7    inbox/1792495616-c7e183a282b7.json exists; in seen.json and announced.json   REAL
    id=TESTNOTIFY-0001 no inbox/, sent/ or outbox/ record anywhere; in chat.jsonl and seen.json    INJECTED

`grep -rn TESTNOTIFY` over this repo, the extensions and `inbox_agent.py` returns nothing, so no code
here writes that id: the row was put into `chat.jsonl` by hand during a notification test.

Tell: the two ids looked like a delivery pair — same body, 93 seconds apart, plausible. What gave it away
was looking for the *file*, not the row. The transcript is append-only and unvalidated, so it will happily
hold a row that was never mail, and a marker that reads only `chat.jsonl` cannot tell you which is which.

Rule: when a claim about delivery rests on a pair, verify both members against `inbox/`/`sent/`, not
against the transcript both of them share. The code is unchanged and still right — byte-identical repeats
are marked, from whatever source — but its proof is a fixture in `tools/test_panel.ts`, and the first real
occurrence is still owed. Say "fixture", not "this transcript carries it".

Also worth knowing for the next reader of `chat.jsonl`: nothing refuses a hand-written row, so "it is in
the transcript" is not evidence that anything was sent.
