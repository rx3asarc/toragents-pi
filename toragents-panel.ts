/**
 * toragents-panel — the Tor conversation as a right-hand column, read like mail.
 *
 * WHY A COLUMN AND NOT A WIDGET
 * pi's only in-editor surfaces are above/below the editor, so anything placed
 * there costs chat height: a 40-line panel under the editor is half of a 46-row
 * terminal, which is exactly what Maestro rejected. pi has no right pane in its
 * public API, and an overlay would float over chat text rather than sit beside
 * it. `_lib/toragents-side-column.ts` holds the reserved-column machinery
 * (borrowed from pi-sidebar-tui); this file owns the content and the keys.
 *
 * WHERE IT GOES
 * Placement is policy, not preference: `_lib/toragents-policy.ts` reads
 * ~/.toragents/policy.json, and the session it names as receiver gets this wide
 * column while every other chat gets a four-line strip at the bottom of the
 * editor. A 60-column column costs every window on the box; the receiver earns
 * it by being the one window where the conversation is the work. Any session can
 * still open the column with /toragents-panel, which is the escape hatch.
 *
 * THE SHAPE: A LIST OF MESSAGES, NOT A TRANSCRIPT
 * These peers write 1.5-3k character technical letters. Rendered as one wall of
 * wrapped text, a 46-column column shows about one message per screen and you
 * cannot see what arrived without reading it. So each message is a collapsed
 * card with the three things you need to decide "do I read this now":
 *
 *   ▸ ← kisu  14:02  2.5k  ●
 *     digest was dead — pull 1d8c847                <- subject
 *     stop and pull before you reinstall. the dig…  <- preview (2 lines)
 *     … 34 lines · enter opens
 *
 * Subject is derived, not stored: `subject()` scores a message's sentences and
 * picks the one carrying the most technical signal, because a peer's first
 * sentence is often a pleasantry ("conceded, and the concession is the
 * interesting part") while the commit id is in the third. Deterministic, local,
 * no model call — a subject that cost an API round trip per message would also
 * be one that can disagree with itself between renders.
 *
 * FOCUS
 * The column never steals a key the editor needs. `alt+f` gives it focus (border
 * turns accent-coloured); while focused, j/k/enter/space work as arrows and
 * expand. Esc or `alt+f` hands focus back. Everything also has an alt+ form, so
 * nothing here requires focus.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { panelMode, readPolicy, writePanelWidth } from "./_lib/toragents-policy.ts";
import { clampColumnWidth, COLUMN_MIN, SideColumn } from "./_lib/toragents-side-column.ts";
import {
	type MailFacts,
	readMailFacts,
	type Said,
	readThread,
	threadSignature,
	wrapBlock,
	writeSnapshot,
} from "./_lib/toragents-transcript.ts";

/**
 * Which reader is this window running?
 *
 * The delivery half already refuses to call two windows compatible when their code
 * differs (EXT_VERSION): two windows running different code while both look fine is
 * how a stale one keeps lying quietly. The reader had no such number, and it showed
 * — a window started before the policy layer existed kept its old pane and had no
 * way to say so. Bump this whenever behaviour changes in a way a running window
 * would not otherwise notice, and bump `PANEL_VERSION` in tools/test_panel.ts with it.
 *
 * Self-declared for now, and reported when the pane mounts. It is not yet consumed
 * by doctor; when it is, it should come from here rather than from a second copy.
 */
export const PANEL_VERSION = 8;

const WIDTH_DEFAULT = 46;
const MIN_TERMINAL = 110;
const POLL_MS = 1500;
const SUBJECT_MAX = 60;
const PREVIEW_LINES = 2;

/**
 * How wide the column is.
 *
 * Proportional rather than fixed, because the subject line is the thing being
 * read: a 46-column column clips most subjects mid-clause ("the safety property
 * is right, but it's…"), and a fixed 60 would eat half of a 110-column terminal.
 * TORAGENTS_PANEL_WIDTH overrides everything.
 */
/**
 * The width to reserve, in order of authority: an operator's env override, the
 * width the user dragged the edge to, then the proportional default.
 *
 * The middle term is why this function exists. A fixed 36% is the program's
 * guess about how much of the screen the conversation deserves; the moment a
 * person drags the edge they have replaced that guess with an answer, and an
 * answer outranks a guess.
 */
function columnWidth(terminalWidth = 0): number {
	const cols = terminalWidth > 0 ? terminalWidth : 400;
	const raw = Number(process.env.TORAGENTS_PANEL_WIDTH || 0);
	if (Number.isFinite(raw) && raw > 0) return clampColumnWidth(Math.round(raw), cols);
	let saved = 0;
	try {
		saved = Number(readPolicy().panel?.width || 0);
	} catch {
		saved = 0;
	}
	if (Number.isFinite(saved) && saved >= COLUMN_MIN) return clampColumnWidth(Math.round(saved), cols);
	if (!terminalWidth) return WIDTH_DEFAULT;
	return clampColumnWidth(Math.round(terminalWidth * 0.36), cols);
}

/**
 * Mailbox facts, refreshed on a short clock rather than per paint.
 *
 * `readMailFacts` is mtime-cached, but a wheel spin can repaint sixty times a
 * second and each of those would still be three `stat` calls. Facts change when
 * mail arrives or a send succeeds -- one and a half seconds is far finer than
 * that and free.
 */
