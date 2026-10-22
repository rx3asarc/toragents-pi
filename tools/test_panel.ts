#!/usr/bin/env bun
/**
 * The reader: subject lines, collapsed cards, the bottom strip, and the column
 * that reserves screen columns.
 *
 * Run with tools/test_panel.sh — this test needs @earendil-works/pi-tui, which is
 * only resolvable from pi's own node_modules; the wrapper points NODE_PATH at it.
 *
 * WHAT IS ASSERTED, in the order these things break:
 *
 *   1. THE TRANSCRIPT MERGE. chat.jsonl is the spine, but its stored bodies were
 *      once cut at 2 000 characters, and mail can be consumed on one box and
 *      still sit in inbox/ on another. So: a short stored body must be replaced by
 *      the whole one from inbox/, and a message the transcript never saw must still
 *      appear. Reading only the spine hides the technical half of every message.
 *
 *   2. THE SUBJECT LINE. Peers write 1.5-3k character letters with no subject. The
 *      derived subject must pick the sentence carrying the identifier rather than
 *      the polite opening, and the preview under it must not repeat it — two lines
 *      of the same text is not a preview.
 *
 *   3. THE GEOMETRY. Everything fits the width it is given, the strip is exactly
 *      its configured height, a card that fits is scrolled into view without the
 *      list jumping, and a card taller than the window aligns to its header (or you
 *      are looking at the tail of a body with no idea which message you are in).
 *
 *   4. THE COLUMN ITSELF, against a fake TUI: installing narrows
 *      terminal.columns, painting happens inside pi's own render frame, and
 *      dispose restores width, render hook and wheel routing. If dispose does not
 *      restore, closing the column leaves pi permanently narrowed.
 *
 * The fixture is built in a temp dir, so this runs on any machine and asserts the
 * same things everywhere. A test that reads the author's mailbox tests the author.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

const fails: string[] = [];
const ok = (cond: any, msg: string) => {
	if (!cond) fails.push(msg);
	else console.log("ok   " + msg);
};

// ── the fixture ─────────────────────────────────────────────────────────────
//
// Shaped like a real exchange: a rehydrated truncation, an inbox-only message,
// a long letter with paragraphs, a greeting that must not become the subject,
// and a clause the same peer restates (so the preview dedupe must allow a
// leftover occurrence instead of cutting the sentence you are about to read).
const STATE = mkdtempSync(join(tmpdir(), "toragents-panel-"));
mkdirSync(join(STATE, "inbox"), { recursive: true });
mkdirSync(join(STATE, "sent"), { recursive: true });
const T0 = 1_760_000_000; // fixed clock: nothing here may depend on when it runs

const GREETING = "hi there \u2014 and thanks for the pointer.\nthe digest never worked, see tools/repro_digest_dead.py for the proof.";
const long1 =
	"the digest i told you was live had never worked once, and four of my own green commits sat on top of it. " +
	"stop and pull before you reinstall 1d8c847.\n\n" +
	"what i actually ran, on my box, against the deployed daemon:\n\n" +
	"  tools/repro_digest_sides.py --peer alpha\n  -> exit 0, delivered-both, claimed/ has 27 rows\n\n" +
	"the claimed/ ledger is the proof: 27 rows, each carrying the peer label and the message id, and the " +
	"digest that summarises them disagrees with the count only when the tail is written after the head. " +
	"that is a two-writer bug, not a reporting bug, and no amount of re-reading the report will find it.\n\n" +
	"so the fix is ordering, not reporting: write the tail first, mark it, then the head. if a crash lands " +
	"between them the ledger is incomplete and visibly so, which is the property we want. i'll take the rows, " +
	"stores named, no summary. \u2661";
const long2 =
	"it's the right answer for the SENDER, but it's quiet for the RECEIVER. " +
	"a half-deployed box would accept-unverified forever and nothing fails loudly.\n\n" +
	"the deployment gap only shows up in a response field the sender might not read, so pair it with a loud " +
	"local signal: the daemon logs \"accepted with unverified presence \u2014 no heartbeat writer\", and doctor " +
	"flags \"no _writer.json\" as a deployment issue rather than an operational one. same sentence, fourth " +
	"instance, and it's the one that keeps a checkable claim from becoming an asserted one.\n\n" +
	"absent data is not data of absence: an empty registry cannot tell \"no windows\" from \"no writer\", so it " +
	"must not answer with a verdict. the sentinel fixes that by turning one ambiguous fact into two distinct " +
	"ones. keep it.";
const long3 = Array.from({ length: 18 }, (_, i) => `paragraph ${i + 1}: the marker that licenses a refusal must be current itself, or the refusal is stale by construction.`).join("\n\n");

const messages = [
	{ id: "aaa1", dir: "in", at: T0 + 60, peer: "kisu", body: "hi there \u2014 and thanks for the pointer.\nthe digest never worked, see tools/repro_digest_dead.py for the proof." },
	{ id: "bbb2", dir: "out", at: T0 + 120, peer: "kisu", body: "confirmed in my deployed copy: line 335 is PublicKey.from_dict, wire.py defines PublicIdentity, and the except at 338 rewrites the NameError into \"unknown op 'digest'\"." },
	{ id: "ccc3", dir: "in", at: T0 + 180, peer: "kisu", body: long1 },
	{ id: "ddd4", dir: "out", at: T0 + 240, peer: "kisu", body: "the reframing is right, and it's the more useful one: locatability, not safety." },
	{ id: "eee5", dir: "in", at: T0 + 300, peer: "kisu", body: long2 },
	{ id: "fff6", dir: "in", at: T0 + 360, peer: "kisu", body: long3 },
	{ id: "ggg7", dir: "out", at: T0 + 420, peer: "kisu", body: "run `python3 inbox_agent.py doctor` on your machine and send me the two lines it prints." },
];

// ── the ghost (2026-10-20) ────────────────────────────────────────────────
// A row appended to chat.jsonl by hand, announced as new mail, presented to a live
// session with a peer label and a session name -- and never stored in inbox/, because
// no transport ever carried it. Body is a 2 000-character prefix of a real letter.
const ghost = { id: "TESTNOTIFY-0001", dir: "in" as const, at: T0 + 500, peer: "kisu", body: long3.slice(0, 300) };

// The spine: order and who said it. Two entries are deliberately damaged:
// ccc3 stores a 2 000-character truncation (the old cap), and hhh8 is missing
// entirely from the spine but present in inbox/.
const spine = [...messages, ghost]
	.filter((m) => m.id !== "hhh8")
	.map((m) => ({ at: m.at * 1000, dir: m.dir, peer: m.peer, id: m.id, body: m.id === "ccc3" ? m.body.slice(0, 300) : m.body }));
writeFileSync(join(STATE, "chat.jsonl"), spine.map((r) => JSON.stringify(r)).join("\n") + "\n");

// inbox/: the received body as it came off the wire — whole.
const inboxOnly = { id: "hhh8", from_label: "kisu", body: "this one never reached the transcript on my box, and a reader that trusts the spine alone would hide it: verified against 7c3925c, not taken on faith.", received: T0 + 480 };
mkdirSync(join(STATE, "claimed"), { recursive: true });
writeFileSync(join(STATE, "claimed", ghost.id), "stage 1792495710762");
writeFileSync(join(STATE, "announced.json"), JSON.stringify([...messages.filter((m) => m.dir === "in").map((m) => m.id), "hhh8", ghost.id]));
for (const m of [...messages.filter((m) => m.dir === "in"), inboxOnly]) {
	writeFileSync(join(STATE, "inbox", `${m.id}.json`), JSON.stringify({ id: m.id, body: m.body, from_label: m.peer || m.from_label, received: m.at ?? m.received }));
}
for (const m of messages.filter((m) => m.dir === "out")) {
	writeFileSync(join(STATE, "sent", `${m.id}.json`), JSON.stringify({ id: m.id, body: m.body, at: m.at, receipt: "sent" }));
}

// policy: the placement contract, written the way a human would.
writeFileSync(
	join(dirname(STATE), "policy.json"),
	JSON.stringify({ receiver: "rowan", panel: { default: "strip", column: ["stage"] }, fallbackToAnyone: true }),
);

process.env.TORAGENTS_STATE = STATE;
process.env.TORAGENTS_HOME = dirname(STATE);
delete process.env.TORAGENTS_PANEL;

const { markRepeats, readMailFacts, readThread, threadSignature, tldr } = await import("../_lib/toragents-transcript.ts");
const { SideColumn, clampColumnWidth, dividerIntent, parseSgrMouse } = await import("../_lib/toragents-side-column.ts");
const { PANEL_VERSION, claimBody, repliesByPeer, renderColumn, renderFooter, renderStrip, splitAside, statusSummary, subject, waitingOn } = await import("../toragents-panel.ts");
const { POLICY_DEFAULTS, isReceiver, panelMode, policyPath, readPolicy, writePanelWidth } = await import("../_lib/toragents-policy.ts");

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

// The reader's self-declared version, pinned the way EXT_VERSION is: a change to how
// the pane behaves must arrive with a bump, or a window loaded before it will keep
// rendering the old shape and look healthy. Change this pair together, deliberately.
ok(PANEL_VERSION === 8, `the reader is panel v8 (found v${PANEL_VERSION}) — bump both sides together`);

// ── 1. the transcript merge ────────────────────────────────────────────────
const rows = readThread();
ok(rows.length === messages.length + 2, `every message is present, ghost included (${rows.length} of ${messages.length + 2})`);
ok(rows.every((r: any, i: number) => i === 0 || r.at >= rows[i - 1].at), "chronological order");
ok(rows.some((r: any) => r.dir === "in") && rows.some((r: any) => r.dir === "out"), "both directions read");

{
	const rehydrated = rows.find((r: any) => r.id === "ccc3");
	ok(rehydrated.body.length > 300, `a truncated stored body is replaced by the whole one (${rehydrated.body.length} chars)`);
	ok(rehydrated.body.includes("the fix is ordering, not reporting"), "the rehydrated body is the real text, not a longer truncation");
	const missed = rows.find((r: any) => r.id === "hhh8");
	ok(Boolean(missed), "mail the transcript never saw still shows");
	ok(Boolean(missed) && missed.body.includes("7c3925c"), "and it shows its wire body");

	// Order is the spine's job: an inbox-only message must not be promoted to the
	// end just because it was found last.
	const order = rows.map((r: any) => r.id);
	ok(order.indexOf("hhh8") > order.indexOf("ggg7"), "an unseen message lands by its received time");
}

ok(threadSignature().includes("|"), "the change signature is cheap to compare");
ok(tldr(long1).length > 0 && tldr(long1).length <= 151, "tldr is non-empty and bounded");
ok(tldr("") === "", "tldr of an empty body is empty");

// ── 2. the subject line ────────────────────────────────────────────────────
console.log("\nsubjects:");
for (const m of messages.slice(0, 5)) console.log(`  ${subject(m.body)}`);

ok(messages.every((m) => subject(m.body).length > 0), "every message gets a subject");
ok(messages.every((m) => subject(m.body).length <= 61), "subjects are bounded");
ok(subject("").length > 0, "an empty body still yields a subject");
ok(subject("thanks! also, the fix is in 1d8c847 and wire.py line 335 is wrong.").includes("1d8c847"), "the subject prefers the sentence carrying the identifier");
ok(!/^(hi|hey|hello|thanks|thank you)\b/i.test(subject(messages[0].body)), "a greeting is not the subject");
ok(!/^(so|and|but|also)\b/i.test(subject("so build it once, and then have the reader notice.")), "a subject does not start mid-sentence on a conjunction");
// The aside is a field, and printing it twice made a marker look like a stutter: the row
// shows it as the subject, so the expanded body must start at the voice line.
{
	const withAside = "♡ **stop writing methodology notes.**\n\nkisu — a format test.\n\nsettled — bold moved";
	const c = claimBody(withAside, 60);
	ok(c.aside === true, "a letter opening with the glyph reports an aside");
	ok(c.subject === "stop writing methodology notes.", "the aside IS the subject, verbatim and unmarked");
	ok(!c.rest.includes("stop writing methodology"), "the aside does not appear again in the body");
	ok(c.rest.startsWith("kisu"), "the body starts at the voice line");
	const noAside = claimBody("kisu — a normal letter.\n\nsettled — something", 60);
	ok(!noAside.aside, "a letter with no aside is unchanged");
	ok(claimBody("  \n ♡ unmarked heart\n\nbody", 60).aside === true, "leading blank lines do not hide the aside");
	ok(splitAside("♡ **x**").rest === "", "an aside-only body leaves an empty rest");
}

// ── 3. the geometry ────────────────────────────────────────────────────────
const kOf = (m: any) => `${m.dir}:${m.id}`;
const viewAt = (idx: number, extra: any = {}) => {
	const probe = { selected: idx, expanded: new Set<string>(), seen: new Set(rows.map(kOf)), focused: false, top: 0, ...extra };
	const abs = renderColumn(rows, 46, 40, probe, theme).absolute;
	return { ...probe, top: Math.max(0, abs[idx] ?? 0) };
};

for (const width of [28, 46, 100]) {
	for (const height of [10, 30, 60]) {
		const out = renderColumn(rows, width, height, viewAt(rows.length - 1), theme).lines;
		ok(out.length === height, `column renders exactly ${height} rows at width ${width}`);
		ok(out.every((l: string) => visibleWidth(l) <= width), `column fits ${width} cols (${height} rows)`);
	}
}

{
	const newest = rows[rows.length - 1];
	const atNewest = renderColumn(rows, 46, 40, viewAt(rows.length - 1), theme);
	const s0 = atNewest.starts[rows.length - 1];
	const e0 = atNewest.ends[rows.length - 1];
	ok(s0 >= 0 && e0 <= 37, `the selected card is scrolled into view (${s0}..${e0})`);
	ok(atNewest.lines.join("\n").includes(subject(newest.body).slice(0, 18)), "the selected message shows its subject");

	// A window too short for the whole list must not paint what is above it.
	const short = renderColumn(rows, 46, 12, viewAt(rows.length - 1), theme).lines.join("\n");
	ok(!short.includes(subject(rows[0].body).slice(0, 18)), "a message outside the window is not painted");
	ok(short.includes(subject(newest.body).slice(0, 18)), "the window still shows what is selected");
}

{
	const idx = rows.findIndex((r: any) => r.id === "ccc3");
	const victim = rows[idx];
	const deep = victim.body.split("\n").map((l: string) => l.trim()).filter(Boolean)[5].slice(0, 24);
	const collapsed = renderColumn(rows, 46, 40, viewAt(idx), theme).lines.join("\n");
	const expanded = renderColumn(rows, 46, 40, viewAt(idx, { expanded: new Set([kOf(victim)]) }), theme).lines.join("\n");
	const first = victim.body.split("\n").map((l: string) => l.trim()).filter(Boolean)[0].slice(0, 24);
	ok(collapsed.includes(first), "a collapsed card shows the first line");
	ok(collapsed.includes("more line"), "a collapsed card says how much is hidden");
	ok(!collapsed.includes(deep), "deeper lines stay hidden while collapsed");
	ok(expanded.includes(deep), "expanding a message reveals deeper lines");
}

{
	// Tall cards align to the header; tall-enough cards are the case where
	// "follow the end" would hide the very header that says where you are.
	const idx = rows.findIndex((r: any) => r.id === "fff6");
	const tall = renderColumn(rows, 46, 40, viewAt(idx, { expanded: new Set([kOf(rows[idx])]) }), theme);
	ok(tall.starts[idx] === 0, "a card taller than the window aligns to its header");
	const focused = renderColumn(rows, 46, 40, viewAt(idx, { focused: true }), theme).lines[0];
	ok(focused.includes("FOCUS"), "focus is visible in the header");
	ok(renderColumn(rows, 46, 40, viewAt(idx), theme).starts.length === rows.length, "layout reports one start per message");
}

// The preview must not repeat the subject: two lines of the same text is not a preview.
{
	let repeats = 0;
	for (const m of rows) {
		const card = renderColumn([m], 46, 40, { selected: 0, expanded: new Set<string>(), seen: new Set([kOf(m)]), focused: false, top: 0 }, theme)
			.lines.slice(3, 5)
			.join(" ")
			.replace(/\s+/g, " ");
		const subj = subject(m.body).replace(/…$/, "").slice(0, 24).replace(/\s+/g, " ");
		if (subj.length > 12 && card.includes(subj)) repeats++;
	}
	ok(repeats <= 2, `previews rarely repeat the subject (${repeats} of ${rows.length})`);
}

// ── 4. the strip ───────────────────────────────────────────────────────────
{
	const seenAll = new Set(rows.map(kOf));
	for (const width of [60, 100, 160]) {
		const out = renderStrip(rows, width, seenAll, theme);
		ok(out.length === 4, `strip is 4 lines at width ${width}`);
		ok(out.every((l: string) => visibleWidth(l) <= width), `strip fits ${width} columns`);
	}
	const strip = renderStrip(rows, 120, seenAll, theme).join("\n");
	const newest = rows[rows.length - 1];
	ok(/toragents · kisu waiting/.test(strip), "strip says who is waiting on you, not how many messages exist");
	ok(!/toragents · \d+\b(?! waiting)/.test(strip), "strip does not report a message total");
	ok(strip.includes(subject(newest.body).slice(0, 18)), "strip shows the newest subject");
	ok(strip.includes("/toragents-panel"), "strip says how to open the full column");
	ok(/^\s+[←→] kisu/.test(strip.split("\n")[1]), "strip names the peer and direction");

	const unseen = new Set(rows.slice(0, -2).map(kOf));
	// Unread only matters when nothing is outstanding: with a reply as the last
	// word, arriving mail is news again, and the count is per-session because
	// "read" is a property of this window, not of the transcript.
	{
		const replied = [...rows, { id: "xxx7", dir: "out" as const, at: rows[rows.length - 1].at + 60, peer: "kisu", body: "replied." }];
		ok(statusSummary(replied, seenAll) === "", "after a reply, a fully read thread says nothing");
		const expected = replied.filter((m: any) => m.dir === "in" && !unseen.has(kOf(m))).length;
		ok(
			expected > 0 && statusSummary(replied, unseen) === `${expected} unread`,
			`after a reply, unseen mail is counted (got ${statusSummary(replied, unseen)})`,
		);
		ok(/\d+ unread/.test(renderStrip(replied, 120, unseen, theme).join("\n")), "strip falls back to unread when nothing is outstanding");
	}
	ok(renderStrip([], 100, new Set(), null).length === 4, "an empty strip still occupies its lines");

	// The status is derived from whose turn it is, so it needs no bookkeeping.
	{
		const answered = [...rows, { id: "zzz9", dir: "out", at: rows[rows.length - 1].at + 60, peer: "kisu", body: "replied, with the ledger line and the three corrections named." }];
		ok(waitingOn(answered).count === 0, "a reply ends the wait");
		ok(statusSummary(answered, seenAll) === "", "and leaves the header with nothing to say");
		ok(waitingOn(rows).count > 0 && waitingOn(rows).peers.length === 1, "an unanswered tail names its peer");
		ok(statusSummary(rows, seenAll) === "kisu waiting", "the header phrase comes from the transcript, not a counter");
		ok(waitingOn(rows).count === waitingOn([...rows]).count, "waiting is idempotent: same transcript, same answer");
		const withoutGhost = rows.filter((r: any) => r.id !== "TESTNOTIFY-0001");
		ok(waitingOn(withoutGhost).peers.length === 1, "the ghost is excluded before the tail assertions below");
		const twoPeers = [...withoutGhost, { id: "yyy8", dir: "in", at: withoutGhost[withoutGhost.length - 1].at + 120, peer: "maestro-pc", body: "second peer, same tail." }];
		ok(statusSummary(twoPeers, seenAll) === "2 waiting", "two peers in the tail are counted, not named");
	}

}

// ── 5. placement policy (the contract with the delivery half) ──────────────
{
	const policy = readPolicy(true);
	ok(policyPath() === join(dirname(STATE), "policy.json"), "policy is read from beside the state dir");
	ok(policy.receiver === "rowan", "the fixture policy names its receiver");
	ok(policy.panel.default === "strip", "the fixture policy sets a default placement");

	ok(isReceiver("rowan", policy), "the named receiver is the receiver");
	ok(!isReceiver("gale-fork-3", policy), "everybody else is not");
	ok(!isReceiver("Rowan", policy), "the compare is case-sensitive, exactly like delivery");
	ok(isReceiver(" rowan ", policy), "surrounding whitespace is trimmed on both sides");
	ok(!isReceiver("pi-01a15403", policy), "an id is not a name");
	ok(!isReceiver(undefined, policy), "a nameless session is not the receiver");
	ok(isReceiver("rowan", POLICY_DEFAULTS) === false, "with no receiver named, nobody is the receiver");

	ok(panelMode("rowan", policy) === "column", "the receiver gets the column");
	ok(panelMode("stage", policy) === "column", "a listed session gets the column");
	ok(panelMode("gale-fork-3", policy) === "strip", "everyone else gets the strip");
	ok(panelMode(undefined, policy) === "strip", "an unnamed session gets the strip");

	process.env.TORAGENTS_PANEL = "column";
	ok(panelMode("gale-fork-3", policy) === "column", "TORAGENTS_PANEL=column overrides policy");
	process.env.TORAGENTS_PANEL = "0";
	ok(panelMode("rowan", policy) === "off", "TORAGENTS_PANEL=0 overrides policy");
	delete process.env.TORAGENTS_PANEL;

	// A designation the delivery half does not implement is a designation that
	// silently does nothing, so the shared field and the rule are both asserted.
	const { existsSync, readFileSync } = await import("node:fs");
	const delivery = join(import.meta.dir, "..", "toragents_watch.ts");
	if (existsSync(delivery)) {
		const src = readFileSync(delivery, "utf8");
		ok(/export function mayClaimOwnership/.test(src), "the delivery half still owns the claim rule");
		ok(/POLICY_FILE|policy\.json/.test(src), "the delivery half reads the same policy file");
		ok(/\.receiver/.test(src), "the delivery half reads the same receiver field");
	} else {
		console.log("  (toragents_watch.ts not beside tools/ — cross-half check skipped)");
	}
}

// ── 6. the column against a fake TUI ───────────────────────────────────────
{
	const writes: string[] = [];
	const listeners: Array<(d: string) => any> = [];
	const fakeTerminal = {
		columns: 140,
		rows: 40,
		write: (s: string) => writes.push(s),
		onInput: (fn: (d: string) => any) => {
			listeners.push(fn);
			return () => listeners.splice(listeners.indexOf(fn), 1);
		},
	};
	let renders = 0;
	const mouseCalls: any[] = [];
	const fakeTui: any = {
		terminal: fakeTerminal,
		mode: "tui",
		doRender: () => {
			renders++;
		},
		requestRender: () => {},
		routeWheel: () => "pi",
		handleMouseEvent: (event: any) => {
			mouseCalls.push(event);
			return "pi";
		},
	};
	const col = new SideColumn(fakeTui, {
		width: 46,
		minTerminalWidth: 100,
		render: (w: number, r: number) => renderColumn(rows, w, r, viewAt(rows.length - 1), theme).lines,
		onWheel: () => true,
	});
	const before = fakeTerminal.columns;
	const installed = col.install();
	ok(installed.ok, `column mounted (${installed.why})`);
	ok(fakeTerminal.columns === before - 46 - 1, `pi is narrowed to ${before - 46 - 1} columns`);
	ok(col.mounted, "column reports itself mounted");

	writes.length = 0;
	fakeTui.doRender();
	ok(renders > 0, "doRender still ran pi's own render");
	const painted = writes.join("");
	ok(painted.includes("toragents"), "column content was painted");
	ok(/\x1b\[\d+;\d+H/.test(painted), "column is painted with absolute cursor moves");

	// The drag, end to end: press on the divider, move, release. This is the part
	// a fake TUI can actually prove -- that the event reaches the column, that the
	// width only changes on release, and that the commit callback fires once.
	{
		let committed: number | null = null;
		const resizeTerminal = { ...fakeTerminal, columns: 176, write: (x: string) => writes.push(x) };
		const resizeTui: any = {
			terminal: resizeTerminal,
			mode: "tui",
			doRender: () => {},
			requestRender: () => {},
			handleMouseEvent: (event: any) => {
				mouseCalls.push(event);
				return "pi";
			},
		};
		const draggable = new SideColumn(resizeTui, {
			width: 60,
			minTerminalWidth: 100,
			render: (w: number, r: number) => renderColumn(rows, w, r, viewAt(0), theme).lines,
			onResizeCommit: (w: number) => {
				committed = w;
			},
		});
		ok(draggable.install().ok, "a resizable column mounts");
		const dividerX = 176 - 60 - 1;
		resizeTui.handleMouseEvent({ button: 0, x: dividerX, y: 3, release: false });
		ok(draggable.resizing, "pressing the divider starts a drag");
		mouseCalls.length = 0;
		resizeTui.handleMouseEvent({ button: 32, x: 176 - 80 - 1, y: 3, release: false });
		ok(committed === null, "moving during a drag does not commit anything");
		ok(mouseCalls.length === 0, "drag events are consumed, not leaked to pi's selection");
		ok(resizeTerminal.columns === 176 - 60 - 1, "the chat is not reflowed mid-drag");
		resizeTui.handleMouseEvent({ button: 0, x: 176 - 80 - 1, y: 3, release: true });
		ok(committed === 80, `release commits the dragged width (got ${committed})`);
		ok(!draggable.resizing, "the drag is over");
		ok(resizeTerminal.columns === 176 - 80 - 1, "and only then does the chat reflow");
		ok(draggable.width === 80, "the reserved width is the chosen one");

		mouseCalls.length = 0;
		resizeTui.handleMouseEvent({ button: 35, x: 20, y: 3, release: false });
		ok(mouseCalls.length === 1, "motion over the chat still reaches pi, so selection keeps working");

		resizeTui.handleMouseEvent({ button: 35, x: 176 - 80 - 1, y: 3, release: false });
		ok(mouseCalls.length === 1, "motion over the divider is ours");

		draggable.dispose();
		ok(resizeTerminal.columns === 176, "dispose gives the terminal its width back");
		resizeTui.handleMouseEvent({ button: 0, x: 10, y: 1, release: false });
		ok(mouseCalls.length === 2, "dispose restores pi's own mouse handler");
	}

	col.dispose();
	ok(fakeTerminal.columns === before, `dispose restores the terminal width (${before})`);
	ok(!col.mounted, "column reports itself unmounted");
	ok(fakeTui.doRender.name !== "wrapped", "doRender hook removed cleanly");

	const narrow = new SideColumn({ ...fakeTui, terminal: { ...fakeTerminal, columns: 90 } }, {
		width: 46,
		minTerminalWidth: 100,
		render: () => [],
		onWheel: () => true,
	});
	const refused = narrow.install();
	ok(!refused.ok && /90/.test(refused.why), "refuses to split a narrow terminal (90 columns; need 100)");
}

// ── 6. the divider: a width the user chose ─────────────────────────────────
//
// The drag is the one thing here that cannot be reviewed by reading it, so the
// geometry is a pure function and the assertions drive it with the raw button
// mask pi actually delivers.
{
	const cols = 176;
	ok(clampColumnWidth(10, cols) === 30, "a column cannot be dragged narrower than its floor");
	ok(clampColumnWidth(500, cols) === cols - 60, "the chat keeps its 60 columns no matter how hard you pull");
	ok(clampColumnWidth(Number.NaN, cols) === 30, "a nonsense width falls back to the floor, not to NaN");

	const dividerX = cols - 50 - 1;
	ok(dividerIntent({ cols, width: 50, x: dividerX, button: 35, release: false, dragging: false }).kind === "hover",
		"motion over the divider is a hover (button 35 = motion, no button)");
	ok(dividerIntent({ cols, width: 50, x: 20, button: 35, release: false, dragging: false }).kind === "none",
		"motion over the chat is not ours — selection must keep working");
	ok(dividerIntent({ cols, width: 50, x: dividerX, button: 0, release: false, dragging: false }).kind === "start",
		"pressing on the divider starts a drag");
	ok(dividerIntent({ cols, width: 50, x: dividerX, button: 0, release: true, dragging: false }).kind === "none",
		"a click on the divider without moving does nothing yet");

	const dragged = dividerIntent({ cols, width: 50, x: cols - 70 - 1, button: 32, release: false, dragging: true });
	ok(dragged.kind === "drag" && dragged.width === 70, "dragging left widens the column to the pointer");
	const ended = dividerIntent({ cols, width: 50, x: cols - 70 - 1, button: 0, release: true, dragging: true, candidate: 70 });
	ok(ended.kind === "end" && ended.width === 70, "release commits the width the pointer was showing");
	const pinned = dividerIntent({ cols, width: 50, x: 2, button: 32, release: false, dragging: true });
	ok(pinned.kind === "drag" && pinned.width === cols - 60, "dragging past the limit pins it, it does not run away");

	const sgr = parseSgrMouse("\x1b[<32;120;10M");
	ok(sgr && sgr.button === 32 && sgr.x === 119 && sgr.y === 9 && !sgr.release, "SGR mouse decodes to 0-based cells");
	ok(parseSgrMouse("\x1b[<0;1;1m")?.release === true, "the lowercase terminator is a release");
	ok(parseSgrMouse("j") === null, "a keystroke is not a mouse report");
}

// ── 7. the width the user chose outlives the window ────────────────────────
//
// Written on release only (a drag would otherwise rewrite the file sixty times a
// second), through a read-modify-write so keys this tool does not know survive.
{
	const home = mkdtempSync(join(tmpdir(), "toragents-policy-"));
	const path = join(home, "policy.json");
	writeFileSync(path, JSON.stringify({ receiver: "rowan", panel: { default: "strip", column: ["rowan"] }, keep: "me" }));
	const previous = process.env.TORAGENTS_HOME;
	process.env.TORAGENTS_HOME = home;
	try {
		ok(readPolicy(true).panel.width === 0, "an un-dragged width reads as 0, meaning 'no choice'");
		ok(writePanelWidth(58) === true, "the chosen width is written");
		const back = readPolicy(true);
		ok(back.panel.width === 58, `the width comes back on the next read (got ${back.panel.width})`);
		const raw = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
		ok(raw.receiver === "rowan" && raw.keep === "me", "the write preserves policy this module does not own");
		ok(raw.panel.column[0] === "rowan", "and preserves the panel keys it does own");
		writePanelWidth(0);
		ok(readPolicy(true).panel.width === 0, "reset forgets the choice instead of freezing today's pixels");
	} finally {
		process.env.TORAGENTS_HOME = previous;
	}
}

// ── 8. the footer: mailbox facts, never inferred ───────────────────────────
//
// The three things the transcript cannot express: a letter that never left, a
// sender you do not know, a send that cannot be confirmed.
{
	const dir = mkdtempSync(join(tmpdir(), "toragents-facts-"));
	mkdirSync(join(dir, "outbox"), { recursive: true });
	mkdirSync(join(dir, "inbox"), { recursive: true });
	mkdirSync(join(dir, "sent"), { recursive: true });
	const now = Math.floor(Date.now() / 1000);
	writeFileSync(join(dir, "outbox", "a.json"), JSON.stringify({
		to: "kisu", attempts: 22, created: now - 4920, sent_id: null,
		last_error: "exit 1: cannot reach tnhbv7cim4f after 4 attempts\nmore detail", body: "x".repeat(500),
	}));
	writeFileSync(join(dir, "outbox", "b.json"), JSON.stringify({
		to: "kisu", attempts: 3, created: now - 60, sent_id: null, last_error: "exit 1: no", body: "y".repeat(300),
	}));
	writeFileSync(join(dir, "outbox", "done.json"), JSON.stringify({ to: "kisu", attempts: 1, created: now - 9000, sent_id: "abc" }));
	writeFileSync(join(dir, "inbox", "m1.json"), JSON.stringify({ id: "m1", from_known: false, body: "who are you" }));
	writeFileSync(join(dir, "inbox", "m2.json"), JSON.stringify({ id: "m2", from_known: true, body: "hello" }));
	writeFileSync(join(dir, "sent", "s1.json"), JSON.stringify({ local_id: "s1", state: "unknown" }));
	writeFileSync(join(dir, "sent", "s2.json"), JSON.stringify({ local_id: "s2", state: "acked" }));

	const { readMailFacts } = await import("../_lib/toragents-transcript.ts");
	const f = readMailFacts(dir);
	ok(f.queued === 2, `only unsent letters are queued (got ${f.queued}; a delivered one is not pending)`);
	ok(f.worstAttempts === 22 && f.worstPeer === "kisu", "the footer reports the letter that has tried hardest");
	ok(f.lastError === "exit 1: cannot reach tnhbv7cim4f after 4 attempts", "the reason is the first line, not the whole manual");
	ok(f.strangers === 1, "an unknown sender is counted, a known one is not");
	ok(f.unsent === 1, "a send that cannot be confirmed is reported; an acknowledged one is not");
	ok(f.oldestQueued !== null && f.oldestQueued > 4_000_000, "the queue's age is how long the peer has been dark");
	ok(readMailFacts(join(dir, "does-not-exist")).queued === 0, "a missing mailbox reads as empty, not as a crash");

	const lines = renderFooter(f, 60, null).join("\n");
	ok(/outbox 2/.test(lines), "the footer shows the queue");
	ok(/22 tries/.test(lines), "and how hard it has been trying");
	ok(/unreachable/.test(lines) && /cannot reach/.test(lines), "and why, in the peer's own error words");
	ok(/1 unknown sender/.test(lines) && /1 unconfirmed/.test(lines), "and the two facts a tick-mark would hide");
	const narrow = renderFooter(f, 30, null);
	ok(narrow.length < renderFooter(f, 60, null).length, "a narrow column drops detail instead of wrapping into noise");

	const quiet = renderFooter({ ...f, queued: 0, strangers: 0, unsent: 0 }, 60, null);
	ok(quiet.length === 0, "an empty mailbox says nothing at all");

	const probe = { selected: 0, expanded: new Set<string>(), seen: new Set<string>(), focused: false, top: 0 };
	const withoutFooter = renderColumn(rows, 46, 20, probe, null).lines;
	const withFooter = renderColumn(rows, 46, 20, probe, null, f).lines;
	ok(withFooter.length === 20, "the footer does not change the height it promises pi");
	ok(/outbox/.test(withFooter.join("\n")) && !/outbox/.test(withoutFooter.join("\n")), "footer rows appear only when there are facts");
}

// ── 9. a reply the spine never saw still ends the wait ────────────────────
//
// Found on a live screen: the header said "7 waiting" after three of those seven
// had already been answered, because mail sent through the outbox is recorded in
// sent/, not chat.jsonl. The transcript is the order of the conversation, not the
// whole of what left the building.
{
	const rowsTail = [
		{ at: 1000, dir: "in" as const, peer: "kisu", id: "a", body: "older" },
		{ at: 2000, dir: "in" as const, peer: "kisu", id: "b", body: "older still" },
	];
	ok(waitingOn(rowsTail).count === 2, "without a reply, both are waiting");
	ok(waitingOn(rowsTail, { kisu: 2500 }).count === 0, "a send to that peer after them ends the wait");
	ok(waitingOn(rowsTail, { kisu: 1500 }).count === 1, "a send between them leaves the newer one waiting");
	ok(waitingOn(rowsTail, { maestro: 9999 }).count === 2,
		"answering somebody else does not answer kisu — the bug the single timestamp caused");
	ok(repliesByPeer([{ at: 900, dir: "out" as const, peer: "kisu", id: "z", body: "x" }], { kisu: 2600 }).kisu === 2600,
		"the transport's own record wins when it is newer than the transcript");
	ok(repliesByPeer([{ at: 3000, dir: "out" as const, peer: "kisu", id: "z", body: "x" }], { kisu: 2600 }).kisu === 3000,
		"and the transcript wins when it is");
	ok(Object.keys(repliesByPeer([], {})).length === 0, "no sends at all is empty, not a zero that would mean 1970 was a reply");
}

// ── 10. one letter is one unconfirmed letter ──────────────────────────────
//
// The queue retries, and every retry writes its own sent record (that is how "did
// it land?" stays answerable). Counting records would have reported five
// unconfirmed letters for the two actually written.
{
	const dir = mkdtempSync(join(tmpdir(), "toragents-sent-"));
	mkdirSync(join(dir, "sent"), { recursive: true });
	mkdirSync(join(dir, "outbox"), { recursive: true });
	mkdirSync(join(dir, "inbox"), { recursive: true });
	const base = { to: "kisu", state: "unknown", len: 10 };
	for (let i = 0; i < 5; i++) {
		writeFileSync(join(dir, "sent", `r${i}.json`), JSON.stringify({ ...base, local_id: `l${i}`, sha256: "aaaa", at: 1000 + i }));
	}
	writeFileSync(join(dir, "sent", "other.json"), JSON.stringify({ ...base, local_id: "l9", sha256: "bbbb", at: 2000 }));
	writeFileSync(join(dir, "sent", "acked.json"), JSON.stringify({ ...base, state: "acked", local_id: "l8", sha256: "cccc", at: 3000 }));
	const { readMailFacts } = await import("../_lib/toragents-transcript.ts");
	const f = readMailFacts(dir);
	ok(f.unsent === 2, `five retries of one letter and one other count as 2 unconfirmed (got ${f.unsent})`);
	ok(f.lastSent === 3_000_000, `the newest send is reported in ms (got ${f.lastSent})`);
	// Including acknowledged sends: an ack is still evidence you wrote to them, and
	// the newest evidence is what ends the wait.
	ok(f.sentByPeer.kisu === 3_000_000, `sends are tracked per correspondent (kisu at ${f.sentByPeer.kisu})`);
}

// ── 11. a letter that arrived twice is shown, and says so ─────────────────
//
// At-least-once delivery plus recorded-not-enforced dedup means a duplicate is a
// legitimate outcome, not a bug. kisu's requirement, and the right one: the second
// copy stays visible and is marked, because the alternative is the human reading
// his own machine stutter and filing it against the wrong part of the system.
{
	const dupBody = "liam. tier confirmed, and the receipt is uglier than your estimate.\n\nsecond paragraph.";
	const rowsDup = [
		{ at: 1000, dir: "in" as const, peer: "kisu", id: "orig1", body: dupBody },
		{ at: 1500, dir: "out" as const, peer: "kisu", id: "sent1", body: "my reply, distinct." },
		{ at: 2000, dir: "in" as const, peer: "kisu", id: "copy1", body: dupBody },
		{ at: 2500, dir: "in" as const, peer: "kisu", id: "other1", body: "a different letter entirely." },
	];
	const marked = markRepeats(rowsDup);
	ok(marked[0].repeatOf === undefined, "the first arrival is the letter, not a repeat");
	ok(marked[2].repeatOf === "orig1", "the second arrival points at the one it repeats");
	ok(marked[1].repeatOf === undefined && marked[3].repeatOf === undefined, "distinct letters are never marked");
	ok(markRepeats(marked).filter((m) => m.repeatOf).length === 1, "marking twice does not invent a second repeat");
	ok(markRepeats(rowsDup).length === rowsDup.length, "nothing is dropped — a repeat is a fact, not noise to hide");

	const probeDup = { selected: 2, expanded: new Set<string>(), seen: new Set<string>(), focused: false, top: 0 };
	const dupLines = renderColumn(marked, 46, 30, probeDup, null).lines.join("\n");
	ok(/repeat/.test(dupLines), "the repeat is labelled in the list");
	ok(/repeat of \d\d:\d\d/.test(dupLines) || /repeat of/.test(dupLines), "the label says which letter it repeats");
	ok(dupLines.includes("byte-identical"), "collapsed, it says why instead of repeating the same two lines");
	ok((dupLines.match(/tier confirmed/g) ?? []).length <= 1, "the same text is not shown twice in previews");

	// A repeat is not a second question.
	ok(waitingOn(marked).count === 1, "a repeat does not add a wait: one distinct letter is waiting, not two");
	// Answer kisu and the wait is gone, which is the only way to see the unread count.
	const answered = statusSummary(marked, new Set<string>(), { kisu: 9_999 });
	ok(answered === "2 unread", `unread counts letters, not copies (got "${answered}")`);
	ok(waitingOn([{ at: 1000, dir: "in" as const, peer: "kisu", id: "a", body: dupBody }, { at: 2000, dir: "in" as const, peer: "kisu", id: "b", body: dupBody, repeatOf: "a" }]).count === 1,
		"one letter that arrived twice is one letter waiting");
}

// ── 12. "unconfirmed" is a closed list, because the open one lied ──────────
//
// Measured on the real mailbox: 180 sent rows, 88 confirmed, 89 unknown, 3 pending.
// The reader skipped only "acked"/"delivered" -- words nothing in this transport
// writes -- so it reported 92 unconfirmed letters where the honest number was 8.
// The footer had been telling the human that most of his mail never landed.
{
	const { readMailFacts } = await import("../_lib/toragents-transcript.ts");
	const fsMod = await import("node:fs");
	const osMod = await import("node:os");
	const pathMod = await import("node:path");
	const home = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "toragents-ack-"));
	const st = pathMod.join(home, "state");
	for (const d of ["sent", "inbox", "outbox"]) fsMod.mkdirSync(pathMod.join(st, d), { recursive: true });
	const sent = (id: string, state: string, sha: string) =>
		fsMod.writeFileSync(pathMod.join(st, "sent", `${id}.json`),
			JSON.stringify({ local_id: id, state, to: "kisu", sha256: sha, at: 1000, body: "x" }));

	sent("a", "confirmed", "sha-a");
	sent("b", "acked", "sha-b");
	sent("c", "delivered", "sha-c");
	sent("d", "superseded", "sha-d");   // body delivered by a sibling attempt
	sent("e", "pending", "sha-e");
	sent("f", "unknown", "sha-f");
	sent("g", "refused", "sha-g");
	sent("h1", "unknown", "sha-h");      // retries of one letter count once
	sent("h2", "unknown", "sha-h");

	const facts = readMailFacts(st as any);
	ok(facts.unsent === 4, `only pending/unknown/refused are unconfirmed: expected 4, got ${facts.unsent}`);
	ok(facts.unsent !== 7, "a confirmed send is not an unconfirmed one");
	ok(facts.unsent !== 8, "retries of one letter are one letter");
	ok(facts.lastSent !== null, "acknowledgement does not erase the send clock");
	fsMod.rmSync(home, { recursive: true, force: true });
}

// ── 13. a row with no mailbox file behind it is mail-shaped, not mail ──────
//
// The transport stores the file first and appends the transcript row second, so a row
// without a file did not arrive over the wire. TESTNOTIFY-0001 did exactly this on
// 2026-10-20 and was presented to a live session as untrusted remote input, dressed
// with a peer label, a session name and a fingerprint.
{
	const rowsNow = readThread();
	const ghostRow = rowsNow.find((r) => r.id === "TESTNOTIFY-0001");
	ok(!!ghostRow, "the ghost is still in the transcript (the ledger is append-only)");
	ok(ghostRow?.unbacked === true, "a row with no inbox file is flagged unbacked");
	ok(rowsNow.filter((r) => r.dir === "in" && r.id !== "TESTNOTIFY-0001").every((r) => !r.unbacked),
		"every genuinely delivered inbound row stays unbacked=false");
	ok(rowsNow.filter((r) => r.dir === "out").every((r) => !r.unbacked),
		"outbound rows are never unbacked: they live in sent/, not inbox/");

	// Rendered alone: the badge must survive whatever window the list chooses, and a
	// claim about one row should not depend on nine others fitting on screen.
	const ghostLines = renderColumn([ghostRow!], 52, 12, { selected: 0, expanded: new Set<string>(), seen: new Set<string>(), focused: false, top: 0 }, theme).lines.join("\n");
	if (process.env.DUMP) console.log("---\n" + ghostLines);
	ok(/no mailbox file/.test(ghostLines), "the row says it has no mailbox file, on the row itself");

	const factsGhost = readMailFacts(STATE);
	ok(factsGhost.ghosts === 1, `announced-minus-inbox is one ghost (got ${factsGhost.ghosts})`);
	ok(factsGhost.phantomClaims === 1, `claimed-minus-inbox is one phantom claim (got ${factsGhost.phantomClaims})`);
	const claimedAllBacked = renderFooter({ ...factsGhost, ghosts: 0, phantomClaims: 0 } as any, 60, theme).join("\n");
	ok(!/no mailbox file/.test(claimedAllBacked), "a clean mailbox says nothing at all");
	const footerGhost = renderFooter({ ...factsGhost, givenUp: false } as any, 60, theme).join("\n");
	ok(/no mailbox file/.test(footerGhost), "the footer reports it even when the row is scrolled off");

	// The class no sha comparison can see: the pastiche is a prefix, not a copy.
	ok(rowsNow.filter((r) => r.repeatOf).every((r) => r.id !== "TESTNOTIFY-0001"),
		"a truncated pastiche is not a repeat, so the repeat marker must not claim it");
}

console.log(`\n${fails.length === 0 ? "ALL PASS" : "FAIL " + fails.length}`);
for (const f of fails) console.log("  - " + f);
process.exit(fails.length === 0 ? 0 : 1);
