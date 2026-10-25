/**
 * pi-hop — send the current Pi session to another machine and resume it there.
 *
 *   /hop user@192.168.1.105   Send this session over SSH (Mac → Linux, Mac → Mac)
 *   /hop resume               Adopt a received session and continue where you left off
 *   /hop list                 Show the inbox, archive and recent targets
 *   /hop                      Interactive menu
 *
 * Design: lightweight, SSH-only, no server component on the receiving side.
 * The source pushes the raw session JSONL into ~/.pi/agent/sessions/pi-hop/inbox/
 * on the target and verifies it with sha256. The target adopts the file with
 * SessionManager.forkFrom(), so history, branches and compaction survive
 * byte-for-byte while the working directory is remapped to the local machine.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	type SendTarget,
	TransportError,
	ensureRemoteDir,
	firstConnectInteractive,
	homeRelative,
	parseTarget,
	remotePiPrefix,
	remoteShellPath,
	runRemoteCommand,
	sendSessionFile,
	shQuote,
	sshCopyIdInteractive,
} from "./transfer";
import {
	type InboxItem,
	LOCAL_HOP_DIR,
	adoptPath,
	adoptSession,
	describeInboxItem,
	formatBytes,
	lastPathSegment,
	listInbox,
	loadTargets,
	readHeaderCwd,
	rememberTarget,
} from "./session";

/** Persisted marker for a completed transfer (rendered in the transcript). */
interface HopSendEntryData {
	target: string;
	remotePath: string;
	sha256: string;
	bytes: number;
	entries: number;
	sentAt: string;
}

const DEFAULT_RUN_PROMPT =
	"This session was transferred from another machine mid-task. " +
	"Review the conversation history above, identify any unfinished work or next steps, " +
	"and continue executing them autonomously until complete. " +
	"When done, summarize what you did and what remains.";

interface RunOptions {
	enabled: boolean;
	/** Working directory on the target machine (~/x, relative or absolute). */
	dir?: string;
	/** Continuation prompt; DEFAULT_RUN_PROMPT when omitted. */
	prompt?: string;
}

/** Parse `/hop <target> [--run] [--dir <path>] [prompt words…]`. */
function parseSendArgs(raw: string): { target: SendTarget; run: RunOptions } | null {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return null;
	const target = parseTarget(tokens[0]);
	if (!target) return null;
	const run: RunOptions = { enabled: false };
	const promptWords: string[] = [];
	for (let i = 1; i < tokens.length; i++) {
		if (tokens[i] === "--run") run.enabled = true;
		else if (tokens[i] === "--dir") {
			run.dir = tokens[i + 1];
			i += 1;
			if (run.dir === undefined) return null;
		} else {
			promptWords.push(tokens[i]);
		}
	}
	if (promptWords.length > 0) {
		if (!run.enabled) return null; // prompt words only make sense with --run
		run.prompt = promptWords.join(" ");
	}
	if (run.dir !== undefined && !run.enabled) return null;
	return { target, run };
}

const USAGE = [
	"pi-hop usage:",
	"  /hop user@host                     send this session (e.g. /hop ubuntu@192.168.1.105)",
	"  /hop user@host --run               send, then let pi on the target continue unfinished work",
	"  /hop user@host --run <prompt>      same, with your own continuation instruction",
	"  /hop user@host --run --dir <path>  choose the working directory on the target",
	"  /hop resume                        resume a received session from the inbox",
	"  /hop list                          show inbox, archive and recent targets",
].join("\n");

// ---------------------------------------------------------------------------
// Send flow
// ---------------------------------------------------------------------------

type SendOutcome =
	| { ok: true; remotePath: string; sha256: string; bytes: number }
	| { setup: "auth" | "hostkey"; detail: string }
	| { error: string }
	| null;

/**
 * Progress dialog: a minimal custom component showing the current phase.
 * Esc aborts the in-flight ssh/scp child process.
 */
