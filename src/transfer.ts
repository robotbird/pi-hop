/**
 * pi-hop transport layer.
 *
 * Uses the system OpenSSH client (ssh/scp) only — no daemons, no servers, no
 * extra ports. The receiving side needs nothing but `pi` plus this extension:
 * incoming sessions land in `~/.pi/agent/sessions/pi-hop/inbox/` on the target.
 *
 * Security posture:
 * - Host key checking is never disabled. First connections are verified
 *   interactively (the TUI suspends so the user sees the fingerprint).
 * - All automated steps run with BatchMode=yes so they fail fast instead of
 *   hanging on a password prompt the TUI cannot render.
 * - Remote paths are relative to the remote home directory, which scp/ssh
 *   resolve server-side; this avoids `~` expansion differences across shells.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";

/** pi-hop storage on the remote host (relative to $HOME). */
export const REMOTE_BASE = ".pi/agent/sessions/pi-hop";
export const REMOTE_INBOX = `${REMOTE_BASE}/inbox`;

export interface SendTarget {
	user?: string;
	host: string;
	/** Canonical "user@host" string used for ssh/scp and for the target list. */
	label: string;
}

export function parseTarget(raw: string): SendTarget | null {
	const s = raw.trim();
	if (!s || /\s/.test(s)) return null;
	const at = s.lastIndexOf("@");
	if (at === -1) return { host: s, label: s };
	const user = s.slice(0, at);
	const host = s.slice(at + 1);
	if (!user || !host) return null;
	return { user, host, label: s };
}

export type TransportErrorKind = "auth" | "hostkey" | "network" | "aborted" | "unknown";

export class TransportError extends Error {
	readonly kind: TransportErrorKind;
	readonly stderr: string;

	constructor(kind: TransportErrorKind, message: string, stderr = "") {
		super(message);
		this.name = "TransportError";
		this.kind = kind;
		this.stderr = stderr;
	}
}

export interface TransferHooks {
	/** Called with a human-readable phase description. */
	onPhase?(text: string): void;
	signal?: AbortSignal;
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function run(cmd: string, args: string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child: ChildProcess = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;

		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			opts?.signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			child.kill("SIGKILL");
			reject(new TransportError("aborted", "Transfer cancelled"));
		};

		child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
		child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new TransportError("unknown", `Failed to run ${cmd}: ${err.message}`));
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({ code, stdout, stderr });
		});

		if (opts.timeoutMs) timeout = setTimeout(onAbort, opts.timeoutMs);
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function baseSshArgs(): string[] {
	return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
}

function classifyFailure(stderr: string): TransportErrorKind {
	const s = stderr.toLowerCase();
	if (s.includes("host key verification failed") || s.includes("no hosted keys in config")) return "hostkey";
	if (
		s.includes("permission denied") ||
		s.includes("publickey") ||
		s.includes("authentication failed") ||
		s.includes("no supported authentication")
	) {
		return "auth";
	}
	if (
		s.includes("could not resolve hostname") ||
		s.includes("connection refused") ||
		s.includes("connection timed out") ||
		s.includes("operation timed out") ||
		s.includes("network is unreachable") ||
		s.includes("connection reset")
	) {
		return "network";
	}
	return "unknown";
}

function describeFailure(stderr: string): string {
	const lines = stderr
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("warning:"));
	return lines[lines.length - 1] ?? "unknown ssh failure";
}

/** Fail fast unless `ssh target true` succeeds non-interactively. */
export async function probe(target: SendTarget, signal?: AbortSignal): Promise<void> {
	const r = await run("ssh", [...baseSshArgs(), target.label, "true"], { timeoutMs: 20_000, signal });
	if (r.code === 0) return;
	const kind = classifyFailure(r.stderr);
	const detail = describeFailure(r.stderr);
	if (kind === "hostkey") {
		throw new TransportError(kind, `Host key not verified yet for ${target.label}. ${detail}`, r.stderr);
	}
	if (kind === "auth") {
		throw new TransportError(kind, `SSH authentication failed for ${target.label}. ${detail}`, r.stderr);
	}
	if (kind === "network") {
		throw new TransportError(kind, `Cannot reach ${target.label}. ${detail}`, r.stderr);
	}
	throw new TransportError(kind, `ssh ${target.label} failed. ${detail}`, r.stderr);
}

/** Create the inbox directory on the target (idempotent). */
export async function ensureRemoteInbox(target: SendTarget, signal?: AbortSignal): Promise<void> {
	const r = await run("ssh", [...baseSshArgs(), target.label, `mkdir -p ${REMOTE_INBOX}`], {
		timeoutMs: 20_000,
		signal,
	});
	if (r.code !== 0) {
		throw new TransportError(
			classifyFailure(r.stderr),
			`Could not create inbox on ${target.label}: ${describeFailure(r.stderr)}`,
			r.stderr,
		);
	}
}

/** Copy one file into the target inbox. Remote path is relative to remote $HOME. */
export async function scpToInbox(
	target: SendTarget,
	localPath: string,
	hooks: TransferHooks = {},
): Promise<string> {
	const remotePath = `${REMOTE_INBOX}/${basename(localPath)}`;
	const size = statSync(localPath).size;
	hooks.onPhase?.(`Sending ${basename(localPath)} (${formatBytes(size)}) to ${target.host}…`);
	const r = await run("scp", [...baseSshArgs(), localPath, `${target.label}:${remotePath}`], { signal: hooks.signal });
	if (r.code !== 0) {
		throw new TransportError(
			classifyFailure(r.stderr),
			`scp to ${target.label} failed: ${describeFailure(r.stderr)}`,
			r.stderr,
		);
	}
	return remotePath;
}

export function sha256File(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (d) => hash.update(d));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

