/**
 * public/logo.png'den uygulama ikonlarını üretir:
 *   - build/icon.ico  (Windows: pencere, taskbar, installer, exe) — çok boyutlu
 *   - build/icon.png  (macOS: dmg/app ikonu) — 512px
 *
 * Çalıştır:  node scripts/generate-icon.mjs   (veya: npm run icon)
 */
import sharp from "sharp";
import pngToIco from "png-to-ico";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "public", "logo.png");
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

const icoSizes = [256, 128, 64, 48, 32, 16];
const pngBuffers = await Promise.all(
  icoSizes.map((s) =>
    sharp(src).resize(s, s, { fit: "contain", background: transparent }).png().toBuffer()
  )
);

await fs.mkdir(path.join(root, "build"), { recursive: true });
const ico = await pngToIco(pngBuffers);
await fs.writeFile(path.join(root, "build", "icon.ico"), ico);

await sharp(src)
  .resize(512, 512, { fit: "contain", background: transparent })
  .png()
  .toFile(path.join(root, "build", "icon.png"));

console.log(
  `✓ build/icon.ico (${icoSizes.join(",")}px, ${Math.round(ico.length / 1024)}KB) + build/icon.png (512px) üretildi`
);
