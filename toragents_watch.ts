/**
 * toragents-inbox — incoming Tor messages become user turns in this session.
 *
 * The problem this solves:
 *   The toragents daemon already accepts signed messages from an allowlisted
 *   peer and writes them to <state>/inbox/*.json. But nothing told the agent.
 *   Every message sat there until a human typed "check your inbox", which makes
 *   the channel a mailbox, not a conversation. This closes that gap: a message
 *   arriving over the onion appears in the session by itself.
 *
 * Why an extension and not the daemon calling something:
 *   Only the process that owns the session can put a message into it. pi
 *   exposes exactly that as pi.sendUserMessage(), so the receiving side has to
 *   poll. The daemon stays dumb on purpose: it writes files, this watches them.
 *   That also means it works for any peer, over any transport the daemon uses.
 *
 * Design notes:
 *   - started on session_start, stopped on session_shutdown: the docs are
 *     explicit that a factory must not start timers, because pi loads
 *     extensions in invocations that have no session.
 *   - <state>/announced.json remembers which ids were already delivered, so a
 *     restart does not replay history. On the very first run it seeds with what
 *     is already on disk and says so, rather than dumping 10 old messages.
 *   - a file that is mid-write or unparseable is SKIPPED and not marked seen,
 *     so the next poll retries it. Marking it seen on a parse error would lose
 *     the message permanently.
 *   - delivery is followUp when the agent is busy, so a message never
 *     interrupts a running turn or wedges the session.
 *
 * Honest caveat, deliberately not hidden: the body is text from a remote
 * machine, and it is delivered as a user message. For an allowlisted,
 * signature-verified peer that is the whole point — but it means the peer's
 * content can instruct this agent. It is fenced with a visible marker so the
 * origin is never ambiguous.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Which directory is the daemon actually writing to?
 *
 * Two layouts exist and guessing wrong means the watcher silently watches an
 * empty directory forever: an install keeps <home>/state/inbox, while a daemon
 * driven from the control port (TORAGENTS_STATE) keeps identity.json, peers.json
 * and inbox/ flat in one directory. So probe for a real inbox instead of
 * assuming, and report which one was chosen.
 */
function resolveState(): { dir: string; why: string } {
	const home = process.env.TORAGENTS_HOME || join(homedir(), ".toragents");
	// Explicit configuration always wins outright. Only the DEFAULTS get scored,
	// because an explicit path outranking nothing is the whole point of setting
	// it -- scoring an explicit TORAGENTS_HOME against /var/lib would silently
	// watch the wrong directory on a machine that has both.
	if (process.env.TORAGENTS_STATE) {
		return { dir: process.env.TORAGENTS_STATE, why: "TORAGENTS_STATE (explicit)" };
	}
	if (process.env.TORAGENTS_HOME) {
		return { dir: join(home, "state"), why: "TORAGENTS_HOME/state (explicit)" };
	}
	// No explicit config: score the defaults. A stray empty <home>/state/inbox
	// (left by a previous run of this very extension) must not outrank the
	// directory that actually holds the daemon's identity and messages.
	const candidates: [string, string][] = [];
	for (const [dir, why] of [
		[join(home, "state"), "~/.toragents/state"],
		["/var/lib/toragents-inbox", "flat state dir"],
	] as [string, string][]) {
		if (!candidates.some(([d]) => d === dir)) candidates.push([dir, why]);
	}
	const score = (dir: string): number => {
		let n = 0;
		try {
			if (existsSync(join(dir, "identity.json"))) n += 2;
			if (existsSync(join(dir, "inbox"))) n += 1;
			if (readdirSync(join(dir, "inbox")).some((f) => f.endsWith(".json"))) n += 1;
		} catch {
			return 0;
		}
		return n;
	};
	let best = { dir: candidates[0][0], why: "default, created on first run" };
	let bestScore = 0;
	for (const [dir, why] of candidates) {
		const sc = score(dir);
		if (sc > bestScore) {
			bestScore = sc;
			best = { dir, why: `${why} (score ${sc})` };
		}
	}
	return best;;
}

const RESOLVED = resolveState();
const STATE = RESOLVED.dir;
const INBOX = join(STATE, "inbox");
const ANNOUNCED = join(STATE, "announced.json");

/**
 * Presence. The daemon cannot know whether a pi window exists -- only this
 * extension does -- so sessions announce themselves here and the receiver uses
 * it to refuse mail addressed to a window that is not there. Refusing is the
 * point: a message for a closed window must not be quietly eaten by whichever
 * window is open.
 */
const LIVE_DIR = join(STATE, "live");
// pi runs several sessions on one box against ONE state directory, so "has this
// been delivered?" is a question two processes answer at the same time. A set
// read then written back is a lost-update race: both sessions see the same
// pending file, both deliver it, and whichever writes last erases the other's
// ids so the NEXT session replays them as fresh turns.
//
// So a message is claimed by creating <state>/claimed/<id> with O_EXCL, which
// the kernel arbitrates for us. No lock is needed to decide ownership: the
// create either wins or gets EEXIST. announced.json stays as a readable mirror.
const CLAIM_DIR = join(STATE, "claimed");
// Delivery that failed permanently goes here. A message that cannot be shown
// must not look delivered: the peer already has a receipt, so silence is the
// only thing worse than an error.
const FAILED_DIR = join(STATE, "failed");
// What THIS process actually resolved, published for `inbox doctor`. Without it
// doctor can only read its own shell, which is a different environment from the
// one pi runs with -- and then its labels describe the wrong configuration.
const INFO_FILE = join(STATE, "extension.json");

/**
 * What was SAID, not what the agent did to say it. Only two things ever cross
 * the wire: a body we sent and a body we received. So a log of those two is,
 * by construction, the final-answers-only view -- thinking and tool churn never
 * appear in it because they never leave the machine.
 */
const CHAT_FILE = join(STATE, "chat.jsonl");
const CHAT_SHOWN = 12;

function logSaid(dir: "in" | "out", peer: string, body: string, id: string) {
	try {
		mkdirSync(STATE, { recursive: true });
		appendFileSync(
			CHAT_FILE,
			JSON.stringify({ at: Date.now(), dir, peer, id, body: String(body).slice(0, 2000) }) + "\n",
		);
	} catch {
		/* the transcript is a convenience; never let it break a delivery */
	}
}

/**
 * Ids this box has actually rendered into a session.
 *
 * The transcript row is the only durable proof of delivery: announced.json is a
 * promise to reconsider, `claimed/<id>` is who took the message, and neither is
 * evidence that a model read it. Reading the whole file, not the last CHAT_SHOWN
 * lines, because the question is about ids from days ago.
 */
function deliveredIds(): Set<string> {
	const ids = new Set<string>();
	let text = "";
	try {
		text = readFileSync(CHAT_FILE, "utf8");
	} catch {
		return ids;
	}
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			const row = JSON.parse(line);
			if (row && row.dir === "in" && typeof row.id === "string") ids.add(row.id);
		} catch {
			/* a truncated line is not a row */
		}
	}
	return ids;
}

