import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const usage = "Usage: pnpm package --output <new-directory>";
const portable = (path) => path.split(sep).join("/");
const inside = (base, path) => {
	const rel = relative(base, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const legalName = /^(?:licen[cs]e|licensing|copying|notice|copyright|third[-_]?party)(?:[._-]|$)/i;
// These audited payloads use versions from THIRD-PARTY-NOTICES.md. A dependency
// update must review its runtime files and licence before it can be distributed.
const runtimePackages = {
	parse5: { paths: ["dist"] },
	entities: { paths: ["dist"] },
	yauzl: { paths: ["index.js", "crc32.js", "fd-slicer.js"] },
	pend: { paths: ["index.js"] },
};
const legalFiles = ["LICENSE", "LICENSING.md", "NOTICE.md", "THIRD-PARTY-NOTICES.md"];

let output;
try {
	const { values } = parseArgs({ options: { output: { type: "string" }, help: { type: "boolean", short: "h" } } });
	if (values.help) { console.log(usage); process.exit(0); }
	if (!values.output?.trim()) throw new Error("--output is required.");
	output = resolve(values.output);
} catch (error) {
	console.error(`${error.message}\n${usage}`);
	process.exit(2);
}
try {
	console.log(JSON.stringify(await build(output)));
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}

async function build(directory) {
	const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
	if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("Refusing to package a dirty tree. Commit or remove changes first.");
	const revision = git("rev-parse", "HEAD");
	try {
		await lstat(directory);
		throw new Error(`Output already exists: ${directory}`);
	} catch (error) { if (error.code !== "ENOENT") throw error; }
	const tracked = new Set(git("ls-files", "-z").split("\0"));
	const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const notices = (await readFile(join(root, "THIRD-PARTY-NOTICES.md"), "utf8")).replace(/\r\n?/g, "\n");
	const payload = new Map();
	const directories = new Set();
	const linked = new Set();
	const dependencies = [];
	const allowedLocal = (path) => /^(?:src|skill|docs)(?:\/|$)/.test(path)
		|| path === "fixtures/smoke/scorm" || path.startsWith("fixtures/smoke/scorm/")
		|| [...legalFiles, "package.json"].includes(path);

	async function collect(source, target, repository = false) {
		const physical = await realpath(source);
		if (!inside(root, physical) || (repository && !allowedLocal(portable(relative(root, physical))))) {
			throw new Error(`Payload leaves the public runtime sources: ${source}`);
		}
		const info = await lstat(source);
		if (info.isSymbolicLink()) throw new Error(`Payload links are refused: ${source}`);
		if (info.isDirectory()) {
			if (/^(?:tests?|corpus|out|node_modules|\.git)$/.test(basename(source))) throw new Error(`Non-runtime directory in payload: ${source}`);
			directories.add(physical);
			for (const name of (await readdir(source)).sort()) await collect(join(source, name), join(target, name), repository);
			return;
		}
		if (!info.isFile()) throw new Error(`Payload must contain regular files: ${source}`);
		const path = portable(target);
		if (repository && !tracked.has(portable(relative(root, source)))) throw new Error(`Untracked payload file: ${source}`);
		if (/\.(?:map|d\.ts)$/i.test(path) || /\.(?:test|spec)\.[^.]+$/i.test(path)) return;
		if (/\.(?:node|exe|dll|dylib|so|a|lib|wasm)$/i.test(path) || /^(?:node|nodejs)$/i.test(basename(path))) throw new Error(`Native code or bundled runtime is refused: ${source}`);
		const raw = await readFile(source);
		// The allowlisted payload is text only. This also rejects native files
		// disguised with a source extension, rather than trusting their names.
		let text;
		try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
		catch { throw new Error(`Non-text payload is refused: ${source}`); }
		if (text.includes("\0") || raw.subarray(0, 2).toString() === "MZ" || raw.subarray(0, 4).toString() === "\x7fELF") throw new Error(`Binary payload is refused: ${source}`);
		text = text.replace(/\r\n?/g, "\n");
		if (/(?:^|[\s"'`])(?:[A-Za-z]:[\\/]|\/(?:Users|home)\/[^\s/]+\/)/m.test(text)) throw new Error(`Machine path in payload: ${source}`);
		if (payload.has(path)) {
			if (payload.get(path).source !== physical) throw new Error(`Conflicting payload path: ${path}`);
			return;
		}
		payload.set(path, { source: physical, bytes: Buffer.from(text), mode: text.startsWith("#!") ? 0o755 : 0o644 });
	}

	async function localContent(source) {
		const path = portable(relative(root, source));
		if (!inside(root, source) || !allowedLocal(path)) throw new Error(`Local reference leaves the public runtime sources: ${source}`);
		if (linked.has(source)) return;
		linked.add(source);
		if (!payload.has(path)) await collect(source, path, true);
		for (const [target, { bytes }] of [...payload]) {
			if (!target.endsWith(".md") || linked.has(`read:${target}`)) continue;
			linked.add(`read:${target}`);
			const markdown = bytes.toString();
			const links = [...markdown.matchAll(/\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g),
				...markdown.matchAll(/^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)];
			for (const match of links) {
				const href = match[1] ?? match[2];
				if (/^(?:https?:|mailto:|\/\/|#)/i.test(href)) continue;
				if (/^[a-z][a-z\d+.-]*:/i.test(href)) throw new Error(`Non-portable local reference: ${href}`);
				const link = decodeURIComponent(href.split(/[?#]/)[0]);
				if (link) await localContent(resolve(root, dirname(target), link));
			}
		}
	}

	async function dependency(name, owner, target, ancestors = new Set()) {
		const audited = runtimePackages[name];
		if (!audited) throw new Error(`Unaudited runtime dependency: ${name}`);
		let packageRoot = dirname(createRequire(join(owner, "package.json")).resolve(name));
		for (;;) {
			try {
				if (JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).name === name) break;
			} catch (error) { if (error.code !== "ENOENT") throw error; }
			const parent = dirname(packageRoot);
			if (parent === packageRoot) throw new Error(`Cannot find package metadata: ${name}`);
			packageRoot = parent;
		}
		packageRoot = await realpath(packageRoot);
		if (!inside(join(root, "node_modules"), packageRoot)) throw new Error(`Dependency outside repository node_modules: ${name}`);
		if (ancestors.has(packageRoot)) throw new Error(`Dependency cycle: ${name}`);
		const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
		if (!notices.includes(`## ${name} ${pkg.version} (${pkg.license})`)) throw new Error(`Dependency version or notice mismatch: ${name}`);
		const licences = (await readdir(packageRoot)).filter((file) => legalName.test(file));
		if (!licences.length) throw new Error(`Missing dependency licence: ${name}`);
		for (const file of licences) {
			const licence = (await readFile(join(packageRoot, file), "utf8")).replace(/\r\n?/g, "\n").trim();
			if (!notices.includes(licence)) throw new Error(`Dependency licence absent from THIRD-PARTY-NOTICES.md: ${name}`);
		}
		for (const path of ["package.json", ...audited.paths, ...licences]) await collect(join(packageRoot, path), join(target, path));
		dependencies.push({ name, version: pkg.version, license: pkg.license, path: portable(target) });
		const next = new Set([...ancestors, packageRoot]);
		for (const child of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }).sort()) await dependency(child, packageRoot, join(target, "node_modules", child), next);
	}

	for (const path of ["src", "package.json", ...legalFiles, "fixtures/smoke/scorm"]) await collect(join(root, path), path, true);
	await localContent(join(root, "skill"));
	for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) await dependency(name, root, join("node_modules", name));
	let ancestor = dirname(directory);
	let physicalOutput;
	for (;;) {
		try { physicalOutput = join(await realpath(ancestor), relative(ancestor, directory)); break; }
		catch (error) { if (error.code !== "ENOENT") throw error; ancestor = dirname(ancestor); }
	}
	if ([...directories].some((source) => inside(source, physicalOutput)) || inside(join(root, ".git"), physicalOutput) || inside(join(root, "corpus"), physicalOutput)) throw new Error("Output cannot be inside a payload source, .git or corpus.");
	// Recheck after reading; no output is created for validation failures.
	if (git("rev-parse", "HEAD") !== revision || git("status", "--porcelain", "--untracked-files=all")) throw new Error("Source tree changed while packaging.");
	await mkdir(dirname(directory), { recursive: true });
	await mkdir(directory);
	const files = [];
	for (const [path, { bytes, mode }] of [...payload].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
		const destination = join(directory, path);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, bytes, { flag: "wx", mode });
		await chmod(destination, mode);
		files.push({ path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mode });
	}
	const inventory = { schemaVersion: 1, tool: manifest.name, version: manifest.version,
		source: { revision, dirty: false }, target: { platform: "portable", arch: "portable" },
		nodeRequirement: manifest.engines.node, entry: manifest.bin[manifest.name],
		legalFiles: files.map(({ path }) => path).filter((path) => legalName.test(basename(path))),
		dependencies, inventoryExcludes: ["inventory.json"], files };
	await writeFile(join(directory, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, { flag: "wx", mode: 0o644 });
	return { ok: true, output: directory, inventory: join(directory, "inventory.json"), version: manifest.version, fileCount: files.length + 1 };
}