function runSendWithProgress(ctx: ExtensionCommandContext, target: SendTarget, sessionFile: string): Promise<SendOutcome> {
	return ctx.ui.custom<SendOutcome>((tui, theme, _kb, done) => {
		const abort = new AbortController();
		let phase = `Connecting to ${target.label}…`;

		const component = {
			render(_width: number): string[] {
				return [
					`${theme.fg("accent", "⇄ pi-hop")} ${phase}`,
					theme.fg("dim", "  Esc cancels the transfer (source session is never modified)"),
				];
			},
			invalidate() {},
			handleInput(data: string) {
				if (data === "\x1b") abort.abort();
			},
		};

		const doSend = async () => {
			try {
				const result = await sendSessionFile(target, sessionFile, {
					signal: abort.signal,
					onPhase: (p) => {
						phase = p;
						tui.requestRender(true);
					},
				});
				done({ ok: true, ...result });
			} catch (err) {
				if (err instanceof TransportError) {
					if (err.kind === "aborted") return done(null);
					if (err.kind === "auth" || err.kind === "hostkey") {
						return done({ setup: err.kind, detail: err.message });
					}
					done({ error: err.message });
				} else {
					done({ error: err instanceof Error ? err.message : String(err) });
				}
			}
		};
		void doSend();

		return component;
	});
}

/** Suspend the TUI and let ssh/ssh-copy-id own the terminal for interactive setup. */
async function offerInteractiveSetup(
	ctx: ExtensionCommandContext,
	target: SendTarget,
	kind: "auth" | "hostkey",
): Promise<boolean> {
	const isHostKey = kind === "hostkey";
	const title = isHostKey ? "First connection to this host" : "SSH key authentication required";
	const message = isHostKey
		? `${target.label} is not in your known_hosts yet.\nConnect once interactively to review and confirm the host fingerprint?`
		: `pi-hop needs passwordless SSH to ${target.label} (the TUI cannot relay password prompts).\nRun ssh-copy-id now? You will type the password once. If the remote username differs from yours, cancel and use /hop user@${target.host}.`;

	if (!(await ctx.ui.confirm(title, message))) {
		ctx.ui.notify(
			isHostKey
				? `Run manually, then retry: ssh ${target.label} exit`
				: `Run manually, then retry: ssh-copy-id ${target.label}`,
			"info",
		);
		return false;
	}

	const status = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
		// Release the terminal to ssh so fingerprint/password prompts work.
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");
		let status: number;
		if (isHostKey) {
			process.stdout.write(
				`pi-hop: first connection to ${target.label}\nVerify the fingerprint, answer "yes", then the session will exit.\n\n`,
			);
			status = firstConnectInteractive(target.label);
		} else {
			const r = sshCopyIdInteractive(target.label);
			if (!r.available) {
				process.stdout.write(
					`pi-hop: ssh-copy-id not found locally.\nInstall your key manually:\n  cat ~/.ssh/id_ed25519.pub | ssh ${target.label} 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys'\n`,
				);
			}
			status = r.status;
		}
		process.stdout.write(status === 0 ? "\npi-hop: setup completed.\n" : "\npi-hop: setup did not complete.\n");
		tui.start();
		tui.requestRender(true);
		done(status);
		return { render: () => [], invalidate: () => {} };
	});

	return status === 0;
}