function saidLog(): Array<{ at: number; dir: string; peer: string; body: string }> {
	try {
		return readFileSync(CHAT_FILE, "utf8")
			.split("\n")
			.filter(Boolean)
			.slice(-200)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

/**
 * Voice for a peer, read at compose time. Not remembered between messages: a
 * register that lives only in an agent's head is the one that drifts.
 */
export function peerTone(stateDir: string, label: string): string {
	try {
		const peers = JSON.parse(readFileSync(join(stateDir, "peers.json"), "utf8"));
		const want = label.trim().toLowerCase();
		for (const v of Object.values<any>(peers)) {
			if ((v?.label || "").toLowerCase() === want) return (v.tone || "").trim();
		}
	} catch {
		/* no allowlist, or unreadable: no tone is a valid answer */
	}
	return "";
}

/**
 * Fresh words for the next message, and a mark on the ones this body used.
 * The pool grows because `lexicon add` appends, and it stays fresh because
 * offering a word counts as using it -- otherwise the same three come back.
 */
export function freshWords(
	py: string,
	agent: string,
	root: string,
	bodyFile: string,
	styles = "",
) {
	try {
		const args = [
			agent, "lexicon", "pick", "--count", "3", "--json",
			// Rare words (hunni) appear roughly one message in seven: often enough
			// to be affectionate, rarely enough to stay a treat.
			"--rare-chance", "0.15",
			"--body-file", bodyFile,
		];
		if (styles) args.push("--style", styles);
		const res = spawnSync(
			py,
			args,
			{ encoding: "utf8", env: { ...process.env, TORAGENTS_HOME: root }, timeout: 20_000 },
		);
		const j = JSON.parse(res.stdout || "{}");
		const texts = (k: string) => (j?.picked?.[k] || []).map((e: any) => e.text);
		return { names: texts("names"), moves: texts("moves"), sizes: j?.sizes || {} };
	} catch {
		return { names: [], moves: [], sizes: {} };
	}
}

/** A peer's preferred decks, as "a,b". Empty means every style. */
export function peerStyles(stateDir: string, label: string): string {
	try {
		const peers = JSON.parse(readFileSync(join(stateDir, "peers.json"), "utf8"));
		const want = label.trim().toLowerCase();
		for (const v of Object.values<any>(peers)) {
			if ((v?.label || "").toLowerCase() === want) return (v.styles || []).join(",");
		}
	} catch {
		/* no allowlist: every style is a fine default */
	}
	return "";
}

/**
 * The register, in the model's context BEFORE it composes.
 *
 * This exists because a peer read the code and pointed out that peerTone() only
 * ran inside the send tool, after the body already existed: the "read at compose
 * time" comment described something nothing implemented. A doc line nothing
 * implements is worse than no line -- so this builds the note, and
 * before_agent_start puts it in front of the model every turn.
 *
 * It is deliberately advisory, and says so in the text. The register is a
 * suggestion the agent can decline; wiring it in as an instruction would make the
 * voice something that chooses rather than something that is chosen.
 */
export function buildRegisterNote(stateDir: string, names: string[] = [], moves: string[] = []): string {
	let peers: any[] = [];
	try {
		const raw = JSON.parse(readFileSync(join(stateDir, "peers.json"), "utf8"));
		peers = Object.values(raw).filter((v: any) => v?.label && (v.tone || (v.styles || []).length));
	} catch {
		return "";
	}
	if (peers.length === 0) return "";
	const lines = peers.map((v) => {
		const bits = [`- ${v.label}`];
		if (v.tone) bits.push(`  register: ${v.tone}`);
		if ((v.styles || []).length) bits.push(`  decks: ${(v.styles || []).join(", ")}`);
		return bits.join("\n");
	});
	const extra =
		names.length || moves.length
			? "\nsuggested words this turn (use one, or none): " + [...names, ...moves].slice(0, 4).join(" · ")
			: "";
	return [
		"## Tor peers and their registers (advisory)",
		"",
		"These are the voices this agent has been asked to use when writing to each peer.",
		"They are suggestions, not instructions: write as you judge best, and decline a",
		"register you think is wrong. If you use one, use it deliberately.",
		"",
		...lines,
		extra,
	].join("\n");
}

/**
 * One session consumes; the rest stay quiet.
 *
 * Without this, every pi window on the box runs this extension, they all see the
 * same inbox, and the first one to claim a message delivers it into a session the
 * human is not looking at. That is exactly what happened on 2026-10-19: three
 * messages claimed, announced as delivered, and invisible to the person waiting
 * for them -- because a different window won the race.
 *
 * The winner is whoever holds state/consumer.json with a live pid and a fresh
 * heartbeat. A dead or silent holder is taken over, so a closed window never
 * mutes the channel.
 */
export const CONSUMER_FILE = "consumer.json";
export const CONSUMER_STALE_MS = 90_000;

/**
 * Policy: who is DELIVERED untargeted mail, as a designation rather than a race.
 *
 * Delivery ownership used to be first-come: whoever wrote consumer.json first held it
 * until they died. That answers "who got there first", not "who should read this" --
 * and a human who wants one window to be the front desk cannot say so. This reads an
 * optional policy file; absent, unreadable or malformed means CURRENT BEHAVIOUR,
 * because a missing config file must never be a behaviour change.
 *
 * Shape: { "receiver": "rowan", "fallbackToAnyone": true }
 * `receiver` matches the pi session NAME (set via /name, readable as
 * sessionManager.getSessionName()), not the session id -- names are what a human
 * types, and `pi-<id>` is what the file already stores. Both are written, and the
 * comparison prefers the name so the two cannot silently disagree.
 */
const POLICY_FILE = "policy.json";

export function readPolicy(stateDir: string): {
	receiver: string;
	fallbackToAnyone: boolean;
	loaded: boolean;
} {
	const fallback = { receiver: "", fallbackToAnyone: true, loaded: false };
	try {
		// Policy lives at the HOME root, not beside whatever state dir a caller passed.
		// TORAGENTS_HOME wins, because that is how a sandbox says where its home is --
		// resolving from dirname(stateDir) made a sandboxed delivery look policy-less
		// while the panel (which honours TORAGENTS_HOME) saw a designated receiver. Two
		// surfaces disagreeing about who the desk is, over a path, is a bug that only
		// shows up in tests and relocations.
		const path = join((process.env.TORAGENTS_HOME || "").trim() || dirname(stateDir), POLICY_FILE);
		const st = statSync(path);
		const cached = POLICY_CACHE.get(path);
		if (cached && cached.mtime === st.mtimeMs) return cached.value;
		const raw = JSON.parse(readFileSync(path, "utf8"));
		const value = {
			receiver: String(raw?.receiver ?? "").trim(),
			fallbackToAnyone: raw?.fallbackToAnyone !== false,
			loaded: true,
		};
		POLICY_CACHE.set(path, { mtime: st.mtimeMs, value });
		return value;
	} catch {
		return fallback;
	}
}
const POLICY_CACHE = new Map<string, { mtime: number; value: any }>();

/**
 * What a signal told us. Three answers, because the world has three.
 *
 * `kill(pid, 0)` asks "may I signal this", not "are you running". A pid owned by
 * another user answers EPERM -- every process you do not own, pid 1 included -- so a
 * boolean here is a claim the probe cannot support. ESRCH is the only answer that means
 * gone; everything else means "I was not allowed to look", and a decision taken on that
 * is a guess wearing a fact's clothes.
 */
export type Signal = "alive" | "gone" | "unknown" | "invalid";

export function probePid(
	pid: number,
	kill: (p: number, s: number) => void = (p, s) => process.kill(p, s),
): { signal: Signal; why: string } {
	if (!Number.isInteger(pid) || pid <= 0) {
		// The guard stays -- kill(0, 0) signals a process group and kill(-1, 0) signals
		// everything -- but the label was doing a decision's work. A corrupt consumer.json
		// is not a dead owner: the night this desk muted itself it did so by hand-writing
		// that exact file. "gone" licenses a handover; this licenses a page.
		return { signal: "invalid", why: `consumer file names ${JSON.stringify(pid)}, which is not a pid` };
	}
	try {
		kill(pid, 0);
		return { signal: "alive", why: "signalled" };
	} catch (e: any) {
		const code = String(e?.code || e?.name || "error");
		if (code === "ESRCH") return { signal: "gone", why: "ESRCH: no such process" };
		return { signal: "unknown", why: `${code}: could not ask` };
	}
}

/**
 * The second witness, and the reason a cell we called "undecided" never was: every
 * window writes its own heartbeat into state/live/, so when the signal cannot tell us
 * anything, the owner's own record can.
 *
 * Age, never existence. Those files are never reaped -- 12 of 24 on this box were 33 to
 * 40 hours old -- so "a file exists" reports a desk that left yesterday. Only the
 * timestamp is evidence.
 */
export function heartbeatWitness(
	stateDir: string,
	pid: number,
	now = Date.now(),
): { found: boolean; ageMs: number | null; fresh: boolean } {
	const dir = join(stateDir, "live");
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return { found: false, ageMs: null, fresh: false };
	}
	let best = Infinity;
	for (const n of names) {
		if (!n.endsWith(".json") || n.startsWith("_")) continue;
		try {
			const rec = JSON.parse(readFileSync(join(dir, n), "utf8"));
			if (Number(rec.pid) !== pid) continue;
			const age = now - Number(rec.at || 0);
			if (Number.isFinite(age) && age < best) best = age;
		} catch {
			/* a corrupt witness is not a witness */
		}
	}
	if (!Number.isFinite(best)) return { found: false, ageMs: null, fresh: false };
	return { found: true, ageMs: best, fresh: best < CONSUMER_STALE_MS };
}

/**
 * The mid-delivery witness, which was on disk all along.
 *
 * A send can outlast the staleness clock: the desk's own record shows a 125.8 s send
 * against a 90 s threshold, so a session inside a slow dial is signalable and stale at the
 * same time -- the alive+stale row, which used to hand over. Handing over there is a double
 * delivery waiting for a slow wire. The durable-send claim (`state/outbox/.claims/<id>.claim`,
 * O_EXCL, `{pid, at}` in seconds, stale at 300 s) is written by the flusher that is actually
 * holding the item, so it answers "is this owner mid-send" without guessing.
 *
 * Absent today: the claim only exists once #2 lands. A missing directory means "no evidence",
 * which is different from "no send", and it is read that way.
 */
export const OUTBOX_CLAIM_STALE_MS = 300_000;

export function outboxInFlight(
	stateDir: string,
	pid: number | null,
	now = Date.now(),
	session: string | null = null,
): { found: boolean; ageMs: number | null; named: boolean } {
	const dir = join(stateDir, "outbox", ".claims");
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return { found: false, ageMs: null, named: false };
	}
	let best = Infinity;
	let bestNamed = Infinity;
	for (const n of names) {
		if (!n.endsWith(".claim")) continue;
		try {
			const rec = JSON.parse(readFileSync(join(dir, n), "utf8"));
			// the daemon writes `at` in seconds (time.time()), the panel thinks in ms
			const age = now - Number(rec.at || 0) * 1000;
			if (!Number.isFinite(age) || age < 0 || age >= OUTBOX_CLAIM_STALE_MS) continue;
			if (age < best) best = age;
			const namesOwner =
				(pid !== null && Number(rec.pid) === pid) ||
				(session !== null && typeof rec.session === "string" && rec.session === session);
			if (namesOwner && age < bestNamed) bestNamed = age;
		} catch {
			/* an unreadable claim is not a claim */
		}
	}
	if (!Number.isFinite(best)) return { found: false, ageMs: null, named: false };
	const named = Number.isFinite(bestNamed);
	return { found: true, ageMs: named ? bestNamed : best, named };
}

