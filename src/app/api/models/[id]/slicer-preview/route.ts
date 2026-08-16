import { NextResponse } from "next/server";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { getR2Config, getObjectRange, getObjectSize, getObjectHead } from "@/lib/r2";
import {
  gcodeOnizlemesi,
  zip3mfOnizlemesi,
  type AralikOkuyucu,
} from "@/lib/slicer-preview";

/**
 * SLICER'IN KENDİ ÖNİZLEMESİ — doğrudan PNG döner.
 *
 * Kartlardaki model görseli artık bu: kendi çizimimiz baskı yollarını çiziyordu ve model
 * beyaz bir siluetten ibaret kalıyordu; slicer ise gerçek yüzeyi ışıklandırılmış hâlde
 * dosyaya gömüyor (bkz. `lib/slicer-preview.ts`).
 *
 * ⚠️ Dosyanın TAMAMI okunmaz. Gcode'da ilk 2 MB, 3MF'te zip dizini + yalnız ilgili girdi.
 *
 * Önbellek: model dosyası içeriğiyle birlikte değişmez (id içerik md5'ine bağlı), bu yüzden
 * `immutable` verilebilir — kart her açılışta yeniden indirmez.
 */

const KAFA = 2 * 1024 * 1024;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureRuntimeSchema();
  const { id } = await params;
  try {
    const mf = await prisma.productModelFile.findUnique({ where: { id } });
    if (!mf) return NextResponse.json({ error: "Model dosyası yok" }, { status: 404 });

    const ad = (mf.originalName || mf.storedPath || "").toLowerCase();
    const uc3mf = ad.endsWith(".3mf");

    let png: Buffer | null = null;

    if (!mf.r2Key && fs.existsSync(mf.storedPath)) {
      const fh = await fs.promises.open(mf.storedPath, "r");
      try {
        const oku: AralikOkuyucu = async (a, b) => {
          const uz = b - a + 1;
          const buf = Buffer.alloc(uz);
          const { bytesRead } = await fh.read(buf, 0, uz, a);
          return buf.subarray(0, bytesRead);
        };
        if (uc3mf) {
          const boy = (await fs.promises.stat(mf.storedPath)).size;
          png = (await zip3mfOnizlemesi(oku, boy))?.png ?? null;
        } else {
          const bas = (await oku(0, KAFA - 1)).toString("latin1");
          png = gcodeOnizlemesi(bas)?.png ?? null;
        }
      } finally {
        await fh.close();
      }
    } else if (mf.r2Key) {
      const cfg = await getR2Config();
      if (!cfg) return NextResponse.json({ error: "Bulut depolama ayarlı değil" }, { status: 400 });
      if (uc3mf) {
        const boy = await getObjectSize(mf.r2Key, cfg);
        const oku: AralikOkuyucu = (a, b) => getObjectRange(mf.r2Key!, cfg, a, b);
        png = (await zip3mfOnizlemesi(oku, boy))?.png ?? null;
      } else {
        const bas = (await getObjectHead(mf.r2Key, cfg, KAFA)).toString("latin1");
        png = gcodeOnizlemesi(bas)?.png ?? null;
      }
    }

    if (!png) {
      return NextResponse.json({ error: "Bu dosyada gömülü slicer önizlemesi yok" }, { status: 404 });
    }

    return new Response(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(png.length),
        // Dosya içeriği değişmez → görsel de değişmez.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Önizleme çıkarılamadı" },
      { status: 500 }
    );
  }
}
