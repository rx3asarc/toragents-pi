/**
 * The transcript must show what was SAID and nothing else: one line per
 * direction, newest last, and no entry for anything that never crossed the wire.
 */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "toragents-chat-"));
process.env.TORAGENTS_HOME = HOME;
process.env.TORAGENTS_STATE = join(HOME, "state");
process.env.PI_SESSION_ID = "cccccccc-1111-2222-3333-444444444444";
const STATE = process.env.TORAGENTS_STATE;
import { mkdirSync } from "node:fs";
mkdirSync(STATE, { recursive: true });

const t0 = 1792340000000;
const rows = [
	{ at: t0, dir: "out", peer: "maestro-pc", id: "a1", body: "first thing sent" },
	{ at: t0 + 60000, dir: "in", peer: "maestro-pc", id: "b2", body: "their answer" },
	{ at: t0 + 120000, dir: "out", peer: "maestro-pc", id: "c3", body: "second thing sent" },
];
writeFileSync(join(STATE, "chat.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const mod: any = await import(join(process.cwd(), "toragents_watch.ts"));
const lines = mod.renderChat(56) as string[];
const text = lines.join("\n");

const checks: Array<[string, boolean]> = [
	["shows outgoing with an arrow out", text.includes("→ maestro-pc")],
	["shows incoming with an arrow in", text.includes("← maestro-pc")],
	["shows the words, not the ids", text.includes("first thing sent") && !text.includes("a1 ")],
	["order preserved, newest last",
		text.indexOf("first thing sent") < text.indexOf("their answer") &&
		text.indexOf("their answer") < text.indexOf("second thing sent")],
	["no thinking or tool chatter in the transcript",
		!/tool|thinking|bash/i.test(text)],
	["empty transcript says so instead of rendering nothing",
		(() => { writeFileSync(join(STATE, "chat.jsonl"), ""); return (mod.renderChat() as string[]).join("").includes("no messages yet"); })()],
];
// peerTone: the register must be findable by label and absent when unset --
// a null answer must not read as "no tone configured" vs "peers unreadable".
writeFileSync(
	join(STATE, "peers.json"),
	JSON.stringify({
		aa11: { label: "Kisu", onion: "x.onion", tone: "playful, technical, gentle",
		        styles: ["princess", "praise"] },
		bb22: { label: "someone", onion: "y.onion" },
	}),
);
checks.push(
	["tone found by label, case-insensitively",
		mod.peerTone(STATE, "kisu") === "playful, technical, gentle"],
	["peer without a tone reports empty, not the last tone",
		mod.peerTone(STATE, "someone") === ""],
	["unknown peer reports empty",
		mod.peerTone(STATE, "nobody") === ""],
);

// freshWords: the pool must actually be consulted, and a broken daemon must not
// turn a send into a failure.
//
// The pool is reached by running inbox_agent.py, which imports PyNaCl. When the
// interpreter cannot import it the spawn fails, freshWords returns empty by design
// (a broken daemon must not fail a send), and this check reports "no words" -- the
// right verdict for the wrong reason, with nothing in the output saying so. Say it.
const py = process.env.TORAGENTS_PY || "python3";
{
	const probe = spawnSync(py, ["-c", "import nacl"], { encoding: "utf8" });
	if (probe.status !== 0) {
		console.log(`  note: ${py} cannot import nacl, so the pool check below will fail;`);
		console.log(`        set TORAGENTS_PY to an interpreter that can (CI installs PyNaCl)`);
	}
}
checks.push(
	["fresh words come back from the pool",
		(() => {
			const r = mod.freshWords(
				py,
				join(process.cwd(), "inbox_agent.py"),
				HOME,
				join(STATE, "peers.json"), // any readable file: the body only marks words
			);
			return r.names.length > 0 && r.moves.length > 0;
		})()],
	["a missing daemon yields empty words, not a throw",
		mod.freshWords("python3", "/nonexistent/inbox_agent.py", HOME, "/nonexistent/x").names
			.length === 0],
);

// The register must reach the model BEFORE it composes. A peer read the code and
// found that peerTone() only ran in the send tool, after the body existed -- the
// comment claimed compose-time and nothing implemented it. These checks fail if
// the note stops being built or stops carrying what it promises.
const note = mod.buildRegisterNote(
	STATE,
	["your highness", "hunni"],
	["good girl. signature verified first try."],
);
checks.push(
	["register note names the peer and its tune",
		note.toLowerCase().includes("kisu") && note.includes("playful, technical, gentle")],
	["register note names the decks", note.includes("princess, praise")],
	["register note carries suggested words", note.includes("your highness")],
	["register note says it is advisory, not an instruction",
		/advisory/i.test(note) && /suggestion/i.test(note)],
	["register note is empty when no peer has a tune",
		mod.buildRegisterNote(join(STATE, "does-not-exist")) === ""],
);

const bad = checks.filter(([, ok]) => !ok);
for (const [n, ok] of checks) console.log(`  ${n.padEnd(52)} ${ok ? "PASS" : "FAIL"}`);
console.log(`\n  ${checks.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