/** sha256 of a remote file; tries sha256sum (Linux) then shasum -a 256 (macOS). */
export async function remoteSha256(target: SendTarget, remotePath: string, signal?: AbortSignal): Promise<string> {
	const r = await run(
		"ssh",
		[
			...baseSshArgs(),
			target.label,
			`sha256sum ${remotePath} 2>/dev/null || shasum -a 256 ${remotePath}`,
		],
		{ timeoutMs: 30_000, signal },
	);
	if (r.code !== 0) {
		throw new TransportError(
			"unknown",
			`Could not checksum file on ${target.label}: ${describeFailure(r.stderr) || r.stderr.trim()}`,
			r.stderr,
		);
	}
	const m = r.stdout.match(/([0-9a-fA-F]{64})/);
	if (!m) {
		throw new TransportError(
			"unknown",
			`No sha256 on ${target.label} (neither sha256sum nor shasum available?). ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
			r.stderr,
		);
	}
	return m[1].toLowerCase();
}

export interface SendResult {
	/** Remote path (home-relative, as reported to the user). */
	remotePath: string;
	sha256: string;
	bytes: number;
}

/**
 * Full send pipeline: probe → inbox → scp → sha256 verify.
 * The local hash is computed before the copy, so verification compares the
 * exact snapshot that was sent (session file growth during transfer does not
 * cause false mismatches).
 */
export async function sendSessionFile(target: SendTarget, localPath: string, hooks: TransferHooks = {}): Promise<SendResult> {
	hooks.onPhase?.(`Connecting to ${target.label}…`);
	await probe(target, hooks.signal);

	hooks.onPhase?.(`Preparing inbox on ${target.host}…`);
	await ensureRemoteInbox(target, hooks.signal);

	const expected = await sha256File(localPath);
	const remotePath = await scpToInbox(target, localPath, hooks);

	hooks.onPhase?.("Verifying sha256…");
	const actual = await remoteSha256(target, remotePath, hooks.signal);
	if (actual !== expected) {
		throw new TransportError(
			"unknown",
			`Checksum mismatch on ${target.label} — transfer corrupted. Local ${expected.slice(0, 12)}…, remote ${actual.slice(0, 12)}…. The source session is untouched; retry /hop.`,
		);
	}

	return {
		remotePath: `~/${remotePath}`,
		sha256: expected,
		bytes: statSync(localPath).size,
	};
}

// ---------------------------------------------------------------------------
// Interactive helpers. These run ssh with the terminal inherited; callers must
// suspend the TUI around them (see index.ts) so password / fingerprint prompts
// are rendered by ssh itself.
// ---------------------------------------------------------------------------

/** One interactive ssh connection: user verifies the fingerprint and authenticates. */
export function firstConnectInteractive(label: string): number {
	const r = spawnSync("ssh", [label, "exit"], { stdio: "inherit" });
	if (r.error) return 1;
	return r.status ?? 1;
}

export interface SshCopyIdResult {
	available: boolean;
	status: number;
}

/** Install the local default public key on the target (asks for password once). */
export function sshCopyIdInteractive(label: string): SshCopyIdResult {
	const r = spawnSync("ssh-copy-id", [label], { stdio: "inherit" });
	if (r.error) {
		// ENOENT — ssh-copy-id not installed locally.
		return { available: false, status: 1 };
	}
	return { available: true, status: r.status ?? 1 };
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Remote command execution (--run mode)
// ---------------------------------------------------------------------------

/** POSIX single-quote escaping for embedding a string in a remote command. */
export function shQuote(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Quote a path for the remote shell. `~/x` and relative paths are anchored to
 * the remote $HOME (which may differ from the local one); expansion must happen
 * remotely, so the path goes in double quotes around an unquoted `$HOME`.
 */
export function remoteShellPath(p: string): string {
	const t = p.trim();
	const inner = t.startsWith("~/") ? `$HOME/${t.slice(2)}` : t.startsWith("/") ? t : `$HOME/${t}`;
	return `"${inner.replaceAll('"', '\\"')}"`;
}

export function homeRelative(p: string): string {
	const t = p.trim();
	return t.startsWith("~/") ? `$HOME/${t.slice(2)}` : t;
}

/**
 * Shell prefix that locates the pi executable on the target. Non-interactive
 * ssh shells often miss PATH entries set up for interactive logins, so fall
 * back to pi's own bin directory before giving up.
 */
export function remotePiPrefix(): string {
	return [
		`PI_BIN="$(command -v pi 2>/dev/null || echo "$HOME/.pi/agent/bin/pi")"`,
		`[ -x "$PI_BIN" ] || { echo "pi executable not found on target (install pi, or symlink it into ~/.pi/agent/bin/pi)" >&2; exit 127; }`,
	].join("; ") + ";";
}

/** mkdir -p a directory on the target. */
export async function ensureRemoteDir(target: SendTarget, dir: string, signal?: AbortSignal): Promise<void> {
	const r = await run("ssh", [...baseSshArgs(), target.label, `mkdir -p ${remoteShellPath(dir)}`], {
		timeoutMs: 20_000,
		signal,
	});
	if (r.code !== 0) {
		throw new TransportError(
			classifyFailure(r.stderr),
			`Could not create directory on ${target.label}: ${describeFailure(r.stderr)}`,
			r.stderr,
		);
	}
}

/**
 * Run one command on the target and capture its streams. No timeout: remote
 * tasks can legitimately run for a long time; abort via the signal (which
 * kills the local ssh and, with it, the remote process through SIGHUP).
 */
export async function runRemoteCommand(
	target: SendTarget,
	command: string,
	hooks: TransferHooks = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return run("ssh", [...baseSshArgs(), target.label, command], { signal: hooks.signal });
}
