#!/usr/bin/env bun
/**
 * Designation: who READS untargeted mail, by policy instead of by race.
 *
 * Delivery ownership was first-come — whoever wrote consumer.json first held it until
 * they died — which answers "who got there first", not "who should read this". A human
 * who wants one window to be the front desk could not say so.
 *
 * The rule lives in one exported pure function (mayClaimOwnership) so it can be
 * asserted instead of described, and the three failure modes are each given a case:
 *
 *   designated receiver        claims, always
 *   non-receiver, desk live    stays passive (this is the whole point)
 *   non-receiver, desk GONE    takes over when fallbackToAnyone — a closed front desk
 *                              must not mute the channel
 *   non-receiver, fallback off stays passive even when the desk is gone (quiet box)
 *
 * And the naming trap, which is the bug that would make designation silently useless:
 * policy keys are session NAMES ("rowan"), consumer.json stores pi-<id>. Both are now
 * written, and the comparison prefers the name — so a window whose name matches is
 * recognised even though its id never could.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mod from "../toragents_watch.ts";

const checks: Array<[string, boolean]> = [];
const now = Date.now();
const mk = () => {
	const d = mkdtempSync(join(tmpdir(), "designation-"));
	const S = join(d, "state");
	mkdirSync(S, { recursive: true });
	return { d, S };
};
const policy = (d: string, obj: any) => writeFileSync(join(d, "policy.json"), JSON.stringify(obj));

// A live pid for the "desk": pid 1 is genuinely alive. A dead pid is deliberately
// made up, so the takeover case tests death rather than absence.
const desk = { pid: 1, session: "pi-deskid", name: "rowan" };
const other = { pid: process.pid, session: "pi-otherid", name: "stella" };

// 1. no policy file at all -> first-come, exactly as before
{
	const { S } = mk();
	const r = mod.electConsumer(S, other, now);
	checks.push(["no policy: first session claims (behaviour unchanged)", r.tookOver]);
	checks.push(["no policy: readPolicy reports nothing loaded", !mod.readPolicy(S).loaded]);
}

// 2. the designated receiver claims even when someone else got there first
{
	const { d, S } = mk();
	policy(d, { receiver: "rowan" });
	mod.electConsumer(S, other, now);                       // a non-receiver got there first
	const r = mod.electConsumer(S, desk, now + 1000);        // the desk arrives
	checks.push(["designated receiver takes delivery from a non-receiver", r.tookOver]);
	checks.push(["...and the file records the NAME (what the policy compares)",
		JSON.parse(readFileSync(join(S, "consumer.json"), "utf8")).name === "rowan"]);
}

// 3. a non-receiver stays passive while the desk is live
//
// The desk writes its own heartbeat, and since 22 Oct that heartbeat is part of how
// "live" is established: a probe that cannot signal the desk answers `unknown`, and the
// owner's own record is what turns unknown into "present". A fixture without one would
// be describing a desk that left no trace -- which is a different test, and it is case 8.
{
	const { d, S } = mk();
	policy(d, { receiver: "rowan" });
	mod.electConsumer(S, desk, now);
	mkdirSync(join(S, "live"), { recursive: true });
	writeFileSync(join(S, "live", "desk.json"), JSON.stringify({ pid: desk.pid, at: now }));
	const r = mod.electConsumer(S, other, now + 1000);
	checks.push(["a non-receiver does NOT take untargeted mail from the desk", !r.tookOver]);
	checks.push(["...and says why", /designated receiver/.test(r.reason)]);
	checks.push(["...and reports the desktop as the owner", r.owner === "rowan"]);
}

// 4. the desk disappears -> fallback keeps the channel alive
{
	const { d, S } = mk();
	policy(d, { receiver: "rowan", fallbackToAnyone: true });
	writeFileSync(join(S, "consumer.json"), JSON.stringify({ pid: 987654, session: "pi-deadid", name: "rowan", at: now }));
	const r = mod.electConsumer(S, other, now + 10);
	checks.push(["fallback: a non-receiver takes over when the desk is gone", r.tookOver]);
}

// 5. fallback turned OFF -> a quiet box stays quiet
{
	const { d, S } = mk();
	policy(d, { receiver: "rowan", fallbackToAnyone: false });
	writeFileSync(join(S, "consumer.json"), JSON.stringify({ pid: 987654, session: "pi-deadid", name: "rowan", at: now }));
	const r = mod.electConsumer(S, other, now + 10);
	checks.push(["no fallback: a non-receiver never claims, even with the desk gone", !r.tookOver]);
}

// 6. the naming trap: a window whose NAME matches is recognised even though its id
// could not, and the reverse (id matches, different name) does not fool it
{
	const { d, S } = mk();
	policy(d, { receiver: "rowan" });
	// A non-receiver holds delivery; the window whose NAME is the designation arrives
	// with an id the file has never seen. It must be recognised as the receiver.
	writeFileSync(join(S, "consumer.json"), JSON.stringify({ pid: 1, session: "pi-stellaid", name: "stella", at: now }));
	const named = mod.electConsumer(S, { pid: process.pid, session: "pi-whatever", name: "rowan" }, now + 5);
	checks.push(["a window named rowan is recognised as the receiver despite a new id", named.tookOver]);
	const impostor = mod.electConsumer(S, { pid: process.pid, session: "pi-zzzzzzzz", name: "mallory" }, now + 10);
	checks.push(["a window with the receiver's ID but not its name is NOT the receiver", !impostor.tookOver]);
}

// 7. the pure rule, stated directly
{
	const p = { receiver: "rowan", fallbackToAnyone: true };
	checks.push(["rule: receiver always may", mod.mayClaimOwnership("rowan", { alive: true, fresh: true, name: "rowan" }, p)]);
	checks.push(["rule: non-receiver may not while the desk is live",
		!mod.mayClaimOwnership("stella", { alive: true, fresh: true, name: "rowan" }, p)]);
	checks.push(["rule: non-receiver may when the desk is dead",
		mod.mayClaimOwnership("stella", { alive: false, fresh: true, name: "rowan" }, p)]);
	checks.push(["rule: non-receiver may not when fallback is off",
		!mod.mayClaimOwnership("stella", { alive: false, fresh: true, name: "rowan" }, { receiver: "rowan", fallbackToAnyone: false })]);
	// The receiver-always branch needs a case the fallback cannot satisfy, or the two
	// paths pass for each other: with fallback OFF, only the designation can explain a
	// claim.
	checks.push(["rule: the receiver may claim even with fallback off",
		mod.mayClaimOwnership("rowan", { alive: true, fresh: true, name: "stella" }, { receiver: "rowan", fallbackToAnyone: false })]);
	checks.push(["rule: no designation means anyone may",
		mod.mayClaimOwnership("stella", { alive: true, fresh: true, name: "rowan" }, { receiver: "", fallbackToAnyone: true })]);
}

// 8. policy resolution: TORAGENTS_HOME wins over dirname(stateDir)
{
	const { S } = mk();
	const elsewhere = mkdtempSync(join(tmpdir(), "policyhome-"));
	policy(elsewhere, { receiver: "rowan", fallbackToAnyone: true });
	const saved = process.env.TORAGENTS_HOME;
	process.env.TORAGENTS_HOME = elsewhere;
	const seen = mod.readPolicy(S);       // S is under a DIFFERENT tmp dir
	process.env.TORAGENTS_HOME = saved;
	checks.push(["TORAGENTS_HOME decides where policy.json is read from", seen.receiver === "rowan"]);
}

// 9. a corrupt policy file must not change behaviour
{
	const { d, S } = mk();
	writeFileSync(join(d, "policy.json"), "{ not json");
	const r = mod.electConsumer(S, other, now);
	checks.push(["a corrupt policy file falls back to first-come", r.tookOver]);
	checks.push(["...and reports nothing loaded", !mod.readPolicy(S).loaded]);
}

// 8. the same unsignalable desk, but it left no heartbeat -> presumed gone, and a silent
// channel is the worse failure. This is the cell a boolean default used to decide; now it
// is decided by evidence, and the absence of evidence is itself a fact.
{
	const { d, S } = mk();
	policy(d, { receiver: "rowan" });
	// both clocks stale: the claim is a minute old and there is no heartbeat at all, which is
	// the only state where nothing on disk speaks for the owner.
	writeFileSync(join(S, "consumer.json"),
		JSON.stringify({ pid: desk.pid, session: "pi-deskid", name: "rowan", at: now - 120_000 }));
	const r = mod.electConsumer(S, other, now);
	checks.push(["a desk with no heartbeat and a stale claim is presumed gone, so the channel is not muted",
		r.tookOver]);
	checks.push(["...and the takeover names the obstacle it decided against",
		/not signalable|stale|dead/i.test(r.reason)]);
}

// 9. the desk cannot be signalled, left no heartbeat, but its consumer write is ten seconds old.
// That is the owner talking: a timestamp it left itself. The first table threw this away and
// handed over the mail; the correction OR-s the two witnesses instead of voting. No designation
// here on purpose -- with one, the designation answer (and its reason) is the right one, and the
// muted path would never be reached.
{
	const { S } = mk();
	writeFileSync(join(S, "consumer.json"),
		JSON.stringify({ pid: desk.pid, session: "pi-deskid", name: "rowan", at: now - 10_000 }));
	const r = mod.electConsumer(S, other, now);
	checks.push(["a fresh consumer write with no heartbeat is NOT a handover", !r.tookOver]);
	checks.push(["...and it is named as unresolved, not as an owner", r.escalate === "muted"]);
}

let bad = 0;
for (const [name, ok] of checks) {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
	if (!ok) bad++;
}
console.log(`\n  ${checks.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
