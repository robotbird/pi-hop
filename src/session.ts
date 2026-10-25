/**
 * pi-hop session handling.
 *
 * On the receiving side, incoming session files land in a fixed inbox:
 *   ~/.pi/agent/sessions/pi-hop/inbox/<original-name>.jsonl
 *
 * `/hop resume` "adopts" an inbox file with SessionManager.forkFrom(), which is
 * Pi's own mechanism for opening a session from another project directory:
 * every non-header entry is copied verbatim (messages, tool calls, branches,
 * compaction, labels…) while a fresh header is written with a new session id
 * and the *local* working directory. Nothing in the conversation history is
 * re-generated or summarized, so the transferred session continues seamlessly.
 *
 * The inbox original is then archived to inbox/imported/ (copy-based migration:
 * the source machine keeps its own history; the two copies diverge freely).
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export const LOCAL_HOP_DIR = join(homedir(), ".pi", "agent", "sessions", "pi-hop");
export const LOCAL_INBOX_DIR = join(LOCAL_HOP_DIR, "inbox");
export const LOCAL_IMPORTED_DIR = join(LOCAL_INBOX_DIR, "imported");
export const TARGETS_FILE = join(LOCAL_HOP_DIR, "targets.json");

export interface InboxItem {
	path: string;
	file: string;
	size: number;
	mtimeMs: number;
	/** Session id from the header. */
	id: string;
	/** Working directory recorded on the source machine. */
	sourceCwd: string;
	version: number;
	/** Non-header entry count (messages, compactions, branches…). */
	entries: number;
	/** Display name set via /name on the source, if any. */
	sessionName?: string;
	/** First user message text, useful as a fallback title. */
	firstMessage?: string;
}

export interface InboxListing {
	items: InboxItem[];
	/** Files that exist but could not be parsed. */
	broken: string[];
}

interface ParsedHeader {
	type: string;
	version?: number;
	id?: string;
	cwd?: string;
}

function parseInboxItem(path: string): InboxItem {
	const text = readFileSync(path, "utf8");
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) throw new Error("empty file");

	let header: Partial<ParsedHeader> = {};
	try {
		header = JSON.parse(lines[0]) as ParsedHeader;
	} catch {
		throw new Error("no JSON header on line 1");
	}
	if (header.type !== "session") throw new Error("first line is not a session header");
	let sessionName: string | undefined;
	let firstMessage: string | undefined;
	for (const line of lines) {
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
			sessionName = entry.name.trim();
		}
		if (firstMessage === undefined && entry?.type === "message" && entry.message?.role === "user") {
			const content = entry.message.content;
			let text = "";
			if (typeof content === "string") text = content;
			else if (Array.isArray(content)) {
				text = content
					.filter((c: any) => c?.type === "text" && typeof c.text === "string")
					.map((c: any) => c.text)
					.join(" ");
			}
			text = text.replace(/\s+/g, " ").trim();
			if (text) firstMessage = text.length > 90 ? `${text.slice(0, 90)}…` : text;
		}
		if (sessionName && firstMessage !== undefined) break;
	}

	const stats = statSync(path);
	return {
		path,
		file: basename(path),
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		id: header.id ?? "?",
		sourceCwd: header.cwd ?? "(unknown)",
		version: header.version ?? 1,
		entries: Math.max(0, lines.length - 1),
		sessionName,
		firstMessage,
	};
}

function listJsonl(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => join(dir, f));
}

/** Inbox files = inbox/*.jsonl plus loose *.jsonl dropped directly in pi-hop/. */
export function listInbox(): InboxListing {
	const seen = new Set<string>();
	const paths = [...listJsonl(LOCAL_INBOX_DIR), ...listJsonl(LOCAL_HOP_DIR)].filter((p) => {
		if (seen.has(p)) return false;
		seen.add(p);
		return true;
	});
	const items: InboxItem[] = [];
	const broken: string[] = [];
	for (const p of paths) {
		try {
			items.push(parseInboxItem(p));
		} catch (err) {
			broken.push(`${basename(p)}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	items.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return { items, broken };
}

/** Adopt a received session into `cwd` and archive the inbox original. */
export function adoptSession(item: InboxItem, cwd: string): string {
	return adoptPath(item.path, cwd);
}

/**
 * Headless adoption by file path — the entry point for the `/hop-auto adopt`
 * command used by `--run` automation. Validates the file, copies it into the
 * default session dir for `cwd` via SessionManager.forkFrom, then archives the
 * inbox original. Returns the adopted session file path.
 */
export function adoptPath(path: string, cwd: string): string {
	parseInboxItem(path); // validation: throws a descriptive error for junk input
	const manager = SessionManager.forkFrom(path, cwd);
	const adoptedPath = manager.getSessionFile();
	if (!adoptedPath) throw new Error("adoption produced no session file");
	archiveInboxFile(path);
	return adoptedPath;
}

/** Move an inbox file to inbox/imported/ without ever overwriting. */
export function archiveInboxFile(path: string): string | null {
	try {
		if (!existsSync(path)) return null;
		mkdirSync(LOCAL_IMPORTED_DIR, { recursive: true });
		const name = basename(path);
		let dest = join(LOCAL_IMPORTED_DIR, name);
		let n = 1;
		while (existsSync(dest)) {
			dest = join(LOCAL_IMPORTED_DIR, `${name.replace(/\.jsonl$/, "")}-${n}.jsonl`);
			n += 1;
		}
		renameSync(path, dest);
		return dest;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Recent targets (~/.pi/agent/sessions/pi-hop/targets.json)
// ---------------------------------------------------------------------------

export interface HopTarget {
	target: string;
	lastUsed: string;
	uses: number;
}

const MAX_TARGETS = 10;

export function loadTargets(): HopTarget[] {
	try {
		const parsed = JSON.parse(readFileSync(TARGETS_FILE, "utf8")) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((t): t is HopTarget => !!t && typeof (t as HopTarget).target === "string")
			.sort((a, b) => (a.lastUsed < b.lastUsed ? 1 : -1));
	} catch {
		return [];
	}
}

export function rememberTarget(label: string): void {
	try {
		mkdirSync(LOCAL_HOP_DIR, { recursive: true });
		const targets = loadTargets();
		const now = new Date().toISOString();
		const existing = targets.find((t) => t.target === label);
		const next = [
			{ target: label, lastUsed: now, uses: (existing?.uses ?? 0) + 1 },
			...targets.filter((t) => t.target !== label),
		].slice(0, MAX_TARGETS);
		writeFileSync(TARGETS_FILE, `${JSON.stringify(next, null, 2)}\n`);
	} catch {
		// Target memory is a convenience; never fail a transfer over it.
	}
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function lastPathSegment(p: string): string {
	const parts = p.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? p;
}

/** Read just the header of a session file (cheap; no entry scan). */
export function readHeaderCwd(path: string): string | undefined {
	try {
		const first = readFileSync(path, "utf8").split("\n")[0];
		const header = JSON.parse(first ?? "") as ParsedHeader;
		return header.type === "session" ? header.cwd : undefined;
	} catch {
		return undefined;
	}
}

export function describeInboxItem(item: InboxItem): string {
	const title = item.sessionName ?? item.firstMessage ?? "(untitled)";
	return `${title} — ${lastPathSegment(item.sourceCwd)} · ${item.entries} entries · ${formatBytes(item.size)} · ${new Date(item.mtimeMs).toLocaleString()}`;
}