let factsMemo: { at: number; facts: MailFacts } | null = null;
function facts(): MailFacts {
	const now = Date.now();
	if (!factsMemo || now - factsMemo.at > 1500) factsMemo = { at: now, facts: readMailFacts() };
	return factsMemo.facts;
}

/**
 * When this side last sent anything, according to both records that know.
 *
 * The transcript holds what this session wrote; sent/ holds what the transport
 * actually put on the wire, including outbox retries that never touched the
 * spine. Later of the two wins. Pure, so it can be tested against a fixture
 * instead of the author's mailbox.
 */
export function repliesByPeer(msgs: Said[], sentByPeer: Record<string, number> = {}): Record<string, number> {
	const out: Record<string, number> = { ...sentByPeer };
	for (const m of msgs) {
		if (m.dir !== "out") continue;
		if (!out[m.peer] || m.at > out[m.peer]) out[m.peer] = m.at;
	}
	return out;
}

function ago(ms: number): string {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86_400) return `${Math.round(s / 3600)}h`;
	return `${Math.round(s / 86_400)}d`;
}

function chars(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function keyOf(m: Said): string {
	return `${m.dir}:${m.id || m.at}`;
}

// ── subject ──────────────────────────────────────────────────────────────────

/**
 * Technical signal in a sentence: an identifier, a sha, a path, a §ref, a
 * figure. Used to score sentences, never shown.
 */
function signalScore(sentence: string): number {
	let n = 0;
	n += (sentence.match(/`[^`]{2,40}`/g) || []).length * 3;
	n += (sentence.match(/\b[\w./-]{2,60}\.(?:ts|tsx|js|mjs|cjs|py|json|jsonl|md|sh|ya?ml|toml)\b/g) || []).length * 3;
	n += (sentence.match(/\b[0-9a-f]{7,40}\b/g) || []).length * 3;
	n += (sentence.match(/§\s?\d+(?:\.\d+)?/g) || []).length * 2;
	n += (sentence.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) || []).length;
	n += (sentence.match(/\b\d+(?:[.,]\d+)?\s?(?:%|ms|s|x|bits?|bytes?)\b/gi) || []).length;
	return n;
}

function tidy(sentence: string): string {
	return sentence
		.replace(/\s+/g, " ")
		.replace(/^[\s"'(\[—–-]+/, "")
		// A subject that starts with a conjunction reads like a fragment of the
		// previous message, which is exactly what it is: "so build it once ..."
		// only makes sense if you read the message before it.
		.replace(/^(?:so|and|but|also|then|hence|thus|ok|okay|well)\b[,:]?\s*/i, "")
		.replace(/:\s*$/, "")
		.trim();
}

/**
 * One line that says what a message is about.
 *
 * Sentence scoring, not summarisation: the sentence with the most identifiers
 * wins, with a small bonus for early position and a large penalty for being too
 * long or too short to be a subject. Falls back to the first sentence, because a
 * greeting still beats an empty subject line.
 */
export function subject(body: string, max = SUBJECT_MAX): string {
	return claimBody(body, max).subject;
}

/**
 * The subject plus the body with the subject's sentence cut out.
 *
 * Without the cut, a collapsed card reads "the reframing is right, and it's the…"
 * and then the preview begins with the very same sentence — two lines of the same
 * text, which is the opposite of a preview. Removing the claimed sentence makes
 * the preview show what you have NOT already read.
 */
/**
 * The aside is a field, and the panel was mining it as prose.
 *
 * `♡` opens a letter and the rest of that line is the one thing the letter says about
 * nobody's work. The row already prints a subject line, so the aside belongs there -- once.
 * What happened instead: the scorer picked the aside as the most interesting sentence, printed
 * it as the subject, and then the expanded body printed it again as line one. A marker that
 * appears twice is not a marker, it is a rendering bug that reads as a stutter.
 *
 * So: split it off, and let the caller print the rest.
 */
export function splitAside(body: string): { aside: string; rest: string } {
	const text = String(body || "").replace(/\r/g, "");
	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length && !lines[i].trim()) i++;
	const first = (lines[i] || "").trim();
	if (!first.startsWith("\u2661")) return { aside: "", rest: text };
	const aside = first
		.slice(1)
		.trim()
		.replace(/^\*\*/, "")
		.replace(/\*\*$/, "")
		.trim();
	return { aside, rest: lines.slice(i + 1).join("\n").trim() };
}

export function claimBody(
	body: string,
	max = SUBJECT_MAX,
): { subject: string; rest: string; aside?: boolean } {
	const split = splitAside(body);
	if (split.aside) {
		const subj = split.aside.length > max ? split.aside.slice(0, Math.max(1, max - 1)) + "…" : split.aside;
		return { subject: subj, rest: split.rest, aside: true };
	}
	const text = String(body || "").replace(/\r/g, "\n").trim();
	if (!text) return { subject: "(empty)", rest: "" };
	const rawSentences = text
		.replace(/\n+/g, " ")
		.split(/(?<=[.!?])\s+|\s+—\s+|:\s+(?=[a-z])/)
		.filter((s) => s.trim().length > 0);
	const sentences = rawSentences.map((s) => tidy(s)).filter((s) => s.length > 0);
	if (sentences.length === 0) return { subject: "(empty)", rest: text };

	let best = "";
	let bestRaw = "";
	let bestScore = -Infinity;
	sentences.forEach((s, i) => {
		let score = signalScore(s) * 4;
		if (i === 0) score += 3;
		if (s.length >= 18 && s.length <= 90) score += 2;
		if (s.length > 120) score -= 4;
		if (/^(hi|hey|hello|thanks|thank you|ok|okay|noted|agreed|yes|no)\b/i.test(s)) score -= 5;
		// A sentence that ends in a colon is a lead-in to the next one, not a topic.
		if (/:$/.test(s)) score -= 2;
		if (score > bestScore) {
			bestScore = score;
			best = s;
			bestRaw = sentences[i] === undefined ? "" : rawSentences[i];
		}
	});

	const clean = best.replace(/[.;,:!?\s]+$/, "");
	const short =
		clean.length <= max
			? clean
			: (() => {
					const cut = clean.slice(0, max - 1);
					const space = cut.lastIndexOf(" ");
					return `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`;
				})();

	// Cut the claimed sentence out of the body, so the preview is new text.
	let rest = text;
	if (bestRaw) {
		const at = text.indexOf(bestRaw.trim());
		if (at >= 0) {
			rest = (text.slice(0, at) + "\n" + text.slice(at + bestRaw.trim().length)).trim();
			rest = rest.replace(/\n{3,}/g, "\n\n");
		}
	}
	return { subject: short, rest };
}

// ── the column ───────────────────────────────────────────────────────────────

export interface ColumnView {
	/** Index of the message the marker sits on. */
	selected: number;
	/** Message keys whose body is shown in full. */
	expanded: Set<string>;
	/** Keys already read; everything else carries the unread dot. */
	seen: Set<string>;
	/** True while the column owns j/k/enter. */
	focused: boolean;
	/** First visible content line. */
	top: number;
}

interface Block {
	key: string;
	lines: string[];
	start: number; // first content line index (after the header rule)
}

/**
 * Render the list.
 *
 * Returns the painted rows plus the layout the key handler needs (`starts` and
 * `ends` per message) so selection and scrolling agree with what is on screen
 * instead of re-deriving it separately and drifting.
 */
/**
 * The footer: what the mailbox knows that the conversation does not.
 *
 * Two lines when there is room, one when there is not, and silence when there is
 * nothing to report -- a status area that always has something in it is a status
 * area people stop reading. Every fact here is a file read; none of it is
 * inference, and "unknown" is spelled out rather than rounded to a tick.
 */
export function renderFooter(facts: MailFacts, width: number, theme: any): string[] {
	const dim = (x: string) => (theme ? theme.fg("dim", x) : x);
	const accent = (x: string) => (theme ? theme.fg("accent", x) : x);
	const out: string[] = [];
	if (facts.queued > 0) {
		const age = facts.oldestQueued !== null ? ago(Date.now() - facts.oldestQueued) : "";
		const bits = [`outbox ${facts.queued}`];
		if (facts.worstAttempts > 0) bits.push(`${facts.worstAttempts} tries`);
		if (age) bits.push(`queued ${age}`);
		out.push(accent(` ${bits.join(" · ")}`));
		if (width >= 40 && facts.worstPeer) {
			out.push(dim(`  ${facts.worstPeer} unreachable${facts.lastError ? ` — ${facts.lastError}` : ""}`));
		}
	}
	// A security fact, so it gets the accented line rather than the dim one: rows the
	// announcement step presented as new mail with no file behind them. This is the
	// one class no body comparison can see -- the injected row was a prefix, not a
	// copy -- and the audit costs nothing because both sides are already written.
	if (facts.ghosts > 0) {
		out.push(accent(` ⚠ ${facts.ghosts} announced with no mailbox file`));
	}
	// Claimed is worse than announced: a session was fed it and acted as if a letter
	// had arrived. Still one line, still no new state -- the claim file either has
	// mail behind it or it does not.
	if (facts.phantomClaims > 0) {
		out.push(accent(` ⚠ ${facts.phantomClaims} claimed with no mailbox file`));
	}
	const second: string[] = [];
	if (facts.strangers > 0) second.push(`${facts.strangers} unknown sender${facts.strangers === 1 ? "" : "s"}`);
	if (facts.unsent > 0) second.push(`${facts.unsent} unconfirmed`);
	if (second.length) out.push(dim(` ${second.join(" · ")}`));
	return out;
}

export function renderColumn(
	msgs: Said[],
	width: number,
	rows: number,
	view: ColumnView,
	theme: any,
	facts?: MailFacts,
	replies: Record<string, number> = {},
): { lines: string[]; starts: number[]; ends: number[] } {
	const dim = (s: string) => (theme ? theme.fg("dim", s) : s);
	const accent = (s: string) => (theme ? theme.fg("accent", s) : s);
	const muted = (s: string) => (theme ? theme.fg("muted", s) : s);
	const bold = (s: string) => (theme && theme.bold ? theme.bold(s) : s);
	const inner = Math.max(12, width - 2);

	const blocks: Block[] = [];
	if (msgs.length === 0) {
		blocks.push({ key: "empty", lines: [dim(" no messages yet")], start: 0 });
	}

	msgs.forEach((m, i) => {
		const isSel = i === view.selected;
		const key = keyOf(m);
		const open = view.expanded.has(key);
		const unread = !view.seen.has(key) && m.dir === "in";
		const arrow = m.dir === "out" ? "→" : "←";
		const when = new Date(m.at).toTimeString().slice(0, 5);

		// A repeat is shown, never hidden: a letter that arrived twice is a fact
		// about the wire, and the badge is cheaper than the human filing a bug
		// against his own machine for stuttering.
		const repeatOf = m.repeatOf ? msgs.find((x) => x.id === m.repeatOf) : undefined;
		const repeatTag = m.repeatOf
			? accent(`↑ repeat${repeatOf ? ` of ${new Date(repeatOf.at).toTimeString().slice(0, 5)}` : ""}`)
			: "";
		// A row the transcript presents as mail, with no mailbox file behind it, did
		// not arrive over the wire: the transport stores the file before it appends
		// the row. Say it on the row, because a friendly salutation with a peer label
		// and a session name is exactly the disguise the injection used.
		const unbackedTag = m.unbacked ? accent("⚠ no mailbox file") : "";
		const meta = [
			`${isSel ? accent("›") : " "} ${m.dir === "out" ? muted(arrow) : accent(arrow)} ${m.peer}`,
			dim(when),
			dim(chars(m.body.length)),
			repeatTag,
			unbackedTag,
			unread ? accent("●") : "",
		]
			.filter(Boolean)
			.join(" ");

		const claimed = claimBody(m.body, inner - 3);
		const lines: string[] = [truncateToWidth(meta, width, "")];
		lines.push(truncateToWidth(`   ${bold(claimed.subject)}`, width, ""));

		// Collapsed, blank lines are wasted rows: the preview is for scanning, so
		// paragraph breaks collapse out. Expanded keeps them — that is where the
		// writing's shape matters.
		const previewText = claimed.rest
			.split(/\n+/)
			.map((l) => l.trim())
			.filter(Boolean)
			.join("\n");
		// The row's subject line IS the aside when there is one, so the expanded body starts
		// at the voice line. Printing both is the duplicate the panel shipped for one evening.
		const bodyText = open && claimed.aside ? claimed.rest : open ? m.body : previewText;
		const bodyLines = wrapBlock(bodyText, inner - 2);
		if (!open && m.repeatOf) {
			lines.push(truncateToWidth(dim(`   ↑ byte-identical repeat — enter opens it anyway`), width, ""));
		} else if (open) {
			for (const l of bodyLines) lines.push(truncateToWidth(`   ${l}`, width, ""));
			lines.push(dim(`   ⌃ collapse`));
		} else {
			for (const l of bodyLines.slice(0, PREVIEW_LINES)) lines.push(truncateToWidth(`   ${dim(l)}`, width, ""));
			const rest = bodyLines.length - Math.min(bodyLines.length, PREVIEW_LINES);
			if (rest > 0) {
				lines.push(
					truncateToWidth(dim(`   … ${rest} more line${rest === 1 ? "" : "s"} · enter opens`), width, ""),
				);
			}
		}
		lines.push(dim(""));
		blocks.push({ key, lines, start: 0 });
	});

	// One header: whose turn it is, and whether this pane has the keyboard.
	const summary = statusSummary(msgs, view.seen, replies);
	const head = " toragents" + (summary ? ` · ${summary}` : "") + (view.focused ? accent(" · FOCUS") : "");
	const foot = view.focused
		? " j/k · enter open · g/G ends · esc out"
		: " alt+f focus · alt+j/k · alt+e open";

	// The footer sits between the list and the key hint, and only when it has
	// something to say: an always-present status row is a row nobody reads.
	const footer = facts ? renderFooter(facts, width, theme).slice(0, rows >= 14 ? 2 : 1) : [];
	const chrome = 2 + footer.length;
	const contentRows = Math.max(0, rows - chrome);
	const flat: string[] = [];
	const starts: number[] = [];
	const ends: number[] = [];
	for (const b of blocks) {
		starts.push(flat.length);
		flat.push(...b.lines);
		ends.push(flat.length - 1);
	}

	const top = Math.max(0, Math.min(view.top, Math.max(0, flat.length - contentRows)));
	const out = new Array<string>(Math.max(1, rows)).fill("");
	out[0] = truncateToWidth(head, width, "");
	if (rows >= 2) out[rows - 1] = dim(truncateToWidth(foot, width, ""));
	for (let i = 0; i < contentRows; i++) out[1 + i] = flat[top + i] ?? "";
	for (let i = 0; i < footer.length; i++) {
		const row = rows - 1 - footer.length + i;
		if (row > 0 && row < rows - 1) out[row] = truncateToWidth(footer[i], width, "");
	}
	return {
		lines: out,
		starts: starts.map((s) => s - top),
		ends: ends.map((e) => e - top),
		absolute: starts,
	};
}

/**
 * Who is waiting on you.
 *
 * A message total is a receipt, not a status: it only grows, it says nothing about
 * whose turn it is, and at 111 it reads as noise. What a reader actually wants to
 * know is whether the last word in the thread was theirs or yours.
 *
 * So this is a pure function of the transcript — the trailing run of received
 * messages since the last one you sent. Idempotent (same transcript, same answer,
 * however many times it is asked) and self-correcting (answer the message and the
 * run ends, so the count drops to zero on the next paint without anyone resetting
 * anything).
 */
export function waitingOn(msgs: Said[], replies: Record<string, number> = {}): { count: number; peers: string[] } {
	const peers: string[] = [];
	let count = 0;
	for (let i = msgs.length - 1; i >= 0 && msgs[i].dir === "in"; i--) {
		// Per correspondent, and a reply counts even when the transcript never saw
		// it: mail sent through the outbox is recorded in sent/, not chat.jsonl.
		// One timestamp for "I sent something" was worse than useless -- a letter to
		// kisu silenced a question from somebody else and the header went quiet on a
		// message nobody had answered.
		if (msgs[i].repeatOf) continue; // the same letter twice is still one letter
		if (msgs[i].at <= (replies[msgs[i].peer] ?? 0)) break;
		count++;
		if (!peers.includes(msgs[i].peer)) peers.push(msgs[i].peer);
	}
	return { count, peers };
}

/**
 * One phrase for the header, or nothing at all.
 *
 * Nothing is a real answer: when the last word is yours there is no news, and a
 * header that always has a number in it trains you to stop reading the number.
 */
export function statusSummary(
	msgs: Said[],
	seen: Set<string>,
	replies: Record<string, number> = {},
): string {
	const waiting = waitingOn(msgs, replies);
	if (waiting.count > 0) {
		if (waiting.peers.length === 1) return `${waiting.peers[0]} waiting`;
		return `${waiting.count} waiting`;
	}
	const unread = msgs.filter((m) => m.dir === "in" && !m.repeatOf && !seen.has(keyOf(m))).length;
	return unread > 0 ? `${unread} unread` : "";
}

// ── the strip ────────────────────────────────────────────────────────────────

const STRIP_LINES_DEFAULT = 4;

function stripLines(): number {
	const raw = Number(process.env.TORAGENTS_STRIP_LINES || STRIP_LINES_DEFAULT);
	return Math.max(2, Math.min(8, Math.round(Number.isFinite(raw) ? raw : STRIP_LINES_DEFAULT)));
}

/**
 * What a session that is NOT the receiver gets: the newest message, in a few
 * lines at the bottom, and a way into the wide column when it actually wants to
 * read the thread.
 *
 * The height is the point. A full column costs 60 columns of every window on the
 * box; on a chat you glance at, that is space paid for a conversation you are not
 * having. Lines are capped and the newest message is the only one shown, because
 * an inbox strip is a notification, not a reader.
 */
export function renderStrip(
	msgs: Said[],
	width: number,
	seen: Set<string>,
	theme: any,
	replies: Record<string, number> = {},
): string[] {
	const rows = stripLines();
	const dim = (x: string) => (theme ? theme.fg("dim", x) : x);
	const accent = (x: string) => (theme ? theme.fg("accent", x) : x);
	const bold = (x: string) => (theme && theme.bold ? theme.bold(x) : x);

	const newest = msgs[msgs.length - 1];
	const hint = "/toragents-panel";
	const summary = statusSummary(msgs, seen, replies);
	const head =
		" toragents" + (summary ? accent(` · ${summary}`) : "") + (newest ? "" : dim(" · nothing yet"));
	const pad = Math.max(1, width - plainWidth(head) - hint.length - 1);
	const out: string[] = [truncateToWidth(head + " ".repeat(pad) + dim(hint), width, "")];

	if (!newest) {
		out.push(dim(" no messages on this side yet"));
		while (out.length < rows) out.push("");
		return out.slice(0, rows);
	}

	const claimed = claimBody(newest.body, Math.max(12, width - 4));
	const when = new Date(newest.at).toTimeString().slice(0, 5);
	const arrow = newest.dir === "out" ? "→" : "←";
	out.push(truncateToWidth(` ${accent(arrow)} ${newest.peer} ${dim(when)} ${bold(claimed.subject)}`, width, ""));

	const preview = claimed.rest
		.split(/\n+/)
		.map((l) => l.trim())
		.filter(Boolean)
		.join(" ");
	for (const line of wrapBlock(preview, Math.max(12, width - 2))) {
		if (out.length >= rows) break;
		out.push(truncateToWidth(` ${dim(line)}`, width, ""));
	}
	while (out.length < rows) out.push("");
	return out.slice(0, rows);
}

/** Visible width without ANSI — used to right-align the hint. */
function plainWidth(text: string): number {
	return String(text).replace(/\x1b\[[0-9;]*m/g, "").length;
}

// ── extension ────────────────────────────────────────────────────────────────

/**
 * The live column, kept on globalThis.
 *
 * `/reload` re-evaluates this module: the new instance starts with `column = null`
 * while the previous instance's SideColumn is still patching `terminal.columns`
 * and painting stale rows. Without this handle, reload leaves two overlapping
 * columns and a doubly-narrowed chat. One global, one column.
 */
const LIVE = "__toragentsPanelLive";

export default function (pi: ExtensionAPI) {
	const prev = (globalThis as any)[LIVE];
	if (prev?.dispose) {
		try {
			prev.dispose();
		} catch {}
	}
	(globalThis as any)[LIVE] = undefined;

	let column: SideColumn | null = null;
	let tui: any = null;
	let theme: any = null;
	let msgs: Said[] = [];
	let sig = threadSignature();
	let timer: ReturnType<typeof setInterval> | null = null;
	let lastCtx: ExtensionContext | null = null;
	let unsubscribeInput: (() => void) | null = null;

	const view: ColumnView = {
		selected: 0,
		expanded: new Set<string>(),
		seen: new Set<string>(),
		focused: false,
		top: 0,
	};

	const pageSize = () => Math.max(3, Number(tui?.terminal?.rows || 30) - 4);

	const repaint = () => {
		if (!column?.mounted) return;
		column.invalidate();
		try {
			tui?.requestRender?.();
		} catch {
			/* renderer gone */
		}
	};

	/**
	 * Bring the selected card into view, scrolling as little as possible.
	 *
	 * Two rules, because one does not cover both shapes:
	 *   - a card that FITS scrolls minimally, so the list does not jump when you
	 *     step through it;
	 *   - a card TALLER than the window aligns to its header, because otherwise
	 *     "follow the end" leaves you looking at the tail of a body with no idea
	 *     which message you are in.
	 */
	const revealSelection = () => {
		if (!column?.mounted) return;
		const rows = Number(tui?.terminal?.rows || 30);
		const width = column?.width ?? columnWidth(Number(tui?.terminal?.columns || 0));
		const height = Math.max(3, rows - 2);
		const layout = renderColumn(msgs, width, rows, view, theme, facts(), repliesByPeer(msgs, facts().sentByPeer));
		const s = layout.starts[view.selected];
		const e = layout.ends[view.selected];
		if (s === undefined || e === undefined) return;
		const cardHeight = e - s + 1;
		if (cardHeight > height) {
			view.top = Math.max(0, layout.absolute[view.selected] ?? 0);
			return;
		}
		if (s < 0) view.top = Math.max(0, view.top + s);
		else if (e > height - 1) view.top = Math.max(0, view.top + (e - (height - 1)));
	};

	const markSeen = (i: number) => {
		const m = msgs[i];
		if (m) view.seen.add(keyOf(m));
	};

	const select = (i: number) => {
		if (msgs.length === 0) return;
		view.selected = Math.max(0, Math.min(msgs.length - 1, i));
		markSeen(view.selected);
		revealSelection();
		repaint();
	};

	const toggle = (i: number) => {
		const m = msgs[i];
		if (!m) return;
		const k = keyOf(m);
		if (view.expanded.has(k)) view.expanded.delete(k);
		else view.expanded.add(k);
		view.seen.add(k);
		revealSelection();
		repaint();
	};

	const scrollLines = (n: number) => {
		view.top = Math.max(0, view.top + n);
		repaint();
	};

	const refresh = () => {
		const next = threadSignature();
		if (next === sig) return false;
		sig = next;
		const before = msgs.length;
		const oldKey = msgs[view.selected] ? keyOf(msgs[view.selected]) : "";
		msgs = readThread();
		writeSnapshot(msgs);
		// Follow the conversation: a new message selects itself unless the reader
		// has deliberately parked the marker on an older one.
		if (msgs.length > before) {
			const parked = view.selected < before - 1;
			if (!parked) {
				// Follow the conversation but leave it unread: the dot is the only
				// thing that tells you mail arrived while you were reading.
				view.selected = msgs.length - 1;
				revealSelection();
			}
		} else if (oldKey) {
			const idx = msgs.findIndex((m) => keyOf(m) === oldKey);
			if (idx >= 0) view.selected = idx;
		}
		repaint();
		return true;
	};

	const mountColumn = (ctx: ExtensionContext): { ok: boolean; why: string } => {
		if (column?.mounted) return { ok: true, why: "already open" };
		if (!ctx?.ui?.setWidget) return { ok: false, why: "this session has no interactive UI" };
		msgs = readThread();
		sig = threadSignature();
		writeSnapshot(msgs);
		view.selected = Math.max(0, msgs.length - 1);
		// Existing mail is history, not a notification: start with everything
		// marked read except the newest message, which is what you came to see.
		view.seen = new Set(msgs.map(keyOf));
		// Collapsed, like a mail list: a 3k-character letter that opens itself
		// fills the whole column and hides every other message.
		view.expanded = new Set<string>();
		view.top = 0;
		let result: { ok: boolean; why: string } = {
			ok: typeof ctx.ui.setWidget === "function",
			why: "mounted",
		};
		ctx.ui.setWidget(
			"toragents-panel-mount",
			(t: any, th: any) => {
				tui = t;
				theme = th;
				if (!column) {
					column = new SideColumn(t, {
						width: columnWidth(Number(t?.terminal?.columns || 0)),
						minTerminalWidth: MIN_TERMINAL,
						render: (w, r) =>
					renderColumn(msgs, w, r, view, theme, facts(), repliesByPeer(msgs, facts().sentByPeer)).lines,
						onWheel: (delta) => {
							scrollLines(delta * 3);
							return true;
						},
						onResizeCommit: (w) => {
							// The width is a decision, so it is written once, on release --
							// not per motion event, which would rewrite the file sixty times
							// during one drag.
							if (!writePanelWidth(w)) {
								try {
									ctx.ui.notify("toragents: resized, but could not save it (policy.json)", "warning");
								} catch {}
							}
							revealSelection();
						},
					});
				}
				result = column.install();
				if (result.ok) (globalThis as any)[LIVE] = column;
				else {
					try {
						ctx.ui.notify(`toragents: right column not shown — ${result.why}`, "warning");
					} catch {}
				}
				revealSelection();
				column.repaint();
				// pi calls dispose() on every extension widget it tears down (reload,
				// setWidget(undefined), clearExtensionWidgets). Hook it, or the
				// unpainted column keeps patching terminal.columns after teardown.
				return {
					render: () => [] as string[],
					invalidate() {},
					dispose: () => {
						try {
							(globalThis as any)[LIVE] = undefined;
						} catch {}
						try {
							column?.dispose();
						} catch {}
						column = null;
					},
				};
			},
			{ placement: "belowEditor" },
		);
		return result;
	};

	const unmountColumn = (ctx?: ExtensionContext): string => {
		try {
			(globalThis as any)[LIVE] = undefined;
		} catch {}
		try {
			column?.dispose();
		} catch {}
		column = null;
		try {
			(ctx || lastCtx)?.ui?.setWidget("toragents-panel-mount", undefined);
		} catch {}
		try {
			tui?.requestRender?.();
		} catch {}
		view.focused = false;
		return "conversation column closed";
	};

	let stripOn = false;

	/** Bottom strip for sessions that are not the front desk. */
	const mountStrip = (ctx: ExtensionContext): { ok: boolean; why: string } => {
		if (column?.mounted) unmountColumn(ctx);
		if (typeof ctx?.ui?.setWidget !== "function") return { ok: false, why: "this session has no interactive UI" };
		msgs = readThread();
		sig = threadSignature();
		if (view.seen.size === 0) view.seen = new Set(msgs.map(keyOf));
		writeSnapshot(msgs);
		stripOn = true;
		ctx.ui.setWidget(
			"toragents-panel-strip",
			(t: any, th: any) => {
				tui = t;
				theme = th;
				return {
					render: () =>
						renderStrip(
							msgs,
							Number(t?.terminal?.columns || 80),
							view.seen,
							theme,
							repliesByPeer(msgs, facts().sentByPeer),
						),
					invalidate() {},
					dispose: () => {
						stripOn = false;
					},
				};
			},
			{ placement: "belowEditor" },
		);
		return { ok: true, why: `bottom strip, ${stripLines()} lines (panel v${PANEL_VERSION})` };
	};

	const unmountStrip = (ctx?: ExtensionContext): string => {
		stripOn = false;
		try {
			(ctx || lastCtx)?.ui?.setWidget("toragents-panel-strip", undefined);
		} catch {}
		try {
			tui?.requestRender?.();
		} catch {}
		return "strip closed";
	};

	/** Apply a mode: the wide column, the bottom strip, or nothing. */
	const applyMode = (mode: "column" | "strip" | "off", ctx: ExtensionContext): { ok: boolean; why: string } => {
		if (mode === "off") {
			unmountColumn(ctx);
			unmountStrip(ctx);
			return { ok: true, why: "panel off" };
		}
		if (mode === "strip") return mountStrip(ctx);
		unmountStrip(ctx);
		return mountColumn(ctx);
	};

	/**
	 * Keyboard. Focus is the switch: unfocused, only alt-modified keys are taken,
	 * so typing in the editor is never disturbed. Focused, the column behaves like
	 * a mail list (j/k/enter), and Esc gives the keyboard straight back.
	 */
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		unsubscribeInput?.();
		try {
			unsubscribeInput = ctx.ui.onTerminalInput((data: string) => {
				if (!column?.mounted) return undefined;
				const f = view.focused;
				const taken = () => {
					try {
						tui?.requestRender?.();
					} catch {}
					return { consume: true };
				};

				if (matchesKey(data, Key.alt("f"))) {
					view.focused = !view.focused;
					const m = msgs[view.selected];
					if (m) view.seen.add(keyOf(m));
					repaint();
					return taken();
				}
				if (view.focused && (matchesKey(data, Key.escape) || data === "q")) {
					view.focused = false;
					repaint();
					return taken();
				}

				// movement: alt+j/k always; plain j/k only while focused
				if (matchesKey(data, Key.alt("j")) || matchesKey(data, Key.alt(Key.down)) || (f && (matchesKey(data, Key.down) || data === "j"))) {
					select(view.selected + 1);
					return taken();
				}
				if (matchesKey(data, Key.alt("k")) || matchesKey(data, Key.alt(Key.up)) || (f && (matchesKey(data, Key.up) || data === "k"))) {
					select(view.selected - 1);
					return taken();
				}
				// open / close: alt+e always; enter/space while focused
				if (matchesKey(data, Key.alt("e")) || (f && (matchesKey(data, Key.enter) || data === " "))) {
					toggle(view.selected);
					return taken();
				}
				if (matchesKey(data, Key.alt("a")) || (f && data === "a")) {
					view.expanded = new Set(msgs.map(keyOf));
					repaint();
					return taken();
				}
				if (matchesKey(data, Key.alt("c")) || (f && data === "c")) {
					view.expanded.clear();
					repaint();
					return taken();
				}
				// ends of the list
				if (matchesKey(data, Key.alt("g")) || (f && data === "G")) {
					if (msgs.length > 0) {
						view.selected = msgs.length - 1;
						view.seen.add(keyOf(msgs[view.selected]));
					}
					revealSelection();
					repaint();
					return taken();
				}
				if (matchesKey(data, Key.alt("t")) || (f && data === "g")) {
					if (msgs.length > 0) {
						view.selected = 0;
						view.seen.add(keyOf(msgs[view.selected]));
					}
					revealSelection();
					repaint();
					return taken();
				}
				// Divider width: the keyboard twin of dragging the edge. Fullscreen
				// mouse input is not universal -- SSH, multiplexers and terminals that
				// never send motion would make a mouse-only resize a feature half the
				// sessions cannot use.
				if (column?.mounted && (matchesKey(data, Key.alt("[")) || matchesKey(data, Key.alt("]")))) {
					const rawCols = Number(tui?.terminal?.columns || 0) + column.width + 1;
					const delta = matchesKey(data, Key.alt("[")) ? -2 : 2;
					const next = clampColumnWidth(column.width + delta, rawCols);
					column.setWidth(next);
					writePanelWidth(next);
					revealSelection();
					repaint();
					return taken();
				}
				if (column?.mounted && matchesKey(data, Key.alt("\\"))) {
					// Reset forgets the dragged width instead of freezing today's
					// proportional value as if it were a choice.
					writePanelWidth(0);
					const rawCols = Number(tui?.terminal?.columns || 0) + column.width + 1;
					column.setWidth(clampColumnWidth(Math.round(rawCols * 0.36), rawCols));
					revealSelection();
					repaint();
					return taken();
				}

				// page scrolling only while focused (plain pgup/pgdn belong to the
				// chat transcript otherwise)
				if (f && matchesKey(data, Key.pageUp)) {
					scrollLines(-pageSize());
					return taken();
				}
				if (f && matchesKey(data, Key.pageDown)) {
					scrollLines(pageSize());
					return taken();
				}
				return undefined;
			});
		} catch {
			/* no raw input this mode; commands still work */
		}

		// A reload must not stack a second column on top of the old one.
		if ((globalThis as any)[LIVE] === undefined) {
			try {
				ctx.ui.setWidget("toragents-panel-mount", undefined);
			} catch {}
		}
		// Placement follows policy: the designated receiver gets the wide column,
		// every other chat gets a few lines at the bottom. TORAGENTS_PANEL overrides.
		let me: string | undefined;
		try {
			me = pi.getSessionName?.();
		} catch {}
		const mode = panelMode(me);
		const r = applyMode(mode, ctx);
		if (!r.ok) {
			try {
				ctx.ui.notify(`toragents: panel not shown — ${r.why}`, "info");
			} catch {}
		}

		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			try {
				if (stripOn && threadSignature() !== sig) {
					sig = threadSignature();
					const before = new Set(view.seen);
					msgs = readThread();
					// The strip marks nothing read: it is a notification. Opening the
					// column is what counts as reading.
					view.seen = new Set([...before]);
					writeSnapshot(msgs);
					try {
						tui?.requestRender?.();
					} catch {}
					return;
				}
				refresh();
			} catch {
				/* never break the session over a repaint */
			}
		}, POLL_MS);
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = null;
		try {
			unsubscribeInput?.();
		} catch {}
		unsubscribeInput = null;
		try {
			column?.dispose();
		} catch {}
		column = null;
		try {
			lastCtx?.ui?.setWidget("toragents-panel-strip", undefined);
		} catch {}
	});

	pi.registerCommand("toragents-panel", {
		description: "Open the conversation column in this session, or close it back to the strip",
		handler: async (_args: any, ctx: any) => {
			lastCtx = ctx;
			if (column?.mounted) {
				let me: string | undefined;
				try {
					me = pi.getSessionName?.();
				} catch {}
				const back = panelMode(me, { ...readPolicy(), panel: { default: "strip", column: [] } });
				const r = applyMode(back === "off" ? "off" : "strip", ctx);
				try {
					ctx.ui.notify(`toragents: column closed — ${r.why}`, "info");
				} catch {}
				return;
			}
			const r = mountColumn(ctx);
			try {
				ctx.ui.notify(
					`toragents: ${r.why}` + (r.ok ? " — alt+f focuses it; j/k/enter move and open" : ""),
					r.ok ? "info" : "warning",
				);
			} catch {}
		},
	});

	pi.registerCommand("toragents-scroll", {
		description: "Scroll the Tor column: up, down, top, bottom, or a number of lines",
		handler: async (args: any, ctx: any) => {
			lastCtx = ctx;
			const arg = String(args ?? "").trim().toLowerCase();
			if (!column?.mounted) {
				try {
					ctx.ui.notify("toragents: the column is closed — /toragents-panel opens it", "warning");
				} catch {}
				return;
			}
			const n = Number(arg);
			if (arg === "top") {
				view.selected = 0;
				revealSelection();
				repaint();
			} else if (arg === "bottom" || arg === "") {
				if (msgs.length > 0) view.selected = msgs.length - 1;
				revealSelection();
				repaint();
			} else if (Number.isFinite(n) && n !== 0) scrollLines(-n);
			try {
				ctx.ui.notify(`toragents: column scrolled (${arg || "bottom"})`, "info");
			} catch {}
		},
	});
}