/**
 * The six cells, named once instead of decided six times by accident.
 *
 * The mid-send witness started as a join: claim.pid === consumer.pid. That join can never
 * match in production -- `outbox.py` writes `os.getpid()` of the *flusher*, a child of the
 * window that has exited by the time the next tick reads the file (measured on the peer's
 * box: claim 3085809 against consumer 857931, zero matches). So the claim answers "is this
 * outbox in use right now", and the safe error is to decline a handover on the strength of
 * a send we cannot attribute, not to hand one over because we could not name it.
 *
 *   alive   + fresh          -> holds    (a live owner with a current claim)
 *   alive   + stale          -> handover (a live owner that stopped asking: idle, not gone)
 *   gone    + either         -> handover (the pid is not there)
 *   unknown + fresh witness  -> muted    (running, and its consumer write died: the mute we
 *                                        caused once. escalate; handing over loses its mail)
 *   unknown + stale/absent   -> handover (no evidence it exists; refusing is the silent desk)
 */
export type Ownership = "holds" | "handover" | "muted" | "busy" | "invalid";

export function decideOwnership(
	signal: Signal,
	consumerFresh: boolean,
	witness: { found: boolean; fresh: boolean },
	inflight = false,
): Ownership {
	if (signal === "invalid") return "invalid";
	// A fresh claim by the owner and a fresh heartbeat are the same evidentiary class -- both
	// are timestamps left by that process -- so they are OR-ed, never voted. The first version
	// of this table read only one of them per branch and threw the other away, which handed
	// over a mailbox the owner had written to twenty seconds earlier.
	if (inflight) return "busy";                       // mid-send: a handover here duplicates
	if (signal === "alive") return consumerFresh ? "holds" : "handover";
	if (signal === "gone") return "handover";
	return consumerFresh || witness.fresh ? "muted" : "handover";
}

/**
 * Record before notifying, at most once per window per key.
 *
 * The notification is a view of this line, not a substitute for it: twelve
 * `ctx.ui.notify` sites in this file persist nothing, so a nag nobody was looking at
 * leaves no trace at all. The ghost message tonight was countable only because
 * `claimed/<id>` existed, and nothing living only in a notification would have been.
 */
export const OWNERSHIP_LOG = "ownership.log";

export function recordOwnership(
	stateDir: string,
	key: string,
	what: Record<string, unknown>,
	now = Date.now(),
	windowMs = CONSUMER_STALE_MS,
): boolean {
	const path = join(stateDir, OWNERSHIP_LOG);
	try {
		const prev = readFileSync(path, "utf8").split("\n").filter(Boolean);
		for (let i = prev.length - 1; i >= 0 && i >= prev.length - 50; i--) {
			try {
				const r = JSON.parse(prev[i]);
				if (r.key === key && now - Number(r.at || 0) < windowMs) return false;
			} catch {
				/* skip a torn line */
			}
		}
	} catch {
		/* no log yet */
	}
	try {
		mkdirSync(stateDir, { recursive: true });
		appendFileSync(path, JSON.stringify({ at: now, key, ...what }) + "\n");
		return true;
	} catch {
		return false;
	}
}

/**
 * May THIS window claim delivery? Pure, exported, and the only place the rule lives.
 *
 * A designated receiver always may. A non-receiver may not while a live designated
 * receiver holds it -- and `fallbackToAnyone` (default true) lets anyone take over
 * when the front desk is not there, because a closed window must not mute the channel.
 */
export function mayClaimOwnership(
	meName: string,
	prior: { name?: string; alive: boolean; fresh: boolean },
	policy: { receiver: string; fallbackToAnyone: boolean } = { receiver: "", fallbackToAnyone: true },
): boolean {
	if (!policy.receiver) return true; // no designation: first-come, as before
	if (meName && meName === policy.receiver) return true;
	const receiverHolds = Boolean(
		prior.alive && prior.fresh && prior.name && prior.name === policy.receiver,
	);
	if (receiverHolds) return false;
	return policy.fallbackToAnyone;
}

