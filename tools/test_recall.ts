// Announced, never shown -- the cell that used to be permanent.
//
// A peer's box was found holding three letters in exactly this state: in
// announced.json, no claim file, no transcript row, bodies intact, 28 hours old.
// The startup reconciler healed only the other direction (claim without
// announced), and the tick skips anything announced, so nothing could ever
// reconsider them. These checks assert both halves of the repair: the write that
// made it permanent is gone, and an id already announced is delivered once if no
// row proves it was shown.
//
// Run with: bun tools/test_recall.ts
const H = process.env.TORAGENTS_TEST_HOME || "/tmp/toragents-recall-test";
process.env.TORAGENTS_HOME = H;
const INBOX = H + "/state/inbox";

const { writeFileSync, readFileSync, mkdirSync, rmSync } = await import("node:fs");
rmSync(H + "/state", { recursive: true, force: true });
mkdirSync(INBOX, { recursive: true });
mkdirSync(H + "/state/claimed", { recursive: true });

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
	console.log(`  ${name} ${ok ? "PASS" : "FAIL"}${detail ? ` (${detail})` : ""}`);
	ok ? pass++ : fail++;
};

const STATE = H + "/state";
const put = (id: string, body: string, received: number) =>
	writeFileSync(
		`${INBOX}/${received}-${id}.json`,
		JSON.stringify({ id, body, from_label: "rowan", received }),
	);

// three bodies; two of them announced, only one of those ever rendered
put("dead1", "this one was announced and forgotten", 1000);
put("fine1", "this one was announced and shown", 1001);
writeFileSync(`${STATE}/announced.json`, JSON.stringify(["dead1", "fine1"]));
// fine1 was delivered: it has a claim AND a transcript row
writeFileSync(`${STATE}/claimed/fine1`, `test-session ${Date.now()}\n`);
writeFileSync(
	`${STATE}/chat.jsonl`,
	JSON.stringify({ at: Date.now(), dir: "in", peer: "rowan", id: "fine1", body: "this one was announced and shown" }) + "\n",
);

let tick: (() => void) | null = null;
(globalThis as any).setInterval = (fn: any) => {
	tick = fn;
	return 1;
};
(globalThis as any).clearInterval = () => {};

const sent: { text: string }[] = [];
const notes: string[] = [];
const handlers: Record<string, any> = { commands: {} };
const fakePi: any = {
	on: (ev: string, fn: Function) => {
		handlers[ev] = fn;
	},
	registerCommand: (n: string, o: any) => {
		handlers.commands[n] = o;
	},
	sendUserMessage: async (text: string) => {
		sent.push({ text });
	},
};
const ctx: any = { isIdle: () => true, ui: { notify: (m: string) => notes.push(m) } };

const mod = await import("../toragents_watch.ts");
mod.default(fakePi);
const settle = () => new Promise((r) => setTimeout(r, 60));

await handlers.session_start({}, ctx);
await settle();

// 1. the notice names what was found, rather than healing silently
check(
	"a startup recall says how many it found",
	notes.some((n) => n.includes("1 message(s) were announced but never shown")),
	JSON.stringify(notes),
);

// 2. the lost one is delivered, the shown one is not
tick!();
await settle();
const text = sent.map((s) => s.text).join("\n");
check("the announced-but-unshown letter is delivered", text.includes("this one was announced and forgotten"), `delivered=${sent.length}`);
check("the one with a transcript row is not shown twice", !text.includes("this one was announced and shown"));
check("it arrives as itself, not as a duplicate of another", sent.length === 1);

// 3. and only once: the row is the proof, so the next start has nothing to recall
tick!();
await settle();
check("a second tick does not repeat it", sent.length === 1);
{
	const rows = readFileSync(`${STATE}/chat.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	check(
		"the transcript now records it, which is what stops the recall",
		rows.some((r: any) => r.id === "dead1" && r.dir === "in"),
		`rows=${rows.length}`,
	);
}

// 4. the recall is derived from the disk every start, not remembered in memory
await handlers.session_start({}, ctx);
await settle();
tick!();
await settle();
check("a restarted window recalls nothing once the row exists", sent.length === 1);

// 5. the ordering that created the cell: nothing writes announced.json before the render
{
	const src = readFileSync(new URL("../toragents_watch.ts", import.meta.url), "utf8");
	const from = src.indexOf("const heldBack = fresh.length - mine.length;");
	const to = src.indexOf("await deliver(ctx, mine, heldBack);", from);
	const between = from >= 0 && to > from ? src.slice(from, to) : "MISSING";
	check(
		"announced.json is not written before deliver()",
		from >= 0 && to > from && !between.includes("writeAnnounced("),
	);
}

// 6. a peer's three dead letters would be recovered: bounded, and only with a body
{
	rmSync(H + "/state", { recursive: true, force: true });
	mkdirSync(INBOX, { recursive: true });
	mkdirSync(H + "/state/claimed", { recursive: true });
	for (let i = 0; i < 3; i++) put(`late${i}`, `late letter ${i}`, 2000 + i);
	writeFileSync(`${STATE}/announced.json`, JSON.stringify(["late0", "late1", "late2", "gone-body"]));
	const mod2 = await import(`../toragents_watch.ts?fresh=${Date.now()}`);
	const sent2: string[] = [];
	mod2.default({
		on: (ev: string, fn: Function) => {
			handlers[ev] = fn;
		},
		registerCommand: (n: string, o: any) => {
			handlers.commands[n] = o;
		},
		sendUserMessage: async (t: string) => {
			sent2.push(t);
		},
	} as any);
	await handlers.session_start({}, ctx);
	await settle();
	tick!();
	await settle();
	// one sendUserMessage carries the batch, joined by the separator: count bodies, not calls.
	const batch = sent2.join("\n");
	check(
		"three lost letters come back in one batch",
		(batch.match(/late letter \d/g) || []).length === 3,
		`calls=${sent2.length} bodies=${(batch.match(/late letter \d/g) || []).length}`,
	);
	check("an announced id with no body on disk is not invented", !sent2.join("\n").includes("gone-body"));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
