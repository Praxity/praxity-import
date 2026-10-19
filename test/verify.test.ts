import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("--verify records identity on its copy, because Studio export refuses a course without it", async () => {
	const file = join(mkdtempSync(join(tmpdir(), "praxity-import-fake-studio-")), "praxity.mjs");
	writeFileSync(
		file,
		`import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const [cmd, sub, course] = process.argv.slice(2);
if (cmd === "--version") console.log("0.3.0");
else if (cmd === "inspect") console.log(JSON.stringify({ ok: true, lessons: [] }));
else if (cmd === "identity" && sub === "init") { mkdirSync(join(course, ".praxity/identity"), { recursive: true }); console.log(JSON.stringify({ ok: true, changed: true })); }
else if (cmd === "export") console.log(JSON.stringify(existsSync(join(sub, ".praxity/identity")) ? { ok: true, accessibility: { status: "passed" } } : { ok: false, error: { message: "Export refused: course identity must be recorded" } }));
`,
	);
	process.env.PRAXITY_CLI = file;
	const project = mkdtempSync(join(tmpdir(), "praxity-import-course-"));
	const result = await verify(project, []);
	assert.deepEqual(result.export, { ok: true, accessibility: "passed" });
	assert.equal(existsSync(join(project, ".praxity")), false, "the imported course itself stays untouched");
});

test("--verify accepts Studio 0.3.0 and later", async () => {
	for (const version of ["0.3.0", "0.10.2", "1.0.0"]) {
		process.env.PRAXITY_CLI = fakeStudio(version);
		const result = await verify(mkdtempSync(join(tmpdir(), "praxity-import-course-")), []);
		assert.equal(result.parse.ok, true, version);
		assert.deepEqual(result.export, { ok: true, accessibility: "passed" }, version);
	}
});