export function electConsumer(
	stateDir: string,
	me: { pid: number; session: string; name?: string },
	now = Date.now(),
): {
	owner: string;
	tookOver: boolean;
	reason: string;
	escalate?: "muted" | "busy" | "invalid";
} {
	const path = join(stateDir, CONSUMER_FILE);
	let prior: any = null;
	try {
		prior = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		/* no election yet */
	}
	// One probe, one witness, one decision. The probe answers with three states and the
	// third is not a decision; the witness decides it, because the owner's own heartbeat
	// is already on disk and was never consulted.
	const probe = prior ? probePid(Number(prior.pid)) : null;
	const fresh = prior && now - Number(prior.at || 0) < CONSUMER_STALE_MS;
	const witness = prior
		? heartbeatWitness(stateDir, Number(prior.pid), now)
		: { found: false, ageMs: null, fresh: false };
	// The claim names the flusher, not this window, so it is asked "is anything in flight"
	// rather than "is the owner in flight" -- and an unattributable send still refuses a handover.
	const inflight = outboxInFlight(
		stateDir,
		prior ? Number(prior.pid) : null,
		now,
		prior?.session ?? null,
	);
	const decision = probe
		? decideOwnership(probe.signal, Boolean(fresh), witness, inflight.found)
		: "handover";
	// "Present" now means: the probe saw it, or the witness did. A designation outranks
	// the race, so this has to be answered before the mute gate -- otherwise a receiver
	// we simply cannot signal reads as absent and the desk is displaced by policy.
	const ownerPresent = Boolean(prior) && decision !== "handover";
	const policy = readPolicy(stateDir);
	if (
		!mayClaimOwnership(
			String(me.name || ""),
			{ name: String(prior?.name || prior?.session || ""), alive: ownerPresent, fresh: Boolean(fresh) },
			policy,
		)
	) {
		return {
			owner: String(prior?.name || prior?.session || prior?.pid || ""),
			tookOver: false,
			reason: `designated receiver (${policy.receiver}) holds delivery`,
		};
	}
	// A designation outranks the race, and it also outranks a mute: the receiver may take
	// delivery from an owner nobody can confirm, because that is what being designated means.
	// Without this, a window whose NAME is the receiver was refused by the escalation gates
	// placed above it -- the naming trap, reintroduced by ordering.
	const iAmReceiver = Boolean(policy.receiver && me.name === policy.receiver);
	const priorIsReceiver = Boolean(policy.receiver && prior?.name === policy.receiver);
	const mayOutrank = iAmReceiver && !priorIsReceiver;

	if (decision === "invalid" && prior && !mayOutrank) {
		// Not a handover: a file that names an impossible pid is a corrupt file, and the last
		// time this desk lost delivery it was by hand-writing exactly that file.
		recordOwnership(stateDir, `invalid:${prior.pid}`, { pid: prior.pid, why: probe?.why }, now);
		return {
			owner: String(prior.name || prior.session || ""),
			tookOver: false,
			escalate: "invalid" as const,
			reason: `consumer.json is not a claim anyone made: ${probe?.why}. fix the file, do not take the mail`,
		};
	}
	if (decision === "busy" && prior && !mayOutrank) {
		recordOwnership(
			stateDir,
			`busy:${prior.pid}`,
			{ pid: prior.pid, why: "mid-send", claim_age_ms: inflight.ageMs },
			now,
		);
		return {
			owner: String(prior.name || prior.session || prior.pid),
			tookOver: false,
			escalate: "busy" as const,
			reason:
				`owner pid ${prior.pid} is mid-send (claim ` +
				`${Math.round(Number(inflight.ageMs || 0) / 1000)}s old, stale at ` +
				`${Math.round(OUTBOX_CLAIM_STALE_MS / 1000)}s): taking delivery here would ` +
				`duplicate the send`,
		};
	}
	if (decision === "muted" && prior && !mayOutrank) {
		// Record first: the line is the state, the notification is a view of it.
		recordOwnership(
			stateDir,
			`muted:${prior.pid}`,
			{ pid: prior.pid, owner: prior.name || prior.session || "", why: probe?.why, heartbeat_age_ms: witness.ageMs },
			now,
		);
		return {
			owner: String(prior.name || prior.session || prior.pid),
			tookOver: false,
			escalate: "muted" as const,
			reason:
				`cannot confirm the owner: ${probe?.why}, heartbeat ` +
				`${Math.round(Number(witness.ageMs || 0) / 1000)}s old -> running, and its ` +
				`own claim write died. not taking delivery`,
		};
	}
	// A takeover needs a reason that names the obstacle, never a candidate: after a
	// burned key, a name in a reason is an attribution, and reasons are read by humans
	// looking for exactly that.
	const takeoverReason = !prior
		? ""
		: probe?.signal === "unknown"
			? `owner pid ${prior.pid} not signalable (${probe?.why}) and no heartbeat newer ` +
				`than ${Math.round(CONSUMER_STALE_MS / 1000)}s -> assumed gone`
			: fresh
				? "took over from a stale entry"
				: "took over from a dead session";
	const priorAlive = ownerPresent;
	// A live owner normally keeps delivery -- unless I AM the designated receiver and
	// they are not, in which case the designation outranks the race that got them
	// there. Without this the receiver-cannot-be-displaced rule would leave the desk
	// permanently locked out by whoever happened to start first.
	if (prior && prior.pid !== me.pid && priorAlive && fresh && !mayOutrank) {
		return { owner: String(prior.session || prior.pid), tookOver: false, reason: "another live session owns delivery" };
	}
	try {
		mkdirSync(stateDir, { recursive: true });
		// Both identifiers, because they answer different questions: `name` is what the
		// designation compares, `session` is what the claim/probe paths already use.
		writeFileSync(path, JSON.stringify({ pid: me.pid, session: me.session, name: me.name || "", at: now }));
	} catch {
		/* unwritable: fall back to behaving like the only session */
		return { owner: me.session, tookOver: true, reason: "no consumer file (state unwritable)" };
	}
	const reason = !prior
		? (policy.receiver ? `designated receiver (${policy.receiver}) claimed delivery` : "first session to claim delivery")
		: prior.pid === me.pid
			? "already ours"
			: takeoverReason;
	return { owner: me.session, tookOver: true, reason };
}

export function isConsumer(stateDir: string, pid: number, now = Date.now()): boolean {
	try {
		const c = JSON.parse(readFileSync(join(stateDir, CONSUMER_FILE), "utf8"));
		return Number(c.pid) === pid && now - Number(c.at || 0) < CONSUMER_STALE_MS;
	} catch {
		return true; // no election recorded: do not mute a working channel
	}
}

export function heartbeatConsumer(stateDir: string, pid: number, session: string, now = Date.now()) {
	try {
		const c = JSON.parse(readFileSync(join(stateDir, CONSUMER_FILE), "utf8"));
		if (Number(c.pid) !== pid) return false; // someone else owns it; leave it alone
	} catch {
		/* write one below */
	}
	try {
		writeFileSync(join(stateDir, CONSUMER_FILE), JSON.stringify({ pid, session, at: now }));
		return true;
	} catch {
		return false;
	}
}

/**
 * "20:10" for today, "yesterday 20:10" for yesterday, "10-17 20:10" before that.
 *
 * The pane keeps a rolling window of the last few messages and nothing ages out,
 * so a message from last night sat there looking exactly like one from a minute
 * ago: "20:10" read as today, and the pane was quietly 16 hours out of date. A
 * clock without a date lies once a day, every day.
 */
