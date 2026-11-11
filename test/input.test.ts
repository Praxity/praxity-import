// Archive-safety cases adapted from Praxity Check's test/input.test.ts; src/input.ts is shared with Check.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { type Limits, openInput, UnsafeArchiveError } from "../src/input.ts";

type Entry = { name: string; data?: Buffer; method?: 0 | 8; uncompressedSize?: number; attributes?: number; crc?: number };

/** A minimal zip writer, so each case controls names, sizes and attributes exactly. */
function zip(entries: readonly Entry[]): Buffer {
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name);
		const data = entry.data ?? Buffer.alloc(0);
		const method = entry.method ?? 0;
		const crc = entry.crc ?? crc32(data);
		const size = entry.uncompressedSize ?? data.length;
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(0x800, 6);
		header.writeUInt16LE(method, 8);
		header.writeUInt32LE(crc, 14);
		header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(size, 22);
		header.writeUInt16LE(name.length, 26);
		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50, 0);
		directory.writeUInt16LE(0x0314, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt16LE(0x800, 8);
		directory.writeUInt16LE(method, 10);
		directory.writeUInt32LE(crc, 16);
		directory.writeUInt32LE(data.length, 20);
		directory.writeUInt32LE(size, 24);
		directory.writeUInt16LE(name.length, 28);
		directory.writeUInt32LE((entry.attributes ?? 0) >>> 0, 38);
		directory.writeUInt32LE(offset, 42);
		local.push(header, name, data);
		central.push(directory, name);
		offset += header.length + name.length + data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

const zeros = (size: number) => {
	const data = Buffer.alloc(size);
	return { data: deflateRawSync(data, { level: 9 }), crc: crc32(data) };
};

test("openInput refuses unsafe archives and extracts safe ones", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "praxity-import-input-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const limit = 1024 * 1024;
	const refused = async (name: string, entries: Entry[], limits: Limits = { maxTotalBytes: limit }) => {
		const archive = join(root, `${name}.zip`);
		await writeFile(archive, zip(entries));
		const error = await openInput(archive, limits).then(async (input) => (await input.cleanup(), undefined), (e: unknown) => e);
		assert.ok(error instanceof UnsafeArchiveError, `${name}: ${error instanceof Error ? error.message : "no rejection"}`);
	};

	await refused("parent path", [{ name: "../../escaped.txt", data: Buffer.from("escaped") }]);
	assert.equal(await stat(join(root, "escaped.txt")).then(() => true, () => false), false, "zip slip wrote outside the extraction root");
	await refused("posix absolute", [{ name: "/tmp/escaped.txt", data: Buffer.from("escaped") }]);
	await refused("windows absolute", [{ name: String.raw`C:\escaped.txt`, data: Buffer.from("escaped") }]);
	await refused("symlink", [{ name: "link", data: Buffer.from("../../escaped.txt"), attributes: 0xa000 << 16 }]);
	await refused("entry count", [{ name: "a/" }, { name: "b/" }, { name: "c/" }], { maxTotalBytes: limit, maxEntries: 2 });
	const bomb = zeros(limit + 1);
	// Declared sizes within the ratio cap, so the streamed-byte cap is what refuses it.
	await refused("expanded bytes", [{ name: "big.bin", data: Buffer.concat([bomb.data, Buffer.alloc(Math.ceil((limit + 1) / 100))]), method: 8, uncompressedSize: limit + 1, crc: bomb.crc }]);
	await refused("understated size", [{ name: "bomb.bin", data: bomb.data, method: 8, uncompressedSize: 1, crc: bomb.crc }]);
	const dense = zeros(2 * limit);
	await refused("compression ratio", [{ name: "dense.bin", data: dense.data, method: 8, uncompressedSize: 2 * limit, crc: dense.crc }], { maxTotalBytes: 4 * limit });

	const archive = join(root, "safe.zip");
	await writeFile(archive, zip([{ name: "course/" }, { name: "course/page.html", data: Buffer.from("<h1>Safe course</h1>") }]));
	const input = await openInput(archive);
	assert.equal(await readFile(join(input.root, "course/page.html"), "utf8"), "<h1>Safe course</h1>");
	await input.cleanup();
	await assert.rejects(stat(input.root), { code: "ENOENT" });
});
