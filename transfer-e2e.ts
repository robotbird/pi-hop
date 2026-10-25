/**
 * End-to-end transfer test against fake ssh/scp shims (no real server).
 * PATH=/tmp/pi-hop-fakebin FAKE_HOME=/tmp/pi-hop-fakehome node transfer-e2e.ts
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { sendSessionFile, parseTarget } from "./src/transfer.ts";

const target = parseTarget("ubuntu@192.168.1.105")!;
const local = "/tmp/pi-hop-e2e-source.jsonl";
const content = '{"type":"session","version":3,"id":"e2e","timestamp":"t","cwd":"/x"}\n{"type":"message","id":"a","parentId":null,"timestamp":"t","message":{"role":"user","content":"hello e2e","timestamp":1}}\n';
writeFileSync(local, content);

const phases: string[] = [];
const result = await sendSessionFile(target, local, { onPhase: (p) => phases.push(p) });

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
	console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : " " + extra}`);
	if (!cond) failures += 1;
}

check("send reported phases", phases.length >= 4, JSON.stringify(phases));
check("remote path points into inbox", result.remotePath === "~/.pi/agent/sessions/pi-hop/inbox/pi-hop-e2e-source.jsonl", result.remotePath);
check("sha256 verified", result.sha256 === createHash("sha256").update(content).digest("hex"));
check("bytes reported", result.bytes === Buffer.byteLength(content));

const remoteFile = "/tmp/pi-hop-fakehome/.pi/agent/sessions/pi-hop/inbox/pi-hop-e2e-source.jsonl";
check("file exists on fake remote", existsSync(remoteFile));
check("remote content identical", readFileSync(remoteFile, "utf8") === content);

// corruption detection is covered separately with FAKE_CORRUPT=1 (see corrupt-e2e.ts)
rmSync(local, { force: true });

console.log(failures === 0 ? "\nE2E TRANSFER OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