export function stampFor(at: number, now: number = Date.now()): string {
	const d = new Date(at);
	const n = new Date(now);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const sameDay =
		d.getFullYear() === n.getFullYear() &&
		d.getMonth() === n.getMonth() &&
		d.getDate() === n.getDate();
	if (sameDay) return `${hh}:${mm}`;
	const age = now - at;
	if (age >= 0 && age < 24 * 3600 * 1000) return `yesterday ${hh}:${mm}`;
	const mo = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${mo}-${day} ${hh}:${mm}`;
}

/** Plain text lines, so this can be tested and printed without a TUI. */
export function renderChat(width = 56): string[] {
	const rows = saidLog().slice(-CHAT_SHOWN);
	if (rows.length === 0) return [" toragents · no messages yet"];
	const out: string[] = [];
	for (const r of rows) {
		const when = stampFor(r.at);
		const who = `${r.dir === "out" ? "→" : "←"} ${r.peer}  ${when}`;
		out.push(` ${who}`);
		const flat = r.body.replace(/\s+/g, " ").trim();
		const room = Math.max(20, width - 4);
		const cap = room * 2;                       // two lines per message, whatever the width
		const shown = flat.length > cap ? flat.slice(0, Math.max(1, cap - 1)) + "…" : flat;
		for (let i = 0; i < shown.length; i += room) {
			out.push(`   ${shown.slice(i, i + room)}`);
		}
	}
	return out;
}
// A claim with no announced entry is an orphan: the process died between the
// two writes (or was killed at shutdown). Older than this, it is safe to take.
const ORPHAN_MS = 5 * 60 * 1000;

/**
 * Who this session is, for the claim record, for doctor, and for addressing.
 *
 * Deliberately NOT from PI_SESSION_ID alone. pi exports PI_SESSION_ID to its
 * children, and a pi started from inside another agent session INHERITS that
 * variable -- so process.env.PI_SESSION_ID can name a different process than the
 * one running this code. Two windows would share one label, and under
 * TORAGENTS_RECEIVE=targeted either could claim mail addressed to the other.
 *
 * ctx.sessionManager.getSessionId() is this process's own id. It is set at
 * session_start, before the first poll, so claims always see the real answer.
 */
let MY_SESSION = "";
/**
 * The session's NAME (what a human types via /name), which is what a designation in
 * policy.json matches. Kept separate from the pi-<id> label on purpose: one is for
 * people, one is for files, and silently using either for both is how a designation
 * stops matching without anyone noticing.
 */
let MY_NAME = "";
function sessionName(): string {
	return MY_NAME;
}

function sessionLabel(): string {
	// Never the literal "unknown": a claim has to say WHICH process holds it, or
	// two unnamed windows look identical on disk and the orphan heal cannot tell
	// a live owner from a dead one.
	return MY_SESSION || `pid-${process.pid}`;
}

/** Resolve once, from the most authoritative source available. */
function resolveSession(ctx?: any): string {
	const explicit = (process.env.TORAGENTS_SESSION || "").trim();
	if (explicit) return explicit.slice(0, 64);
	let own = "";
	try {
		own = String(ctx?.sessionManager?.getSessionId?.() ?? "").trim();
	} catch {
		own = "";
	}
	// Fall back to the environment only when the context cannot answer.
	const id = (own || process.env.PI_SESSION_ID || "").replace(/-/g, "");
	return id ? `pi-${id.slice(0, 8)}` : "";
}

/** Read the session name from pi, tolerating its absence on older builds. */
function resolveName(ctx?: any): string {
	const explicit = (process.env.TORAGENTS_NAME || "").trim();
	if (explicit) return explicit.slice(0, 64);
	try {
		return String(ctx?.sessionManager?.getSessionName?.() ?? "").trim().slice(0, 64);
	} catch {
		return "";
	}
}

function failedIds(): Set<string> {
	try {
		return new Set(readdirSync(FAILED_DIR).filter((n) => n && !n.startsWith(".")));
	} catch {
		return new Set();
	}
}

function markFailed(id: string, error: string, from: string): boolean {
	// Returns false when the marker could not be written. The caller must then
	// keep the id out of the retry path some other way: unclaiming it while the
	// marker fails would re-claim it every tick, fail three times, warn again,
	// and loop forever on a disk that will not take the write.
	try {
		mkdirSync(FAILED_DIR, { recursive: true });
		writeFileSync(
			join(FAILED_DIR, id),
			JSON.stringify({ at: Date.now(), error: error.slice(0, 300), from, session: sessionLabel() }),
		);
		return true;
	} catch {
		return false;
	}
}
const LOCK = join(STATE, "announced.lock");

/** True only for the one process that created the claim file. */
function claim(id: string): boolean {
	try {
		mkdirSync(CLAIM_DIR, { recursive: true });
		writeFileSync(join(CLAIM_DIR, id), `${sessionLabel()} ${Date.now()}`, { flag: "wx" });
		return true;
	} catch (e: any) {
		if (e && e.code === "EEXIST") return false;
		// A claim we cannot record is a claim we must not act on: better to skip
		// this message this tick than to deliver it twice.
		return false;
	}
}

function unclaim(id: string): void {
	try {
		unlinkSync(join(CLAIM_DIR, id));
	} catch {
		/* already gone */
	}
}

/** Short critical section around announced.json. Stale locks are taken over so
 *  a crashed session cannot wedge delivery forever. */
function withLock<T>(fn: () => T): T {
	const started = Date.now();
	for (;;) {
		try {
			mkdirSync(STATE, { recursive: true });
			writeFileSync(LOCK, String(process.pid), { flag: "wx" });
			break;
		} catch {
			// Take over a lock left behind by a dead session: 5s is far longer
			// than any read-modify-write here, and far shorter than a human's
			// patience for a stuck inbox.
			try {
				const age = Date.now() - statSync(LOCK).mtimeMs;
				if (age > 5000) {
					unlinkSync(LOCK);
					continue;
				}
			} catch {
				/* lock vanished between the two calls: retry */
			}
			if (Date.now() - started > 2000) break; // ceiling, then proceed unlocked
			const until = Date.now() + 15;
			while (Date.now() < until) {
				/* brief spin: this is a sub-millisecond critical section */
			}
		}
	}
	try {
		return fn();
	} finally {
		try {
			unlinkSync(LOCK);
		} catch {
			/* not ours to remove */
		}
	}
}
const POLL_MS = Number(process.env.TORAGENTS_POLL_MS || 3000);

const MAX_BODY = 4000;
const MAX_BATCH = 5;

/**
 * How much of this machine's mail this session wants.
 *
 *   all      (default) everything, including untargeted mail
 *   targeted only messages addressed to this session by name
 *
 * The default is right for the two-person case the transport exists for. It is
 * wrong on a box running a dozen sessions: untargeted mail used to reach every
 * one of them, so one peer talking at 20-second intervals flooded all of them.
 */
const RECEIVE_ENV = (process.env.TORAGENTS_RECEIVE || "").trim().toLowerCase();

/**
 * Untargeted mail goes to the designated receiver; everyone else takes only what is
 * addressed to them. An explicit TORAGENTS_RECEIVE still wins, because an env var set
 * on purpose is a decision and a policy default is only a default -- and a quiet box
 * must stay quiescent without needing to name itself in a file.
 */
function receiveMode(name: string): string {
	if (RECEIVE_ENV) return RECEIVE_ENV;
	const policy = readPolicy(STATE);
	if (policy.receiver) return name === policy.receiver ? "all" : "targeted";
	return "all";
}

/** Set by /toragents-mute. Survives restarts, per session, no config file. */
const MUTE_DIR = join(STATE, "muted");
// Mail that landed this recently is treated as new on a first run rather than
// as backlog. Long enough to cover a slow install, short enough that a real
// history does not replay as a burst of turns.
const FIRST_RUN_GRACE_MS = 10 * 60 * 1000;
function muteKey(): string {
	return (MY_SESSION || `pid-${process.pid}`).replace(/[^A-Za-z0-9._-]/g, "_");
}
function isMuted(): boolean {
	try {
		return existsSync(join(MUTE_DIR, muteKey()));
	} catch {
		return false;
	}
}
function setMuted(on: boolean): boolean {
	try {
		mkdirSync(MUTE_DIR, { recursive: true });
		const f = join(MUTE_DIR, muteKey());
		if (on) writeFileSync(f, String(Date.now()));
		else if (existsSync(f)) unlinkSync(f);
		return true;
	} catch {
		return false;
	}
}

interface RemoteMessage {
	id: string;
	body: string;
	from_label?: string;
	from_session?: string;
	to_session?: string;
	from_fingerprint?: string;
	from_onion?: string;
	received?: number;
}

function readAnnounced(): Set<string> | null {
	try {
		const d = JSON.parse(readFileSync(ANNOUNCED, "utf8"));
		if (Array.isArray(d)) return new Set(d.filter((x) => typeof x === "string"));
		return null;
	} catch {
		return null;
	}
}

/** Forget a message: memory AND disk. writeAnnounced only ever adds, so an
 *  in-memory delete was resurrected by the next merge -- which made a failed
 *  delivery look delivered and never retried. */
function forget(announced: Set<string>, id: string): void {
	announced.delete(id);
	try {
		withLock(() => {
			const disk = readAnnounced();
			if (!disk || !disk.has(id)) return;
			disk.delete(id);
			const tmp = `${ANNOUNCED}.tmp`;
			writeFileSync(tmp, JSON.stringify([...disk]));
			renameSync(tmp, ANNOUNCED);
		});
	} catch {
		/* the claim release below still prevents duplicate delivery */
	}
}

function writeAnnounced(ids: Set<string>): void {
	// atomic: a truncated announced.json would replay history on next start.
	// Merged under a lock so two sessions cannot erase each other's ids.
	try {
		withLock(() => {
			const disk = readAnnounced();
			const merged = new Set<string>(disk ? [...disk] : []);
			for (const id of ids) merged.add(id);
			ids.clear();
			for (const id of merged) ids.add(id);
			const tmp = `${ANNOUNCED}.tmp`;
			writeFileSync(tmp, JSON.stringify([...merged]));
			renameSync(tmp, ANNOUNCED);
		});
	} catch {
		/* losing the memo is survivable; never break the session over it */
	}
}

/** Every inbox file currently on disk, newest last. Unparseable ones are ignored. */
function scanInbox(): {
	ids: string[];
	messages: RemoteMessage[];
	mtimes: Map<string, number>;
} {
	const ids: string[] = [];
	const messages: RemoteMessage[] = [];
	const mtimes = new Map<string, number>();
	let names: string[] = [];
	try {
		names = readdirSync(INBOX).filter((n) => n.endsWith(".json"));
	} catch {
		return { ids, messages, mtimes }; // no inbox dir yet
	}
	for (const name of names) {
		try {
			const m = JSON.parse(readFileSync(join(INBOX, name), "utf8")) as RemoteMessage;
			if (!m || typeof m.id !== "string") continue;
			ids.push(m.id);
			messages.push(m);
			try {
				mtimes.set(m.id, statSync(join(INBOX, name)).mtimeMs);
			} catch {
				/* vanished mid-scan: it will be seen on a later tick */
			}
		} catch {
			// mid-write or corrupt: leave it unseen so a later poll retries it
		}
	}
	messages.sort((a, b) => (a.received || 0) - (b.received || 0));
	return { ids, messages, mtimes };
}

/**
 * Untargeted mail is first-come. Targeted mail belongs to the session it names,
 * and an unnamed session does not take it -- otherwise a polling session steals
 * mail addressed to another one before it can look.
 */
/**
 * The build of THIS LOADED MODULE, as a literal.
 *
 * Not read from disk, and that is the whole design: a window that read its own
 * source at tick time would report the NEW version while running the OLD code --
 * attesting to precisely the thing it cannot see. The only honest statement a stale
 * process can make about itself is what it was compiled with. Bump this whenever the
 * file changes; tools/test_ext_version.py fails if you forget.
 */
export const EXT_VERSION = "8";

/**
 * Write our fields into a marker file WITHOUT erasing fields we did not write.
 *
 * The marker is one account per window, and more than one module may attest to it --
 * the reader, one day, will add its own version to this same file rather than open a
 * second one. A blanket rewrite here would silently delete another module's field on
 * the next tick, and the symptom would be a version that appears on mount and vanishes
 * a second later: the worst kind of bug, because it looks like a renderer glitch.
 *
 * Merge, never replace. A corrupt or unreadable file is treated as empty, because the
 * alternative is a window that stops heartbeating over someone else's bad JSON.
 */
function mergeMarker(path: string, ours: Record<string, unknown>): void {
	let existing: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			existing = parsed as Record<string, unknown>;
		}
	} catch {
		/* absent or not ours to parse; start from empty */
	}
	writeFileSync(path, JSON.stringify({ ...existing, ...ours }));
}

export function markLive(stateDir: string, label: string, pid: number, now = Date.now()): void {
	if (!label) return;
	try {
		const dir = join(stateDir, "live");
		mkdirSync(dir, { recursive: true });
		// `code` rides every tick, not just at start, so a window that reloads into a
		// new build corrects itself on the next tick without touching the daemon.
		mergeMarker(join(dir, `${label}.json`),
			{ session: label, pid, at: now, code: EXT_VERSION });
		// The heartbeat MARKER: proof that a writer exists at all. Without it an empty
		// registry is ambiguous -- "no windows here" and "nobody writes presence" look
		// identical -- and the daemon would have to choose between refusing targeted
		// mail (losing messages on an old peer) and accepting it blindly. The marker
		// lets it trust an empty registry only when a fresh writer vouches for it.
		mergeMarker(join(dir, "_writer.json"),
			{ v: 2, session: label, pid, at: now, code: EXT_VERSION });
	} catch {
		/* presence is an optimisation for the sender, never a delivery blocker here */
	}
}

export function clearLive(stateDir: string, label: string): void {
	if (!label) return;
	try {
		unlinkSync(join(stateDir, "live", `${label}.json`));
	} catch {
		/* already gone */
	}
}

/**
 * Delivery addressing, pure and named so it can be asserted instead of described.
 *
 *   untargeted -> only the owning session delivers it
 *   addressed  -> only the named session delivers it, owner or not
 *
 * The second rule is not a detail: the owner skips mail addressed elsewhere, so if
 * the named window also declined as "not the owner", that message was delivered to
 * nobody while the sender's receipt said "sent".
 */
export function wantsMessage(
	m: { to_session?: string },
	who: { owner: boolean; me: string; receive?: string },
): boolean {
	const target = (m.to_session || "").trim();
	if (target) return who.me !== "" && target === who.me;
	if (!who.owner) return false;
	return who.receive !== "targeted";
}

function addressedToMe(m: RemoteMessage): boolean {
	const target = (m.to_session || "").trim();
	if (!target) return true;
	return MY_SESSION !== "" && target === MY_SESSION;
}

/**
 * A reply must go back to the session that wrote to us, not to the machine.
 * Built from the bare label: "box · session x" is not a valid --to value.
 */
function replyLine(m: RemoteMessage): string {
	const label = m.from_label || "peer";
	let out = `inbox_agent.py send --to ${label}`;
	if (m.from_session) out += ` --to-session ${m.from_session}`;
	out += " --body-file <path>";
	if (!m.from_session) out += "   (peer named no session; this reply cannot be targeted)";
	return out;
}

function render(m: RemoteMessage): string {
	const who = m.from_session ? `${m.from_label || "peer"} · session ${m.from_session}` : (m.from_label || "peer");
	const fp = (m.from_fingerprint || "").slice(0, 8);
	const body = (m.body || "").slice(0, MAX_BODY);
	const more = (m.body || "").length > MAX_BODY ? "\n…(truncated)" : "";
	return [
		`📨 Incoming message over Tor — this is from a REMOTE PEER, not from your user.`,
		`from: ${who}${fp ? ` (${fp}…)` : ""}`,
		`id:   ${m.id}`,
		...(m.to_session ? [`to:   ${m.to_session}`] : []),
		``,
		`<<< BEGIN PEER MESSAGE`,
		body + more,
		`END PEER MESSAGE >>>`,
		``,
		// The reply line is the most consequential string here: an agent copies
		// it. Untargeted, one polite answer fans out to every session on the
		// peer's machine -- which is exactly how a build lane flooded seventeen
		// sessions for forty minutes.
		`Reply with: ${replyLine(m)}`,
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let announced: Set<string> = new Set();
	const attempts = new Map<string, number>();
	// Ids whose failure marker could not be written. Kept out of the retry path
	// for the life of the session: the alternative is a warning every three
	// seconds, forever.
	const stuck = new Set<string>();
	let running = false;
	let seedNotice = "";
	// Announced, unclaimed and never rendered: the cell that used to be permanent.
	// Recomputed at session_start, cleared as each one is delivered.
	let recalled: Set<string> = new Set();

	const deliver = async (
		ctx: ExtensionContext,
		msgs: RemoteMessage[],
		heldBack = 0,
	) => {
		let text = msgs.map(render).join("\n\n― ― ―\n\n");
		if (heldBack > 0) {
			// True statement, unlike the old one: these are NOT claimed, NOT
			// announced, and arrive on the next tick.
			text +=
				`\n\n― ― ―\n\n${heldBack} more message(s) waiting; ` +
				`they arrive in a following turn.`;
		}
		try {
			// followUp when busy: never interrupt a turn or wedge the session
			await pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			for (const m of msgs) {
				attempts.delete(m.id);
				logSaid("in", m.from_label || m.from_fingerprint || "peer", m.body, m.id);
				recalled.delete(m.id); // the row exists now; stop reconsidering it
			}
			paintChat(ctx);
		} catch (err) {
			// Delivery failed. Retry, but not forever: a permanently failing id
			// would otherwise re-fire every tick and hammer the session.
			//
			// Giving up must UNMARK. Keeping the claim and the announced entry
			// while rendering nothing is the one outcome this repo exists to
			// avoid: every later session skips it, status says undelivered 0,
			// doctor says delivered, and the peer has a receipt for a message no
			// model ever saw.
			const why = err instanceof Error ? err.message : String(err);
			for (const m of msgs) {
				const n = (attempts.get(m.id) || 0) + 1;
				if (n >= 3) {
					attempts.delete(m.id);
					const recorded = markFailed(m.id, why, m.from_label || m.from_fingerprint || "peer");
					if (recorded) {
						// safe to release: the marker keeps it out of the retry path
						unclaim(m.id);
						forget(announced, m.id);
					} else {
						// keep it claimed so it is visibly not-delivered, and stop
						// retrying it this session rather than looping on a write
						// that keeps failing
						stuck.add(m.id);
					}
					try {
						ctx.ui.notify(
							`toragents: could not deliver ${m.id} after 3 tries (${why}). ` +
								`It is NOT delivered; run /toragents-status, then /toragents-retry` +
								(recorded ? "" : " (could not record the failure: state dir unwritable)"),
							"warning",
						);
					} catch {}
				} else {
					attempts.set(m.id, n);
					forget(announced, m.id);  // retry next tick (disk too: merge would undo it)
					unclaim(m.id); // and let another session take it
				}
			}
		}
	};

	/**
	 * Under-editor chat widget: OFF by default. Maestro rejected it as the
	 * interface ("half my screen", "not a tmux pane") and the right-hand column
	 * (toragents-panel.ts) is the reading surface now. Keeping it on by default
	 * would draw the same chat twice and cost the screen height he complained
	 * about. Opt in with TORAGENTS_WIDGET=1, or toggle at runtime with
	 * /toragents-chat.
	 */
	let CHAT_WIDGET = /^(1|true|yes|on)$/i.test(String(process.env.TORAGENTS_WIDGET || ""));

	/** Keep the side panel current; safe to call from anywhere. */
	let CONSUMER = true; // optimistic until the election says otherwise
	let lastCtx: ExtensionContext | null = null;
	const paintChat = (ctx?: ExtensionContext) => {
		if (ctx) lastCtx = ctx;
		const c = ctx || lastCtx;
		if (!c || !CHAT_WIDGET) return;
		try {
			if (!c.hasUI) return;
			if (c.mode === "tui") {
				// The component overload is the only one that receives the real
				// terminal width (and keeps receiving it after a resize). A
				// string[] is rendered verbatim, which is why this pane sat
				// frozen at renderChat()'s 56-column default on a 198-column
				// terminal: correct content, wrapped at half the screen.
				c.ui.setWidget(
					"toragents-chat",
					() => ({
						render: (width: number) => renderChat(width),
						invalidate: () => {},
					}),
					{ placement: "belowEditor" },
				);
			} else {
				// RPC/json/print: keep the array form. This branch is load-bearing and
				// the failure mode is silence, which is why it must not be "simplified"
				// into the factory above. Verified in pi's bundle: rpc-mode.js emits
				// `output(...)` only when `content === void 0 || Array.isArray(content)`.
				// Pass a function there and the guard is false, the && short-circuits,
				// and NOTHING is emitted -- no widget, no error, no note, and no test
				// would fail. (RPC does send the whole array and applies no row cap;
				// MAX_WIDGET_LINES = 10 lives only in the TUI renderer.)
				c.ui.setWidget("toragents-chat", renderChat(72), { placement: "belowEditor" });
			}
		} catch {
			/* no UI, or the widget is not supported on this pi */
		}
	};

	const poll = async (ctx: ExtensionContext) => {
		if (running) return; // a slow delivery must not overlap the next tick
		running = true;
		try {
			// Muted: say nothing and mark nothing -- a muted session must not
			// consume mail the peer meant for it, so it stays unread.
			if (isMuted()) return;
			// Ownership decides UNTARGETED mail only. Two different rules, and
			// conflating them caused a hole: the owner skips mail addressed to
			// another window (not addressed to it), and that window used to return
			// here because it was not the owner -- so a message addressed to a
			// non-owner session was delivered to NOBODY, silently, while the sender's
			// receipt said "sent".
			//
			//   untargeted  -> only the owning session delivers it
			//   addressed   -> only the named session delivers it, owner or not
			//
			// Both windows still agree on one thing: an id is claimed once, so the
			// same message can never be delivered twice.
			const owner = CONSUMER && isConsumer(STATE, process.pid);
			if (owner) heartbeatConsumer(STATE, process.pid, sessionLabel());
			markLive(STATE, sessionLabel(), process.pid);
			const { messages } = scanInbox();
			const wanted = messages.filter((m) =>
				wantsMessage(m, { owner, me: sessionLabel(), receive: receiveMode(sessionName()) }),
			);
			const failed = new Set([...failedIds(), ...stuck]);
			const fresh = wanted.filter(
				(m) =>
					(!announced.has(m.id) || recalled.has(m.id)) &&
					!failed.has(m.id) &&
					!stuck.has(m.id) &&
					addressedToMe(m),
			);
			// Nothing new. Deliberately no pruning: dropping ids whose files are
			// gone would re-deliver them if an archive is ever restored.
			if (fresh.length === 0) return;
			// Claim and mark ONLY what this turn will actually render. Marking the
			// whole batch while showing MAX_BATCH leaves the remainder claimed and
			// announced but injected into no session, ever -- doctor calls them
			// delivered because claimed and announced agree, and the peer has a
			// receipt. "Peer sent 8 while pi was closed" is the normal case for a
			// two-person tool, so the leftover must stay visibly undone.
			//
			// Ownership is decided here, not by who writes last. The unclaimed
			// remainder is picked up by the next tick, so a flood still arrives in
			// bounded turns of MAX_BATCH.
			const batch = fresh.slice(0, MAX_BATCH);
			const mine = batch.filter((m) => claim(m.id));
			if (mine.length === 0) return; // another session on this box took them
			const heldBack = fresh.length - mine.length;
			// In memory only, until the render happens. Writing announced.json BEFORE
			// `deliver` leaves, on a crash between the two, an id that the retry path
			// skips (`announced.has`), the orphan healer skips (`onDisk.has`), and
			// nobody can clear: announced + no claim + no chat row = a letter the peer
			// holds a receipt for and no model ever saw. The claim is already on disk
			// before this line, so it is the only marker that needs to precede a
			// render; the transcript row created by `deliver` is what proves one
			// happened.
			for (const m of mine) announced.add(m.id);
			await deliver(ctx, mine, heldBack);
			writeAnnounced(announced);
		} finally {
			running = false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			mkdirSync(INBOX, { recursive: true });
		} catch {
			/* daemon will create it */
		}
		// Reconcile before adopting: a claim with no announced entry means a
		// process died between claiming and recording it. Nobody can deliver that
		// message -- every session sees EEXIST, adoption skips it, and no command
		// in the product can clear it. Take stale ones back.
		let healed = 0;
		const onDisk = readAnnounced(); // the authority: other sessions write it
		try {
			for (const id of readdirSync(CLAIM_DIR)) {
				if (onDisk?.has(id)) continue;
				try {
					const age = Date.now() - statSync(join(CLAIM_DIR, id)).mtimeMs;
					if (age > ORPHAN_MS) {
						unclaim(id);
						healed++;
					}
				} catch {
					/* vanished: nothing to heal */
				}
			}
		} catch {
			/* no claims yet */
		}
		if (healed > 0) seedNotice = `${healed} stale claim(s) released for delivery`;

		// The mirror of that cell, and the one that used to have no repair at all:
		// announced, no claim, no transcript row. The heal above only runs for claims
		// that have no announced entry, and the tick skips anything announced -- so
		// an id that reached announced.json and then lost its render was permanent.
		// Three letters on the peer's box are in exactly this state, 28 hours old,
		// with their bodies intact on disk. Recall them once, and let the row being
		// written be what stops it happening twice.
		recalled = new Set();
		try {
			const rows = deliveredIds();
			const claims = new Set(readdirSync(CLAIM_DIR));
			const present = new Set(scanInbox().messages.map((m) => m.id));
			for (const id of onDisk ?? []) {
				if (!present.has(id) || claims.has(id) || rows.has(id)) continue;
				recalled.add(id);
			}
		} catch {
			/* nothing to reconcile */
		}
		if (recalled.size > 0) {
			seedNotice = `${recalled.size} message(s) were announced but never shown; delivering them now`;
		}

		// Who we are, before anything writes a claim or a report.
		MY_SESSION = resolveSession(ctx);
		MY_NAME = resolveName(ctx);

		// Delivery is owned by exactly one session. Every pi window on this box
		// runs this extension; without an owner they race for the same inbox and
		// messages surface in whichever window claimed first.
		const election = electConsumer(STATE, {
			pid: process.pid,
			session: sessionLabel(),
			name: sessionName(),
		});
		CONSUMER = election.tookOver;
		if (!CONSUMER) {
			// The election already wrote its line before anything was shown here: the
			// record is the state, this is a view of it, and a view is allowed to be
			// missed. A muted owner is a different sentence from a quiet one, because the
			// remedy is different -- wait for it to wake, do not take its mail.
			try {
				ctx.ui.notify(
					election.escalate
						? `toragents: delivery ownership is UNRESOLVED (${election.reason}). ` +
							`This session will not consume mail, and taking it would strand the ` +
							`owner's letters. Escalated to state/ownership.log.`
						: `toragents: message delivery is owned by ${election.owner} ` +
							`(${election.reason}). This session will not consume mail. ` +
							`Use /toragents-takeover to take it.`,
					"warning",
				);
			} catch {}
		}
		paintChat(ctx);

		// Publish our resolved configuration before anything else: doctor's labels
		// must describe what this process does, not what some shell exported.
		try {
			mkdirSync(STATE, { recursive: true });
			writeFileSync(
				INFO_FILE,
				JSON.stringify({
					session: sessionLabel(),
					receive: receiveMode(sessionName()),
					state: STATE,
					pid: process.pid,
					at: Date.now(),
				}),
			);
		} catch {
			/* doctor falls back to its own environment and says so */
		}

		const prior = readAnnounced();
		if (prior) {
			announced = prior;
		} else {
			// First run on this machine: adopt what is already on disk instead of
			// replaying it as a burst of user turns.
			const { ids, mtimes } = scanInbox();
			// Claim what we adopt so a session starting later does not replay it,
			// but skip anything another session already owns -- that mail is theirs
			// and adopting it would silently swallow an unread message.
			//
			// And do not adopt mail that JUST arrived. A first install starts the
			// extension seconds after the daemon, so the very first message can
			// already be on disk: adopting it would make the one message that
			// proves the install works silently not appear. Anything inside the
			// grace window stays unclaimed and the first poll delivers it.
			const cutoff = Date.now() - FIRST_RUN_GRACE_MS;
			const adopted = ids.filter((id) => (mtimes.get(id) || 0) < cutoff && claim(id));
			announced = new Set(adopted);
			writeAnnounced(announced);
			if (adopted.length > 0) {
				const held = ids.length - adopted.length;
				seedNotice +=
					(seedNotice ? "; " : "") +
					`${adopted.length} existing message(s) marked as already seen` +
					(held > 0 ? `; ${held} held by another session` : "");
			}
		}
		if (seedNotice) {
			try {
				ctx.ui.notify(
					`toragents: watching ${INBOX} (via ${RESOLVED.why}); ${seedNotice}`,
					"info",
				);
			} catch {
				/* notify is best-effort */
			}
		}
		timer = setInterval(() => {
			void poll(ctx).catch(() => {
				/* poll never throws past here */
			});
		}, POLL_MS);
	});

	/**
	 * Compose-time register. Returning systemPrompt here is the only path that
	 * reaches the model before it writes -- the send tool's echo was a receipt,
	 * never an input, and a peer caught us claiming otherwise.
	 */
	pi.on("before_agent_start", async (event: any) => {
		try {
			const py = process.platform === "win32"
				? join(homedir(), ".toragents", "venv", "Scripts", "python.exe")
				: join(homedir(), ".toragents", "venv", "bin", "python");
			const agent = join(homedir(), ".toragents", "inbox_agent.py");
			const peek = spawnSync(
				py,
				[agent, "lexicon", "pick", "--count", "2", "--json", "--peek"],
				{ encoding: "utf8", timeout: 15_000 },
			);
			let names: string[] = [], moves: string[] = [];
			try {
				const j = JSON.parse(peek.stdout || "{}");
				names = (j?.picked?.names || []).map((e: any) => e.text);
				moves = (j?.picked?.moves || []).map((e: any) => e.text);
			} catch {}
			const note = buildRegisterNote(STATE, names, moves);
			if (!note) return;
			return { systemPrompt: String(event?.systemPrompt || "") + "\n\n" + note };
		} catch {
			return;   // the register is decoration; never break a turn for it
		}
	});

	pi.on("session_shutdown", async () => {
		try {
			clearLive(STATE, sessionLabel());
		} catch {
			/* presence is advisory; shutdown must never throw */
		}
		// Release ownership so the next window can pick delivery up immediately
		// instead of waiting out the stale window.
		try {
			const c = JSON.parse(readFileSync(join(STATE, CONSUMER_FILE), "utf8"));
			if (Number(c.pid) === process.pid) unlinkSync(join(STATE, CONSUMER_FILE));
		} catch {}
		if (timer) clearInterval(timer);
		timer = null;
		running = false;
	});

	/**
	 * Sending is the half a human cannot see. A bash call that prints JSON reads
	 * like plumbing; a tool call named "Send over Tor", with the peer in it, reads
	 * like a message leaving -- which is what it is.
	 */
	if (typeof (pi as any).registerTool === "function")
		pi.registerTool({
			name: "toragents_send",
			label: "Send over Tor",
			description:
				"Send a signed message to a paired peer over Tor. Returns the message id once " +
				"their daemon accepts it. Use this instead of running the daemon by hand: the " +
				"human sees the send, and the body is never touched by a shell.",
			parameters: {
				type: "object",
				properties: {
					to: { type: "string", description: "Peer label, as listed by `inbox peers`" },
					body: { type: "string", description: "Message text" },
					to_session: {
						type: "string",
						description: "Deliver only to this session name on their side",
					},
				},
				required: ["to", "body"],
			},
			async execute(_id: string, params: any) {
				const root = join(homedir(), ".toragents");
				const py =
					process.platform === "win32"
						? join(root, "venv", "Scripts", "python.exe")
						: join(root, "venv", "bin", "python");
				const agent = join(root, "inbox_agent.py");
				// Body through a file, never argv: no shell involved, but a body that
				// starts with "-" would still be read as a flag.
				const dir = mkdtempSync(join(tmpdir(), "toragents-send-"));
				const bodyFile = join(dir, "body.txt");
				writeFileSync(bodyFile, String(params.body ?? ""));
				const args = [agent, "send", "--to", String(params.to), "--body-file", bodyFile];
				if (params.to_session) args.push("--to-session", String(params.to_session));
				const res = spawnSync(py, args, {
					encoding: "utf8",
					env: { ...process.env, TORAGENTS_HOME: root },
					timeout: 180_000,
					});
				const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
				if (res.status !== 0) {
					throw new Error(`send to ${params.to} failed (exit ${res.status}):\n${out.slice(-1500)}`);
				}
				let id = "";
				try {
					id = JSON.parse(res.stdout).id || "";
				} catch {
					/* some daemon errors print prose; the id is best effort */
				}
				logSaid("out", String(params.to), String(params.body ?? ""), id);
				paintChat();
				const tone = peerTone(STATE, String(params.to));
				const styles = peerStyles(STATE, String(params.to));
				const words = freshWords(py, agent, root, bodyFile, styles);
				return {
					content: [
						{
							type: "text" as const,
							text:
								(id
									? `sent to ${params.to} — id ${id}`
									: `send to ${params.to} reported success:\n${out.slice(-600)}`) +
								(tone ? `\nregister for ${params.to}: ${tone}` : "") +
								(words.names.length || words.moves.length
									? `\nfresh words (${words.sizes.names ?? "?"} names in pool): ` +
										[...words.names, ...words.moves].slice(0, 4).join(" · ")
									: ""),
						},
					],
					details: { to: params.to, id, ok: true, tone, styles, words }, 
				};
			},
	});

	pi.registerCommand("toragents-takeover", {
		description: "Make this session the one that delivers Tor messages",
		handler: async (_args: any, ctx: any) => {
			try {
				writeFileSync(join(STATE, CONSUMER_FILE), JSON.stringify({
					pid: process.pid, session: sessionLabel(), at: Date.now(),
				}));
				CONSUMER = true;
				await poll(ctx);
				ctx.ui.notify("toragents: this session now owns message delivery", "info");
			} catch (e: any) {
				try { ctx.ui.notify(`toragents: takeover failed: ${e?.message || e}`, "warning"); } catch {}
			}
		},
	});

	pi.registerCommand("toragents-chat", {
		description: "Show or hide the Tor conversation panel beside the editor",
		handler: async (_args: any, ctx: any) => {
			CHAT_WIDGET = !CHAT_WIDGET;
			try {
				if (!CHAT_WIDGET) ctx.ui.setWidget("toragents-chat", undefined);
				else paintChat(ctx);
				ctx.ui.notify(`toragents: conversation panel ${CHAT_WIDGET ? "shown" : "hidden"}`, "info");
			} catch {}
		},
	});

	// Manual check that does not wait for the next tick.

	pi.registerCommand("toragents-check", {
		description: "Check the Tor inbox now and deliver anything new",
		handler: async (_args, ctx) => {
			await poll(ctx);
			try {
				ctx.ui.notify(`toragents: checked ${INBOX}`, "info");
			} catch {
				/* ignore */
			}
		},
	});

	pi.registerCommand("toragents-mute", {
		description: "Stop delivering Tor messages into this session (they stay unread)",
		handler: async (_args, ctx) => {
			const ok = setMuted(true);
			try {
				ctx.ui.notify(
					ok
						? `toragents: muted as ${muteKey()}; messages stay unread and can be drained with the inbox command`
						: "toragents: could not write the mute marker",
					ok ? "info" : "warning",
				);
			} catch {}
		},
	});

	pi.registerCommand("toragents-unmute", {
		description: "Resume delivering Tor messages into this session",
		handler: async (_args, ctx) => {
			const ok = setMuted(false);
			try {
				ctx.ui.notify(ok ? "toragents: unmuted" : "toragents: could not remove the mute marker", "info");
			} catch {}
		},
	});

	pi.registerCommand("toragents-retry", {
		description: "Retry messages that failed to deliver",
		handler: async (_args, ctx) => {
			const ids = [...failedIds(), ...stuck];
			let cleared = 0;
			for (const id of ids) {
				stuck.delete(id);
				try {
					unlinkSync(join(FAILED_DIR, id));
					cleared++;
				} catch {
					/* no marker to remove: it was never written */
				}
			}
			// Drain now rather than up to POLL_MS later.
			await poll(ctx);
			try {
				ctx.ui.notify(
					cleared === 0
						? "toragents: nothing to retry"
						: `toragents: ${cleared} message(s) queued for delivery again`,
					"info",
				);
			} catch {}
		},
	});

	pi.registerCommand("toragents-said", {
		description: "Print the conversation transcript (what was said, both directions)",
		handler: async (_args: any, ctx: any) => {
			try {
				ctx.ui.notify(renderChat(72).join("\n"), "info");
			} catch {}
		},
	});

	pi.registerCommand("toragents-status", {
		description: "Show Tor inbox watching state",
		handler: async (_args, ctx) => {
			const { messages } = scanInbox();
			const failed = new Set([...failedIds(), ...stuck]);
			const unread = messages.filter((m) => !announced.has(m.id) && !failed.has(m.id)).length;
			const lines = [
				`watching    ${timer ? "yes" : "no"} every ${POLL_MS}ms`,
				`inbox       ${INBOX}`,
				`resolved by ${RESOLVED.why}`,
				`on disk     ${messages.length}`,
				`undelivered ${unread}`,
				`failed      ${failed.size}${failed.size ? " (" + [...failed].join(", ") + ")" : ""}${failed.size ? " -- /toragents-retry" : ""}`,
				`state       ${existsSync(ANNOUNCED) ? "memo present" : "memo missing (will seed)"}`,
			];
			try {
				ctx.ui.notify(lines.join("\n"), "info");
			} catch {
				/* ignore */
			}
		},
	});
}
