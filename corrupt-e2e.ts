/** Corruption-in-transit test: PATH=... FAKE_HOME=... FAKE_CORRUPT=1 node corrupt-e2e.ts */
import { writeFileSync, rmSync } from "node:fs";
import { sendSessionFile, parseTarget } from "/Users/robotbird/Work/yepeng/works/pi-hop/src/transfer.ts";

const local = "/tmp/pi-hop-e2e-source.jsonl";
writeFileSync(local, '{"type":"session","version":3,"id":"e2e","timestamp":"t","cwd":"/x"}\n');
try {
	await sendSessionFile(parseTarget("u@h")!, local, {});
	console.log("✗ corruption NOT detected");
	rmSync(local, { force: true });
	process.exit(1);
} catch (err: any) {
	const ok = err?.kind === "unknown" && /Checksum mismatch/.test(err?.message ?? "");
	console.log(ok ? "✓ tampered transfer detected by sha256" : `✗ wrong error: ${err?.message}`);
	rmSync(local, { force: true });
	process.exit(ok ? 0 : 1);
}
