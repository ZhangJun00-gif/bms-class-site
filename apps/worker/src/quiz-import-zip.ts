import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import yauzl, { type Entry, type ZipFile } from "yauzl";

export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_ZIP_BYTES = 200 * 1024 * 1024;
export const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_FILES = 1_000;
const MAX_ZIP_RATIO = 100;
const MAX_PATH_LENGTH = 500;

export class QuizImportArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly filePath?: string,
  ) {
    super(message);
    this.name = "QuizImportArchiveError";
  }
}

export interface QuizZipEntry {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
}

function openZip(path: string) {
  return new Promise<ZipFile>((resolve, reject) => {
    yauzl.open(
      path,
      {
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
        autoClose: false,
      },
      (error, zip) => (error || !zip ? reject(error) : resolve(zip)),
    );
  });
}

function canonicalPath(value: string) {
  return value.normalize("NFC");
}

function validateEntry(entry: Entry) {
  const path = canonicalPath(entry.fileName);
  if (
    !path ||
    path.length > MAX_PATH_LENGTH ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new QuizImportArchiveError(
      "ZIP_UNSAFE_PATH",
      "ZIP 包含不安全路径",
      path,
    );
  }
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new QuizImportArchiveError(
      "ZIP_ENCRYPTED",
      "不支持加密 ZIP 文件",
      path,
    );
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (unixMode === 0o120000) {
    throw new QuizImportArchiveError("ZIP_SYMLINK", "ZIP 不允许符号链接", path);
  }
  const directory = path.endsWith("/");
  if (directory) {
    if (path !== "images/") {
      throw new QuizImportArchiveError(
        "ZIP_UNEXPECTED_ENTRY",
        "ZIP 只允许 images/ 目录",
        path,
      );
    }
    return { path, directory };
  }
  if (path !== "questions.csv" && !/^images\/[^/]+$/.test(path)) {
    throw new QuizImportArchiveError(
      "ZIP_UNEXPECTED_ENTRY",
      "ZIP 只允许 questions.csv 和 images/ 下的图片",
      path,
    );
  }
  const maximum = path === "questions.csv" ? MAX_CSV_BYTES : MAX_IMAGE_BYTES;
  if (entry.uncompressedSize > maximum) {
    throw new QuizImportArchiveError(
      path === "questions.csv" ? "CSV_TOO_LARGE" : "IMAGE_TOO_LARGE",
      path === "questions.csv"
        ? "questions.csv 超过 2MB 限制"
        : "图片超过 10MB 限制",
      path,
    );
  }
  if (
    entry.uncompressedSize > 0 &&
    (entry.compressedSize === 0 ||
      entry.uncompressedSize / entry.compressedSize > MAX_ZIP_RATIO)
  ) {
    throw new QuizImportArchiveError(
      "ZIP_RATIO_LIMIT",
      "ZIP 文件压缩比异常",
      path,
    );
  }
  return { path, directory };
}

export async function inspectQuizZip(path: string) {
  const entries: QuizZipEntry[] = [];
  const normalizedNames = new Set<string>();
  let uncompressedTotal = 0;
  await walkZip(path, async (entry) => {
    const validated = validateEntry(entry);
    if (validated.directory) return;
    const duplicateKey = validated.path.toLocaleLowerCase("en-US");
    if (normalizedNames.has(duplicateKey)) {
      throw new QuizImportArchiveError(
        "ZIP_DUPLICATE_ENTRY",
        "ZIP 包含重复或大小写冲突的文件名",
        validated.path,
      );
    }
    normalizedNames.add(duplicateKey);
    uncompressedTotal += entry.uncompressedSize;
    if (uncompressedTotal > MAX_UNCOMPRESSED_BYTES) {
      throw new QuizImportArchiveError(
        "ZIP_EXPANDED_TOO_LARGE",
        "ZIP 总解压大小超过 500MB 限制",
      );
    }
    entries.push({
      path: validated.path,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
    });
    if (entries.length > MAX_IMAGE_FILES + 1) {
      throw new QuizImportArchiveError(
        "ZIP_FILE_COUNT_LIMIT",
        "ZIP 文件数量超过限制",
      );
    }
  });
  if (!entries.some((entry) => entry.path === "questions.csv")) {
    throw new QuizImportArchiveError(
      "ZIP_MISSING_CSV",
      "ZIP 根目录缺少 questions.csv",
    );
  }
  const imageCount = entries.filter((entry) =>
    entry.path.startsWith("images/"),
  ).length;
  if (imageCount > MAX_IMAGE_FILES) {
    throw new QuizImportArchiveError(
      "ZIP_IMAGE_COUNT_LIMIT",
      "ZIP 图片超过 1000 张限制",
    );
  }
  return entries;
}

export async function readZipEntry(
  path: string,
  wanted: string,
  maximum: number,
) {
  let result: Buffer | null = null;
  await walkZip(path, async (entry, zip) => {
    const validated = validateEntry(entry);
    if (validated.directory || validated.path !== wanted) return;
    result = await readEntryBuffer(zip, entry, maximum);
  });
  if (!result) {
    throw new QuizImportArchiveError(
      "ZIP_MISSING_ENTRY",
      "ZIP 缺少引用文件",
      wanted,
    );
  }
  return result;
}

export async function forEachZipImage(
  path: string,
  handler: (entryPath: string, data: Buffer) => Promise<void>,
) {
  await walkZip(path, async (entry, zip) => {
    const validated = validateEntry(entry);
    if (validated.directory || !validated.path.startsWith("images/")) return;
    const data = await readEntryBuffer(zip, entry, MAX_IMAGE_BYTES);
    await handler(validated.path, data);
  });
}

async function walkZip(
  path: string,
  handler: (entry: Entry, zip: ZipFile) => Promise<void>,
) {
  const zip = await openZip(path);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      if (
        error instanceof Error &&
        /invalid relative path|absolute path|invalid characters in fileName/.test(
          error.message,
        )
      ) {
        reject(
          new QuizImportArchiveError("ZIP_UNSAFE_PATH", "ZIP 包含不安全路径"),
        );
      } else if (error) reject(error);
      else resolve();
    };
    zip.once("error", finish);
    zip.once("end", () => finish());
    zip.on("entry", (entry) => {
      void handler(entry, zip)
        .then(() => zip.readEntry())
        .catch(finish);
    });
    zip.readEntry();
  });
}

function readEntryBuffer(zip: ZipFile, entry: Entry, maximum: number) {
  return new Promise<Buffer>((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(error);
      const chunks: Buffer[] = [];
      let total = 0;
      const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          total += chunk.length;
          if (total > maximum) {
            callback(
              new QuizImportArchiveError(
                "ZIP_ENTRY_TOO_LARGE",
                "ZIP 文件解压后超过限制",
                entry.fileName,
              ),
            );
            return;
          }
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      void pipeline(stream, sink)
        .then(() => resolve(Buffer.concat(chunks, total)))
        .catch(reject);
    });
  });
}

export async function hashFileSha256(path: string) {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}
