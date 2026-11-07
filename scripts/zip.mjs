import { crc32, deflateRawSync } from "node:zlib";

/** @param {Array<{name: string, data: Uint8Array}>} entries */
export function createZip(entries) {
  if (entries.length > 0xffff) throw new Error("ZIP64 archives are not supported.");
  const names = new Set();
  const localParts = [];
  const directoryParts = [];
  let offset = 0;
  for (const entry of entries) {
    if (!entry.name || /[\\:]/u.test(entry.name) || [...entry.name].some((character) => character.charCodeAt(0) < 32) || entry.name.startsWith("/") ||
      entry.name.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`Unsafe ZIP entry name: ${entry.name}`);
    }
    if (names.has(entry.name)) throw new Error(`Duplicate ZIP entry: ${entry.name}`);
    names.add(entry.name);
    const name = Buffer.from(entry.name, "utf8");
    if (name.toString("utf8") !== entry.name) throw new Error(`Unsafe ZIP entry name: ${entry.name}`);
    const data = Buffer.from(entry.data);
    if (name.length > 0xffff || data.length > 0xffffffff) throw new Error("ZIP entry is too large.");
    const compressed = deflateRawSync(data, { level: 9 });
    if (compressed.length > 0xffffffff) throw new Error("ZIP entry is too large.");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(33, 12); // Fixed 1980-01-01 date keeps builds reproducible.
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, name, compressed);
    directoryParts.push(central, name);
    offset += local.length + name.length + compressed.length;
    if (offset > 0xffffffff) throw new Error("ZIP64 archives are not supported.");
  }
  const directory = Buffer.concat(directoryParts);
  if (directory.length > 0xffffffff || offset + directory.length > 0xffffffff) {
    throw new Error("ZIP64 archives are not supported.");
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}
