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

const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
	stdio: "inherit",
	env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
});
process.exit(result.status ?? 1);
