import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  inspectQuizZip,
  QuizImportArchiveError,
  readZipEntry,
} from "./quiz-import-zip";

interface ZipEntryInput {
  name: string;
  data?: Buffer;
  deflate?: boolean;
  encrypted?: boolean;
  unixMode?: number;
}

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: ZipEntryInput[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data ?? Buffer.alloc(0);
    const content = entry.deflate ? deflateRawSync(data) : data;
    const compressed = entry.encrypted
      ? Buffer.concat([Buffer.alloc(12), content])
      : content;
    const method = entry.deflate ? 8 : 0;
    const flags = entry.encrypted ? 1 : 0;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.unixMode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

describe("quiz import ZIP security", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), "bmc3-quiz-zip-"));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function write(entries: ZipEntryInput[]) {
    const path = join(directory, "package.zip");
    await fs.writeFile(path, zip(entries));
    return path;
  }

  it("streams the allowed package structure and reads only the requested entry", async () => {
    const csv = Buffer.from("subject,prompt\n生理学,题目", "utf8");
    const path = await write([
      { name: "questions.csv", data: csv },
      { name: "images/a.png", data: Buffer.from("image") },
    ]);

    await expect(inspectQuizZip(path)).resolves.toEqual([
      expect.objectContaining({ path: "questions.csv" }),
      expect.objectContaining({ path: "images/a.png" }),
    ]);
    await expect(
      readZipEntry(path, "questions.csv", 2 * 1024 * 1024),
    ).resolves.toEqual(csv);
  });

  it.each([
    ["ZIP_UNSAFE_PATH", [{ name: "questions.csv" }, { name: "../escape.png" }]],
    [
      "ZIP_DUPLICATE_ENTRY",
      [
        { name: "questions.csv" },
        { name: "images/a.png" },
        { name: "images/A.PNG" },
      ],
    ],
    [
      "ZIP_SYMLINK",
      [
        { name: "questions.csv" },
        { name: "images/link.png", unixMode: 0o120777 },
      ],
    ],
    [
      "ZIP_ENCRYPTED",
      [{ name: "questions.csv", data: Buffer.from("csv"), encrypted: true }],
    ],
    ["ZIP_MISSING_CSV", [{ name: "images/a.png" }]],
    [
      "ZIP_RATIO_LIMIT",
      [
        { name: "questions.csv" },
        { name: "images/a.png", data: Buffer.alloc(20_000), deflate: true },
      ],
    ],
  ])("rejects unsafe archives with %s", async (code, entries) => {
    const path = await write(entries as ZipEntryInput[]);
    await expect(inspectQuizZip(path)).rejects.toMatchObject<
      Partial<QuizImportArchiveError>
    >({ code });
  });
});
