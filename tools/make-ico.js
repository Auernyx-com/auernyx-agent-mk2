/*
 * Minimal PNG->ICO generator (single-image) for Windows shortcuts.
 * ICO supports embedding PNG images (Vista+).
 *
 * Usage:
 *   node tools/make-ico.js "clients/vscode/aeurnyx socal face.png" assets/auernyx.ico
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");

function loadLauncherConfig(cwd) {
  const p = path.resolve(cwd, "tools", "launcher.config.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readPngSize(pngBuffer) {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  const sig = pngBuffer.subarray(0, 8);
  const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!sig.equals(expected)) throw new Error("Input is not a PNG (bad signature)");

  // IHDR chunk starts at offset 8:
  // length (4) + type (4) + data (13) + crc (4)
  const ihdrType = pngBuffer.subarray(12, 16).toString("ascii");
  if (ihdrType !== "IHDR") throw new Error("PNG missing IHDR chunk at expected offset");

  const width = pngBuffer.readUInt32BE(16);
  const height = pngBuffer.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid PNG dimensions: ${width}x${height}`);
  }
  return { width, height };
}

function toIcoDirByte(n) {
  // ICO stores 0 to represent 256.
  if (n >= 256) return 0;
  if (n < 0) return 0;
  return n & 0xff;
}

function makePngIco(pngBuffers) {
  if (!Array.isArray(pngBuffers) || pngBuffers.length === 0) {
    throw new Error("No PNG images provided");
  }

  const count = pngBuffers.length;
  const headerSize = 6;
  const entrySize = 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);

  let offset = headerSize + entrySize * count;
  const entries = [];
  const images = [];

  for (const pngBuffer of pngBuffers) {
    const { width, height } = readPngSize(pngBuffer);
    const entry = Buffer.alloc(entrySize);
    entry.writeUInt8(toIcoDirByte(width), 0);
    entry.writeUInt8(toIcoDirByte(height), 1);
    entry.writeUInt8(0, 2); // color count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bit count
    entry.writeUInt32LE(pngBuffer.length, 8); // bytes in resource
    entry.writeUInt32LE(offset, 12); // image offset

    entries.push(entry);
    images.push(pngBuffer);
    offset += pngBuffer.length;
  }

  return Buffer.concat([header, ...entries, ...images]);
}

function resizePngsWindows(absInPng, sizes, tempDir) {
  const resizeScript = path.resolve(process.cwd(), "tools", "resize-png.ps1");
  if (!fs.existsSync(resizeScript)) throw new Error(`Missing resize script: ${resizeScript}`);

  const sizeArg = sizes.join(",");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    resizeScript,
    "-InPng",
    absInPng,
    "-OutDir",
    tempDir,
    "-Sizes",
    sizeArg
  ];

  const res = cp.spawnSync("powershell.exe", args, { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`resize-png.ps1 failed (exit ${res.status})`);

  const pngBuffers = [];
  for (const s of sizes) {
    const p = path.join(tempDir, `${s}.png`);
    if (!fs.existsSync(p)) throw new Error(`Expected resized PNG missing: ${p}`);
    pngBuffers.push(fs.readFileSync(p));
  }
  return pngBuffers;
}

function main() {
  const cfg = loadLauncherConfig(process.cwd());
  const defaultIn = cfg?.iconSourcePng || path.join("clients", "vscode", "aeurnyx socal face.png");
  const defaultOut = cfg?.iconPath || path.join("assets", "auernyx.ico");

  const inPath = process.argv[2] || defaultIn;
  const outPath = process.argv[3] || defaultOut;

  const absIn = path.resolve(process.cwd(), inPath);
  const absOut = path.resolve(process.cwd(), outPath);

  if (!fs.existsSync(absIn)) throw new Error(`Input PNG not found: ${absIn}`);

  // Multi-size ICO is the Windows-friendly option.
  // Sizes: 16, 24, 32, 48, 64, 128, 256
  const sizes = [16, 24, 32, 48, 64, 128, 256];

  let pngs;
  if (process.platform === "win32") {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "auernyx-ico-"));
    try {
      pngs = resizePngsWindows(absIn, sizes, tempDir);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  } else {
    // Fallback: single image if not on Windows.
    pngs = [fs.readFileSync(absIn)];
  }

  const ico = makePngIco(pngs);

  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  fs.writeFileSync(absOut, ico);

  console.log(`[make-ico] Wrote ${absOut} (${ico.length} bytes) from ${absIn}`);
}

try {
  main();
} catch (err) {
  console.error(`[make-ico] ERROR: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
}