async function sendFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	target: SendTarget,
	run: RunOptions = { enabled: false },
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("pi-hop send requires interactive mode (it needs the progress dialog)", "error");
		return;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify("pi-hop: the agent is still working — wait for it to finish, then /hop again.", "warning");
		return;
	}

	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile || !existsSync(sessionFile)) {
		ctx.ui.notify("pi-hop: the current session is not persisted (started with --no-session?).", "error");
		return;
	}
	if (statSync(sessionFile).size === 0 || countEntries(sessionFile) === 0) {
		ctx.ui.notify("pi-hop: this session has no conversation yet — nothing to send.", "warning");
		return;
	}

	// One setup round is allowed (interactive host-key / ssh-copy-id), then retry.
	let outcome = await runSendWithProgress(ctx, target, sessionFile);
	if (outcome && "setup" in outcome) {
		const ready = await offerInteractiveSetup(ctx, target, outcome.setup);
		if (!ready) return;
		outcome = await runSendWithProgress(ctx, target, sessionFile);
		if (outcome && "setup" in outcome) {
			ctx.ui.notify(`pi-hop: ${outcome.detail} — complete the setup manually, then retry /hop.`, "error");
			return;
		}
	}

	if (!outcome) {
		ctx.ui.notify("pi-hop: transfer cancelled — source session untouched.", "info");
		return;
	}
	if ("error" in outcome) {
		ctx.ui.notify(`pi-hop: ${outcome.error}`, "error");
		return;
	}

	rememberTarget(target.label);
	const entries = countEntries(sessionFile);
	pi.appendEntry<HopSendEntryData>("pi-hop.send", {
		target: target.label,
		remotePath: outcome.remotePath,
		sha256: outcome.sha256,
		bytes: outcome.bytes,
		entries,
		sentAt: new Date().toISOString(),
	});

	if (run.enabled) {
		await runRemoteTaskFlow(pi, ctx, target, {
			remotePath: outcome.remotePath,
			sessionFile,
			dir: run.dir,
			prompt: run.prompt,
		});
		return;
	}

	ctx.ui.notify(
		`✓ pi-hop: sent to ${target.label} (${formatBytes(outcome.bytes)}, sha256 verified)\n` +
			`On that machine: cd to your project, run pi, then /hop resume`,
		"info",
	);
}

// ---------------------------------------------------------------------------
// --run: send, then let pi on the target continue the unfinished work
// ---------------------------------------------------------------------------

interface RemoteRunEntryData {
	target: string;
	dir: string;
	prompt: string;
	exitCode: number | null;
	ok: boolean;
	logFile: string;
	at: string;
}

type RemoteRunOutcome =
	| { ok: true; exitCode: number | null; logFile: string; outTail: string; errTail: string }
	| { error: string }
	| null;

interface RemoteRunOpts {
	remotePath: string;
	sessionFile: string;
	dir?: string;
	prompt?: string;
}

