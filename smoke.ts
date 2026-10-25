/**
 * pi-hop smoke test (run: node smoke.ts)
 * Exercises parseTarget, sha256File, inbox parsing and session adoption
 * against a synthetic session file — no real SSH transfer involved.
 */
import { mkdirSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseTarget, sha256File, TransportError, probe } from "./src/transfer.ts";
import { listInbox, adoptSession, LOCAL_INBOX_DIR, LOCAL_IMPORTED_DIR } from "./src/session.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
	console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : " " + extra}`);
	if (!cond) failures += 1;
}

// --- parseTarget -----------------------------------------------------------
const t1 = parseTarget("ubuntu@192.168.1.105");
check("parseTarget user@host", t1?.user === "ubuntu" && t1?.host === "192.168.1.105" && t1?.label === "ubuntu@192.168.1.105");
const t2 = parseTarget("devbox.local");
check("parseTarget host only", t2?.user === undefined && t2?.host === "devbox.local");
check("parseTarget rejects spaces", parseTarget("a b@c") === null);
check("parseTarget rejects empty", parseTarget("") === null);
check("parseTarget rejects user@", parseTarget("user@") === null);

// --- sha256File ------------------------------------------------------------
const testFile = "/tmp/pi-hop-smoke.jsonl";
const content = '{"type":"session","version":3,"id":"smoke-0001","timestamp":"2025-10-24T12:00:00.000Z","cwd":"/Users/robotbird/Work/yepeng/works/pi-hop"}\n' + [
	{ type: "session_info", id: "aaa", parentId: null, timestamp: "2025-10-24T12:00:01.000Z", name: "Smoke test session" },
	{ type: "message", id: "bbb", parentId: null, timestamp: "2025-10-24T12:00:02.000Z", message: { role: "user", content: "Hello from the smoke test, please remember the magic word: durian.", timestamp: 1 } },
	{ type: "message", id: "ccc", parentId: "bbb", timestamp: "2025-10-24T12:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "Noted (durian)." }], timestamp: 2 } },
	{ type: "message", id: "ddd", parentId: "ccc", timestamp: "2025-10-24T12:00:04.000Z", message: { role: "user", content: "Second message on a branch point.", timestamp: 3 } },
	{ type: "compaction", id: "eee", parentId: "ddd", timestamp: "2025-10-24T12:00:05.000Z", summary: "compacted", firstKeptEntryId: "ddd", tokensBefore: 1234 },
].map((e) => JSON.stringify(e)).join("\n") + "\n";

mkdirSync(LOCAL_INBOX_DIR, { recursive: true });
const inboxFile = `${LOCAL_INBOX_DIR}/smoke-test-session.jsonl`;
import { writeFileSync } from "node:fs";
writeFileSync(inboxFile, content);
writeFileSync(testFile, content);

const expectedHash = createHash("sha256").update(content).digest("hex");
const actualHash = await sha256File(testFile);
check("sha256File matches node crypto", actualHash === expectedHash);

// --- inbox listing ----------------------------------------------------------
const listing = listInbox();
const item = listing.items.find((i) => i.file === "smoke-test-session.jsonl");
check("inbox lists the session", !!item, JSON.stringify(listing));
check("inbox parses session name", item?.sessionName === "Smoke test session");
check("inbox parses first user message", item?.firstMessage?.includes("durian") === true);
check("inbox counts entries", item?.entries === 5, `entries=${item?.entries}`);
check("inbox reads source cwd", item?.sourceCwd === "/Users/robotbird/Work/yepeng/works/pi-hop");
check("inbox reads header id", item?.id === "smoke-0001");

// --- adoption via SessionManager.forkFrom -----------------------------------
const targetCwd = "/tmp/pi-hop-smoke-cwd";
mkdirSync(targetCwd, { recursive: true });
const adoptedPath = adoptSession(item!, targetCwd);
check("adoption produced a session file", !!adoptedPath && existsSync(adoptedPath), adoptedPath);
const adoptedText = readFileSync(adoptedPath!, "utf8").trim().split("\n");
const adoptedHeader = JSON.parse(adoptedText[0]!);
check("adopted header has new id", typeof adoptedHeader.id === "string" && adoptedHeader.id !== "smoke-0001");
check("adopted header cwd remapped", adoptedHeader.cwd === targetCwd, adoptedHeader.cwd);
check("adopted header version 3", adoptedHeader.version === 3);
check("adopted entry count preserved", adoptedText.length - 1 === 5, `lines=${adoptedText.length}`);
const compactionKept = adoptedText.some((l) => l.includes('"compaction"') && l.includes("firstKeptEntryId"));
check("compaction entry preserved verbatim", compactionKept);
const userInfoKept = adoptedText.some((l) => l.includes("durian"));
check("user message preserved verbatim", userInfoKept);

// --- inbox original archived -------------------------------------------------
check("inbox original archived", !existsSync(inboxFile) && existsSync(`${LOCAL_IMPORTED_DIR}/smoke-test-session.jsonl`));

// --- probe failure classification (no real server needed) --------------------
try {
	await probe({ host: "pi-hop-nonexistent.invalid", label: "pi-hop-nonexistent.invalid" });
	check("probe to invalid host should fail", false);
} catch (err) {
	check(
		"probe to invalid host fails with network/unknown TransportError",
		err instanceof TransportError && (err.kind === "network" || err.kind === "unknown"),
		err instanceof TransportError ? `${err.kind}: ${err.message}` : String(err),
	);
}

// --- cleanup ------------------------------------------------------------------
rmSync(testFile, { force: true });
rmSync(`${LOCAL_IMPORTED_DIR}/smoke-test-session.jsonl`, { force: true });
rmSync(targetCwd, { recursive: true, force: true });
const adoptedDir = adoptedPath!.split("/").slice(0, -1).join("/");
rmSync(adoptedDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
