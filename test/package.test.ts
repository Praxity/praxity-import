import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function run(command: string, args: string[], cwd: string, expected = 0, env = process.env) {
	const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
	assert.ifError(result.error);
	assert.equal(result.status, expected, result.stderr || result.stdout);
	return result;
}
function commit(repo: string) {
	run("git", ["add", "."], repo);
	run("git", ["-c", "user.name=Package test", "-c", "user.email=package-test@example.invalid", "commit", "-qm", "Synthetic packaging input"], repo,
		0, { ...process.env, GIT_AUTHOR_NAME: "Package test", GIT_AUTHOR_EMAIL: "package-test@example.invalid", GIT_COMMITTER_NAME: "Package test", GIT_COMMITTER_EMAIL: "package-test@example.invalid" });
}
function repository(t: TestContext) {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "import portable ")));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const repo = join(scratch, "repo");
	mkdirSync(repo);
	for (const path of ["src", "scripts/package.mjs", "skill", "docs/adr", "fixtures/smoke/scorm", "package.json", "LICENSE", "LICENSING.md", "NOTICE.md", "THIRD-PARTY-NOTICES.md"]) cpSync(join(root, path), join(repo, path), { recursive: true });
	writeFileSync(join(repo, ".gitignore"), "node_modules/\ncorpus/local/\nout/\n");
	function install(name: string, owner: string) {
		let path = dirname(createRequire(join(owner, "package.json")).resolve(name));
		while (!existsSync(join(path, "package.json")) || JSON.parse(readFileSync(join(path, "package.json"), "utf8")).name !== name) path = dirname(path);
		path = realpathSync(path);
		cpSync(path, join(repo, "node_modules", name), { recursive: true });
		const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
		for (const child of Object.keys(pkg.dependencies ?? {})) install(child, path);
	}
	for (const name of ["parse5", "yauzl"]) install(name, root);
	run("git", ["init", "-q"], repo);
	commit(repo);
	return { scratch, repo, output: join(scratch, "payload") };
}
function pack(repo: string, output: string, expected = 0) {
	return run(process.execPath, ["scripts/package.mjs", "--output", output], repo, expected);
}
function paths(root: string, path = ""): string[] {
	return readdirSync(join(root, path)).flatMap((name) => {
		const file = join(path, name), info = lstatSync(join(root, file));
		assert.equal(info.isSymbolicLink(), false, file);
		if (info.isDirectory()) return paths(root, file);
		assert.ok(info.isFile(), file);
		return [file.split(sep).join("/")];
	}).sort();
}

