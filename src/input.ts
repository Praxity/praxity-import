import { createWriteStream, lstatSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_RATIO = 100;

export interface Limits {
	maxTotalBytes?: number;
	maxEntries?: number;
	maxRatio?: number;
}
const RATIO_FLOOR_BYTES = 1024 * 1024;

const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

export interface Input {
	root: string;
	wasZip: boolean;
	cleanup: () => Promise<void>;
}

export class UnsafeArchiveError extends Error {}

const YAUZL_UNSAFE = /invalid relative path|absolute path|too many bytes in the stream|invalid characters in fileName/i;

function asUnsafe(err: unknown): Error {
	if (err instanceof UnsafeArchiveError) return err;
	const message = err instanceof Error ? err.message : String(err);
	return YAUZL_UNSAFE.test(message) ? new UnsafeArchiveError(message) : (err as Error);
}

function safeEntryPath(root: string, fileName: string): string {
	if (isAbsolute(fileName) || /^[a-zA-Z]:/.test(fileName)) {
		throw new UnsafeArchiveError(`archive entry has an absolute path: ${fileName}`);
	}
	if (fileName.split(/[\\/]/).includes("..")) {
		throw new UnsafeArchiveError(`archive entry escapes the root: ${fileName}`);
	}
	const dest = resolve(root, fileName);
	if (dest !== root && !dest.startsWith(root + sep)) {
		throw new UnsafeArchiveError(`archive entry escapes the root: ${fileName}`);
	}
	return dest;
}

function isSymlink(entry: yauzl.Entry): boolean {
	return ((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK;
}

async function extractZip(zipPath: string, root: string, limits: Limits = {}): Promise<void> {
	const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
	const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
	const maxRatio = limits.maxRatio ?? MAX_RATIO;
	const zip = await new Promise<yauzl.ZipFile>((ok, fail) => {
		yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, file) =>
			err ? fail(err) : ok(file),
		);
	});

	let entries = 0;
	let totalBytes = 0;

	await new Promise<void>((done, fail) => {
		const stop = (err: Error) => {
			zip.close();
			fail(err);
		};

		zip.on("error", fail);
		zip.on("end", () => done());
		zip.on("entry", (entry: yauzl.Entry) => {
			void (async () => {
				try {
					if (++entries > maxEntries) {
						throw new UnsafeArchiveError(`archive has more than ${maxEntries} entries`);
					}
					if (isSymlink(entry)) {
						throw new UnsafeArchiveError(`archive contains a symlink: ${entry.fileName}`);
					}

					const dest = safeEntryPath(root, entry.fileName);

					if (entry.fileName.endsWith("/")) {
						await mkdir(dest, { recursive: true });
						zip.readEntry();
						return;
					}

					if (
						entry.uncompressedSize > RATIO_FLOOR_BYTES &&
						entry.uncompressedSize / Math.max(entry.compressedSize, 1) > maxRatio
					) {
						throw new UnsafeArchiveError(
							`archive entry has a suspicious compression ratio: ${entry.fileName}`,
						);
					}

					await mkdir(dirname(dest), { recursive: true });
					const read = await new Promise<NodeJS.ReadableStream>((ok, no) => {
						zip.openReadStream(entry, (err, stream) => (err ? no(err) : ok(stream)));
					});

					read.on("data", (chunk: Buffer) => {
						totalBytes += chunk.length;
						if (totalBytes > maxTotalBytes) {
							read.emit(
								"error",
								new UnsafeArchiveError(`archive expands beyond ${maxTotalBytes} bytes`),
							);
						}
					});

					await pipeline(read, createWriteStream(dest));
					zip.readEntry();
				} catch (err) {
					stop(err as Error);
				}
			})();
		});

		zip.readEntry();
	});
}

export async function openInput(inputPath: string, limits: Limits = {}): Promise<Input> {
	const target = resolve(inputPath);
	const info = await stat(target);

	if (info.isDirectory()) {
		return { root: target, wasZip: false, cleanup: async () => {} };
	}

	const root = await mkdtemp(join(tmpdir(), "praxity-import-"));
	try {
		await extractZip(target, root, limits);
	} catch (err) {
		await rm(root, { recursive: true, force: true });
		throw asUnsafe(err);
	}
	return {
		root,
		wasZip: true,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

export function insidePackage(root: string, rel: string): string | undefined {
	const clean = posix.normalize(rel.split("\\").join("/"));
	if (isAbsolute(clean) || /^[a-zA-Z]:/.test(clean) || clean === ".." || clean.startsWith("../")) return undefined;
	try {
		const path = join(root, clean);
		const real = realpathSync(path);
		return lstatSync(real).isFile() && real.startsWith(realpathSync(root) + sep) ? path : undefined;
	} catch {
		return undefined;
	}
}