/** Progress dialog for the remote-execution phases (Esc kills the local ssh, and SIGHUP stops the remote pi). */
function runRemoteWithProgress(
	ctx: ExtensionCommandContext,
	target: SendTarget,
	opts: RemoteRunOpts,
	dir: string,
	prompt: string,
): Promise<RemoteRunOutcome> {
	return ctx.ui.custom<RemoteRunOutcome>((tui, theme, _kb, done) => {
		const abort = new AbortController();
		let phase = `Preparing ${dir} on ${target.host}…`;

		const component = {
			render(_width: number): string[] {
				return [
					`${theme.fg("accent", "⚙ pi-hop --run")} ${phase}`,
					theme.fg("dim", "  Esc stops watching and kills the remote run"),
				];
			},
			invalidate() {},
			handleInput(data: string) {
				if (data === "\x1b") abort.abort();
			},
		};

		const doRun = async () => {
			try {
				// 1. Workspace directory on the target
				await ensureRemoteDir(target, dir, abort.signal);

				// 2. Headless adoption: pi on the target runs /hop-auto adopt, which
				//    forks the inbox file into that directory's session store and
				//    prints the adopted session path.
				phase = `Adopting session in ${dir} (remote pi)…`;
				tui.requestRender(true);
				const adoptCmd =
					`${remotePiPrefix()} cd ${remoteShellPath(dir)} && "$PI_BIN" --print --no-session ` +
					`"/hop-auto adopt ${homeRelative(opts.remotePath)}"`;
				const adopted = await runRemoteCommand(target, adoptCmd, { signal: abort.signal }).then((r) => {
					if (r.code !== 0) {
						const err = (r.stderr || r.stdout).trim();
						throw new TransportError(
							"unknown",
							`Remote adoption failed: ${err.slice(-400) || `exit code ${r.code}`}. ` +
								`Is pi installed and pi-hop installed (pi install ./pi-hop) on the target?`,
							r.stderr,
						);
					}
					const m = r.stdout
						.trim()
						.split("\n")
						.map((l) => l.trim())
						.filter((l) => l.endsWith(".jsonl"))
						.pop();
					if (!m) {
						throw new TransportError(
							"unknown",
							`Could not parse adopted session path from remote output: ${r.stdout.trim().slice(-300)}`,
						);
					}
					return m;
				});

				// 3. Run the continuation task headlessly; output streams back over ssh
				phase = `pi on ${target.host} is continuing the task (may take a while)…`;
				tui.requestRender(true);
				const runCmd =
					`${remotePiPrefix()} cd ${remoteShellPath(dir)} && "$PI_BIN" --print ` +
					`--session ${shQuote(adopted)} ${shQuote(prompt)}`;
				const result = await runRemoteCommand(target, runCmd, { signal: abort.signal });

				// 4. Persist the full output locally for later inspection
				mkdirSync(LOCAL_HOP_DIR, { recursive: true });
				const logFile = join(LOCAL_HOP_DIR, "last-remote-run.log");
				writeFileSync(logFile, `$ ssh ${target.label}\n${runCmd}\n\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`);
				const tailOf = (text: string, n: number) =>
					text
						.split("\n")
						.map((l) => l.trimEnd())
						.filter((l) => l.trim().length > 0)
						.slice(-n)
						.join("\n");
				done({
					ok: true,
					exitCode: result.code,
					logFile,
					outTail: tailOf(result.stdout, 4),
					errTail: tailOf(result.stderr, 4),
				});
			} catch (err) {
				if (err instanceof TransportError && err.kind === "aborted") return done(null);
				done({ error: err instanceof Error ? err.message : String(err) });
			}
		};
		void doRun();

		return component;
	});
}

async function runRemoteTaskFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	target: SendTarget,
	opts: RemoteRunOpts,
): Promise<void> {
	const sourceCwd = readHeaderCwd(opts.sessionFile);
	const dir = opts.dir ?? `~/pi-hop-workspace/${sourceCwd ? lastPathSegment(sourceCwd) : "project"}`;
	const prompt = opts.prompt ?? DEFAULT_RUN_PROMPT;

	let outcome = await runRemoteWithProgress(ctx, target, opts, dir, prompt);
	if (!outcome) {
		ctx.ui.notify("pi-hop: remote run cancelled/interrupted (the remote pi process was stopped with the ssh channel).", "warning");
		return;
	}
	if ("error" in outcome) {
		ctx.ui.notify(`pi-hop: ${outcome.error}`, "error");
		return;
	}

	pi.appendEntry<RemoteRunEntryData>("pi-hop.remote-run", {
		target: target.label,
		dir,
		prompt,
		exitCode: outcome.exitCode,
		ok: outcome.exitCode === 0,
		logFile: outcome.logFile,
		at: new Date().toISOString(),
	});

	if (outcome.exitCode !== 0) {
		ctx.ui.notify(
			`✗ pi-hop: remote run exited with ${outcome.exitCode ?? "signal"}\n` +
				(outcome.errTail ? `${outcome.errTail}\n` : "") +
				`full log: ${outcome.logFile}`, 
			"error",
		);
		return;
	}

	ctx.ui.notify(
		`✓ pi-hop: remote task finished on ${target.label} (exit 0)\n` +
			`dir: ${dir}\n` +
			(outcome.outTail ? `${outcome.outTail}\n` : "") +
			`full log: ${outcome.logFile}\n` +
			`The continuation transcript lives on the target: ${dir} (pi --resume there to keep working).`,
		"info",
	);
}

