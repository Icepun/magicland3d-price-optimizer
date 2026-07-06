import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getR2Config, deleteObject } from "@/lib/r2";

const CUSTOM_PID = "__custom__";

const Schema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });

/**
 * Özel baskıları TOPLU sil. Tek tek DELETE, dosya başına ~1sn bulut yazması demekti (100+
 * dosyada dakikalar) → tek deleteMany (tek bulut yazması) + R2 objeleri/disk dosyaları
 * sınırlı-paralel temizlenir. GÜVENLİK: yalnız __custom__ satırları silinir (ürün modellerine
 * dokunulamaz) ve dosya yalnız hiç referans kalmayınca silinir.
 */
export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const { ids } = Schema.parse(await req.json());

    // Yalnız özel baskı satırları (ürün modeli id'si sızarsa yok sayılır).
    const rows = await prisma.productModelFile.findMany({
      where: { id: { in: ids }, productId: CUSTOM_PID },
      select: { id: true, r2Key: true, storedPath: true },
    });
    if (rows.length === 0) return NextResponse.json({ deleted: 0 });

    await prisma.productModelFile.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });

    // Dosya temizliği — referans kalmadıysa (özel baskılarda paylaşım yok ama yine de kontrol).
    const r2Keys = [...new Set(rows.map((r) => r.r2Key).filter((k): k is string => !!k))];
    const paths = [...new Set(rows.map((r) => r.storedPath).filter((p) => !!p))];
    const stillUsed = r2Keys.length
      ? await prisma.productModelFile.findMany({ where: { r2Key: { in: r2Keys } }, select: { r2Key: true } })
      : [];
    const usedSet = new Set(stillUsed.map((s) => s.r2Key));
    const orphanKeys = r2Keys.filter((k) => !usedSet.has(k));

    if (orphanKeys.length) {
      const cfg = await getR2Config();
      if (cfg) {
        // Sınırlı paralel (5) — yüzlerce objeyi tek tek beklemeden, R2'yi de boğmadan.
        let i = 0;
        await Promise.all(
          Array.from({ length: Math.min(5, orphanKeys.length) }, async () => {
            while (i < orphanKeys.length) {
              const key = orphanKeys[i++];
              await deleteObject(key, cfg).catch(() => { /* R2 silme kritik değil — hademe süpürür */ });
            }
          })
        );
      }
    }
    for (const p of paths) {
      const refs = await prisma.productModelFile.count({ where: { storedPath: p } });
      if (refs === 0) { try { fs.unlinkSync(p); } catch { /* yoksa boşver */ } }
    }

    return NextResponse.json({ deleted: rows.length });
  } catch (error) {
    return jsonError(error);
  }
}
