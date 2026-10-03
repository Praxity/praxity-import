/**
 * Runs the test suite with temporary files kept in out/test-tmp, emptied first.
 * A Node script rather than a shell line so `pnpm test` works under cmd too.
 *
 *   node scripts/test.ts [node --test options]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const tmp = resolve("out/test-tmp");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const files = readdirSync("test")
	.filter((name) => name.endsWith(".test.ts"))
	.sort()
	.map((name) => join("test", name));

// os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
	stdio: "inherit",
	env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
});
process.exit(result.status ?? 1);