function countEntries(sessionFile: string): number {
	try {
		const lines = readFileSync(sessionFile, "utf8").split("\n").filter((l) => l.trim().length > 0);
		return Math.max(0, lines.length - 1);
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Resume flow
// ---------------------------------------------------------------------------

async function adoptAndSwitch(ctx: ExtensionCommandContext, item: InboxItem): Promise<void> {
	const confirmed = await ctx.ui.confirm(
		"pi-hop: adopt this session?",
		`Received from project: ${item.sourceCwd}\nWill open in:      ${ctx.cwd}\n` +
			`${item.entries} entries (messages, branches, compactions all preserved).\nThe inbox original will be archived locally.`,
	);
	if (!confirmed) return;

	let adoptedPath: string;
	try {
		adoptedPath = adoptSession(item, ctx.cwd);
	} catch (err) {
		ctx.ui.notify(`pi-hop: adoption failed — ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}

	try {
		await ctx.switchSession(adoptedPath, {
			withSession: async (fresh) => {
				fresh.ui.notify(
					`✓ pi-hop: session "${item.sessionName ?? item.firstMessage ?? item.file}" restored — context intact. Continue where you left off.`,
					"info",
				);
			},
		});
	} catch (err) {
		ctx.ui.notify(
			`pi-hop: could not switch sessions — ${err instanceof Error ? err.message : String(err)}\nThe adopted copy is at: ${adoptedPath}`,
			"error",
		);
	}
}

async function resumeFlow(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("pi-hop resume requires a UI (TUI or RPC)", "error");
		return;
	}
	const { items, broken } = listInbox();
	if (items.length === 0) {
		const brokenNote = broken.length > 0 ? ` (${broken.length} unreadable file(s) skipped)` : "";
		ctx.ui.notify(`pi-hop: inbox is empty${brokenNote}. Send a session from another machine with /hop user@host`, "info");
		return;
	}
	const labels = items.map(describeInboxItem);
	const picked = await ctx.ui.select("pi-hop: received sessions (newest first)", labels);
	if (picked === undefined) return;
	const item = items[labels.indexOf(picked)];
	if (item) await adoptAndSwitch(ctx, item);
}

// ---------------------------------------------------------------------------
// List flow
// ---------------------------------------------------------------------------

async function listFlow(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("pi-hop list requires a UI (TUI or RPC)", "error");
		return;
	}
	const { items, broken } = listInbox();
	const targets = loadTargets();

	type Row = { label: string; item?: InboxItem; target?: string };
	const rows: Row[] = [];
	rows.push({ label: "--- Inbox (resume these) ---" });
	for (const it of items) rows.push({ label: `  ${describeInboxItem(it)}`, item: it });
	if (items.length === 0) rows.push({ label: "  (empty)" });
	if (broken.length > 0) {
		rows.push({ label: "--- Unreadable ---" });
		for (const b of broken) rows.push({ label: `  ⚠ ${b}` });
	}
	rows.push({ label: "--- Recent targets ---" });
	if (targets.length === 0) rows.push({ label: "  (none yet)" });
	for (const t of targets) {
		rows.push({
			label: `  ${t.target} · sent ${t.uses}× · last ${new Date(t.lastUsed).toLocaleString()}`,
			target: t.target,
		});
	}

	const picked = await ctx.ui.select("pi-hop: transfers & targets", rows.map((r) => r.label));
	if (picked === undefined) return;
	const row = rows.find((r) => r.label === picked);
	if (row?.item) await adoptAndSwitch(ctx, row.item);
	else if (row?.target) ctx.ui.notify(`Send again with: /hop ${row.target}`, "info");
}

// ---------------------------------------------------------------------------
// Menu + command registration
// ---------------------------------------------------------------------------

async function menuFlow(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const choice = await ctx.ui.select("pi-hop", [
		"Send this session to another machine…",
		"Resume a received session…",
		"List transfers & targets",
	]);
	if (choice === undefined) return;
	if (choice.startsWith("Send")) {
		const last = loadTargets()[0]?.target;
		const dest = await ctx.ui.input("Send current session to (user@host)", last ?? "ubuntu@192.168.1.105");
		const target = dest?.trim() ? parseTarget(dest) : undefined;
		if (!target) {
			ctx.ui.notify("pi-hop: expected user@host (e.g. ubuntu@192.168.1.105)", "error");
			return;
		}
		await sendFlow(pi, ctx, target);
	} else if (choice.startsWith("Resume")) {
		await resumeFlow(ctx);
	} else {
		await listFlow(ctx);
	}
}

async function runCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const arg = args.trim();
	if (!arg) {
		if (!ctx.hasUI) {
			ctx.ui.notify(USAGE, "info");
			return;
		}
		await menuFlow(pi, ctx);
		return;
	}
	if (arg === "resume") return resumeFlow(ctx);
	if (arg === "list") return listFlow(ctx);
	if (arg === "help" || arg === "--help" || arg === "-h") {
		ctx.ui.notify(USAGE, "info");
		return;
	}
	const parsed = parseSendArgs(arg);
	if (!parsed) {
		ctx.ui.notify(`pi-hop: "${arg}" is not a valid target/flag combination.\n\n${USAGE}`, "error");
		return;
	}
	await sendFlow(pi, ctx, parsed.target, parsed.run);
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<HopSendEntryData>("pi-hop.send", (entry, _options, theme) => {
		const d = entry.data;
		if (!d) return undefined;
		return new Text(
			`${theme.fg("accent", "⇥ pi-hop →")} ${d.target} ${theme.fg("dim", `· ${formatBytes(d.bytes)} · sha256 verified · ${new Date(d.sentAt).toLocaleString()}`)}`,
		);
	});

	pi.registerEntryRenderer<RemoteRunEntryData>("pi-hop.remote-run", (entry, _options, theme) => {
		const d = entry.data;
		if (!d) return undefined;
		const status = d.ok ? theme.fg("accent", "exit 0") : theme.fg("error", `exit ${d.exitCode ?? "signal"}`);
		return new Text(
			`${theme.fg("accent", "⚙ pi-hop --run →")} ${d.target} ${theme.fg("dim", `· ${d.dir} · ${status} · ${new Date(d.at).toLocaleString()}`)}`,
		);
	});

	const register = (name: string, description: string) =>
		pi.registerCommand(name, {
			description,
			getArgumentCompletions: (prefix) => {
				const base = ["resume", "list", "help", "--run"];
				const targets = loadTargets().map((t) => t.target);
				const all = [...base, ...targets];
				const filtered = all.filter((v) => v.startsWith(prefix));
				return filtered.length > 0 ? filtered.map((v) => ({ value: v, label: v })) : null;
			},
			handler: async (args, ctx) => runCommand(pi, ctx, args),
		});

	register("hop", "Send this session to another machine over SSH (add --run to continue unfinished work there)");

	// Headless companion command, invoked by --run over SSH on the target machine.
	// Not part of the interactive workflow; prints the adopted session path to stdout.
	pi.registerCommand("hop-auto", {
		description: "pi-hop internal: headless adoption of an inbox session",
		handler: async (args, ctx) => {
			const [sub, file] = args.trim().split(/\s+/);
			if (sub !== "adopt" || !file) {
				process.stdout.write("usage: /hop-auto adopt <inbox-file.jsonl>\n");
				return;
			}
			try {
				const adopted = adoptPath(file, ctx.cwd);
				if (ctx.mode === "tui") ctx.ui.notify(`pi-hop: adopted → ${adopted}`, "info");
				else process.stdout.write(`${adopted}\n`);
			} catch (err) {
				const msg = `hop-auto failed: ${err instanceof Error ? err.message : String(err)}\n`;
				if (ctx.mode === "tui") ctx.ui.notify(msg.trimEnd(), "error");
				else process.stdout.write(msg);
			}
		},
	});
}