test("package contains only portable runtime files, complete notices and exact inventory hashes", (t) => {
	const { repo, output } = repository(t);
	for (const path of ["corpus/local/private.txt", "out/course.txt", "node_modules/dev-only/test.js", "src/ignored.test.ts"]) {
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		writeFileSync(join(repo, path), "DO NOT SHIP\n");
	}
	commit(repo);
	// Exercise LF normalization even when a clean Windows checkout uses CRLF.
	const cli = join(repo, "src/cli.ts");
	writeFileSync(cli, readFileSync(cli, "utf8").replace(/\r?\n/g, "\r\n"));
	assert.equal(run("git", ["status", "--porcelain"], repo).stdout.trim(), "");
	const result = JSON.parse(pack(repo, output).stdout);
	const inventory = JSON.parse(readFileSync(join(output, "inventory.json"), "utf8"));
	const files = paths(output);
	assert.equal(result.fileCount, files.length);
	assert.deepEqual(files, [...inventory.files.map((file: { path: string }) => file.path), "inventory.json"].sort());
	assert.deepEqual(inventory.inventoryExcludes, ["inventory.json"]);
	assert.equal(inventory.source.revision, run("git", ["rev-parse", "HEAD"], repo).stdout.trim());
	assert.equal(inventory.source.dirty, false);
	assert.deepEqual(inventory.target, { platform: "portable", arch: "portable" });
	assert.equal(inventory.entry, "src/cli.ts");
	assert.deepEqual(inventory.dependencies.map((pkg: { name: string; version: string }) => `${pkg.name}@${pkg.version}`).sort(), ["entities@8.1.0", "parse5@8.0.1", "pend@1.2.0", "yauzl@3.4.0"]);
	assert.ok(files.includes("skill/SKILL.md"));
	assert.ok(files.includes("docs/adr/0002-layout-from-recorded-geometry.md"));
	for (const path of ["LICENSE", "LICENSING.md", "NOTICE.md", "THIRD-PARTY-NOTICES.md"]) assert.ok(inventory.legalFiles.includes(path));
	assert.equal(files.some((file) => /(?:^|\/)(?:test|tests|corpus|out|scripts|dev-only|\.git)(?:\/|$)|\.(?:map|d\.ts|test\.ts|node|exe|dll|wasm)$/.test(file)), false);
	for (const file of inventory.files) {
		const bytes = readFileSync(join(output, file.path));
		assert.equal(file.size, bytes.length, file.path);
		assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"), file.path);
		assert.equal(bytes.includes(13), false, file.path);
		assert.equal(bytes.includes(0), false, file.path);
		assert.doesNotMatch(bytes.toString(), /DO NOT SHIP|["'](?:[A-Za-z]:[\\/]|\/Users\/)/, file.path);
		assert.equal(file.mode, bytes.subarray(0, 2).toString() === "#!" ? 0o755 : 0o644, file.path);
		if (process.platform !== "win32") assert.equal(lstatSync(join(output, file.path)).mode & 0o777, file.mode);
	}
	for (const pkg of inventory.dependencies) assert.ok(inventory.legalFiles.some((path: string) => path.startsWith(`${pkg.path}/LICENSE`)), pkg.name);
});

test("relocated package converts the public synthetic SCORM fixture with only Node and no network", (t) => {
	const { repo, output, scratch } = repository(t);
	pack(repo, output);
	const moved = join(scratch, "relocated");
	cpSync(output, moved, { recursive: true });
	rmSync(repo, { recursive: true, force: true });
	rmSync(output, { recursive: true, force: true });
	const guard = join(scratch, "deny-network.mjs");
	writeFileSync(guard, `import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw new Error('Network disabled'); };
net.Socket.prototype.connect = net.connect = net.createConnection = denied;
dgram.createSocket = denied;
for (const api of [dns, dns.promises]) for (const key of Object.keys(api)) if (key.startsWith('resolve') || ['lookup', 'lookupService', 'reverse'].includes(key)) api[key] = denied;
http.request = http.get = https.request = https.get = globalThis.fetch = denied;
syncBuiltinESMExports();
`);
	const env = { PATH: "", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) };
	const args = ["--permission", `--allow-fs-read=${scratch}`, "--import", pathToFileURL(guard).href];
	assert.match(run(process.execPath, [...args, "--input-type=module", "-e", `import { readFileSync } from 'node:fs'; try { readFileSync(${JSON.stringify(join(root, "package.json"))}); process.exit(9); } catch (error) { console.log(error.code); }`], scratch, 0, env).stdout, /ERR_ACCESS_DENIED/);
	assert.match(run(process.execPath, [...args, "--input-type=module", "-e", "import net from 'node:net'; try { net.connect(80, 'example.invalid'); } catch (error) { console.log(error.message); }"], scratch, 0, env).stdout, /Network disabled/);
	assert.match(run(process.execPath, [...args, join(moved, "src/cli.ts"), "--help"], scratch, 0, env).stdout, /Usage:/);
	const course = join(scratch, "course");
	const converted = run(process.execPath, [...args, `--allow-fs-read=${course}`, `--allow-fs-write=${scratch}`, join(moved, "src/cli.ts"), join(moved, "fixtures/smoke/scorm"), "--output", course], scratch, 0, env);
	const result = JSON.parse(converted.stdout);
	assert.equal(result.ok, true);
	assert.equal(result.tool, "html");
	assert.equal(result.title, "Tiny import");
	assert.equal(result.lessons, 1);
	assert.equal(result.pages, 1);
	assert.equal(result.losses, 0);
	assert.match(readFileSync(join(course, "course.yaml"), "utf8"), /^title: "Tiny import"$/m);
	assert.match(readFileSync(join(course, "01-tiny-import.prax"), "utf8"), /^# Welcome\n\nHello from Praxity Import\.$/m);
	const report = JSON.parse(readFileSync(join(course, "import-report.json"), "utf8"));
	assert.equal(report.detected.tool, "html");
	assert.deepEqual(report.losses, []);
});

test("package refuses staged, unstaged and untracked changes before creating output", (t) => {
	const { repo, output } = repository(t);
	const file = join(repo, "src/new.ts");
	writeFileSync(file, "export {};\n");
	assert.match(pack(repo, output, 1).stderr, /dirty tree/);
	run("git", ["add", "src/new.ts"], repo);
	assert.match(pack(repo, output, 1).stderr, /dirty tree/);
	commit(repo);
	writeFileSync(file, "export const changed = true;\n");
	assert.match(pack(repo, output, 1).stderr, /dirty tree/);
	assert.equal(existsSync(output), false);
});

test("package refuses existing output without changing it and refuses output within source", (t) => {
	const { repo, output } = repository(t);
	mkdirSync(output);
	writeFileSync(join(output, "keep.txt"), "keep");
	assert.match(pack(repo, output, 1).stderr, /already exists/);
	assert.deepEqual(readdirSync(output), ["keep.txt"]);
	assert.equal(readFileSync(join(output, "keep.txt"), "utf8"), "keep");
	assert.match(pack(repo, join(repo, "src/new-output"), 1).stderr, /inside a payload source/);
	assert.equal(existsSync(join(repo, "src/new-output")), false);
});

test("package follows skill reference links and refuses links to private or external files", (t) => {
	const { repo, output, scratch } = repository(t);
	writeFileSync(join(repo, "docs/reference.md"), "Public reference.\n");
	const skill = join(repo, "skill/SKILL.md");
	const original = readFileSync(skill, "utf8");
	writeFileSync(skill, `${original}\n[Reference][ref]\n[ref]: ../docs/reference.md\n`);
	commit(repo);
	pack(repo, output);
	assert.equal(readFileSync(join(output, "docs/reference.md"), "utf8"), "Public reference.\n");
	for (const link of ["../corpus/local/private.md", "../out/private.md", "../../private.md", "file:///private.md"]) {
		writeFileSync(skill, `${original}\n[Unsafe](${link})\n`);
		commit(repo);
		const next = join(scratch, `refused-${Buffer.from(link).toString("hex")}`);
		assert.match(pack(repo, next, 1).stderr, /leaves the public runtime sources|Non-portable local reference/);
		assert.equal(existsSync(next), false);
	}
});

test("package refuses directory junctions outside the repository", (t) => {
	const { repo, output, scratch } = repository(t);
	const external = join(scratch, "private");
	mkdirSync(external);
	writeFileSync(join(external, "private.ts"), "private\n");
	symlinkSync(external, join(repo, "src/external"), process.platform === "win32" ? "junction" : "dir");
	commit(repo);
	assert.match(pack(repo, output, 1).stderr, /leaves the public runtime sources|Payload links are refused/);
	assert.equal(existsSync(output), false);
});

test("package refuses native extensions, disguised binaries and machine paths", (t) => {
	const { repo, output } = repository(t);
	for (const [name, bytes, message] of [
		["native.node", Buffer.from("native"), /Native code/],
		["binary.ts", Buffer.from([0x4d, 0x5a, 0, 1]), /Binary payload/],
		["path.ts", Buffer.from('export const path = "D:\\\\GitHub\\\\private";\n'), /Machine path/],
	] as const) {
		const file = join(repo, "src", name);
		writeFileSync(file, bytes);
		commit(repo);
		assert.match(pack(repo, output, 1).stderr, message);
		assert.equal(existsSync(output), false);
		rmSync(file);
		commit(repo);
	}
});

test("package refuses missing or mismatched bundled dependency licences", (t) => {
	const { repo, output } = repository(t);
	const licence = join(repo, "node_modules/pend/LICENSE");
	writeFileSync(licence, "Different terms.\n");
	assert.match(pack(repo, output, 1).stderr, /licence absent from THIRD-PARTY-NOTICES/);
	rmSync(licence);
	assert.match(pack(repo, output, 1).stderr, /Missing dependency licence/);
	assert.equal(existsSync(output), false);
});

test("package requires --output and rejects unaudited dependency versions", (t) => {
	const { repo, output } = repository(t);
	assert.match(run(process.execPath, ["scripts/package.mjs"], repo, 2).stderr, /--output is required/);
	const path = join(repo, "node_modules/pend/package.json");
	const pkg = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(path, JSON.stringify({ ...pkg, version: "999.0.0" }));
	assert.match(pack(repo, output, 1).stderr, /version or notice mismatch/);
	assert.equal(existsSync(output), false);
});
