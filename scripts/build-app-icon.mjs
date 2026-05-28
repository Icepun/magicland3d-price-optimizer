/**
 * Magicland 3D logosundan Windows .ico (256/128/64/48/32/24/16) üretir.
 * png-to-ico'nun default çıktısı küçük boyutlarda kaldığı için sharp ile
 * her boyutu önce PNG'ye dönüştürüp sonra birleştiriyoruz.
 *
 * Çalıştır:  node scripts/build-app-icon.mjs
 * Çıktı:    build/icon.ico
 */

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SOURCE = path.join(root, "public", "logo.png");
const OUT = path.join(root, "build", "icon.ico");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  console.log(`Source: ${SOURCE}`);

  // Logo'yu kare ve şeffaf arka planlı normalize et,
  // sonra her hedef boyut için resize edilmiş PNG buffer üret.
  const baseSquare = await sharp(SOURCE)
    .resize(512, 512, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  const buffers = [];
  for (const size of SIZES) {
    const buf = await sharp(baseSquare).resize(size, size).png().toBuffer();
    buffers.push(buf);
    console.log(`  ✓ ${size}x${size}`);
  }

  const ico = await pngToIco(buffers);
  await fs.writeFile(OUT, ico);
  const stat = await fs.stat(OUT);
  console.log(`\n✓ ${OUT} yazıldı (${stat.size} byte)`);
}

main().catch((err) => {
  console.error("HATA:", err);
  process.exit(1);
});
