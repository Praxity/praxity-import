import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verify } from "../src/verify.ts";

/** A stand-in Studio CLI that reports `version` and accepts any project. */
function fakeStudio(version: string): string {
	const file = join(mkdtempSync(join(tmpdir(), "praxity-import-fake-studio-")), "praxity.mjs");
	writeFileSync(
		file,
		`const [cmd] = process.argv.slice(2);
if (cmd === "--version") console.log(${JSON.stringify(version)});
else if (cmd === "inspect") console.log(JSON.stringify({ ok: true, lessons: [] }));
else if (cmd === "export") console.log(JSON.stringify({ ok: true, accessibility: { status: "passed" } }));
`,
	);
	return file;
}

test("--verify refuses a Studio CLI older than 0.3.0, the first release that reads inline escapes and dropdown/word-bank blanks", async () => {
	for (const version of ["0.1.8", "0.2.0"]) {
		process.env.PRAXITY_CLI = fakeStudio(version);
		const result = await verify(mkdtempSync(join(tmpdir(), "praxity-import-course-")), []);
		assert.equal(result.parse.ok, false, version);
		assert.match(result.parse.error ?? "", new RegExp(`Studio CLI ${version.replaceAll(".", "\\.")} .*0\\.3\\.0 or later is required`), version);
		assert.equal(result.export, undefined, `${version} is not asked to export`);
	}
});

test("--verify accepts Studio 0.3.0 and later", async () => {
	for (const version of ["0.3.0", "0.10.2", "1.0.0"]) {
		process.env.PRAXITY_CLI = fakeStudio(version);
		const result = await verify(mkdtempSync(join(tmpdir(), "praxity-import-course-")), []);
		assert.equal(result.parse.ok, true, version);
		assert.deepEqual(result.export, { ok: true, accessibility: "passed" }, version);
	}
});
