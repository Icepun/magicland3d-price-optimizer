import { NextResponse } from "next/server";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { getR2Config, getObjectHead } from "@/lib/r2";

/**
 * SLICER'IN KENDİ ÖNİZLEMESİ — gcode dosyasının başına gömülü PNG.
 *
 * OrcaSlicer/PrusaSlicer dosyanın başına render'ının base64 PNG'sini yazıyor
 * (`; thumbnail begin 800x800 …`). Kullanıcının "slicerda gördüğüm gibi" dediği görüntü
 * BİREBİR budur — biz yeniden çizmeye çalışmak yerine hazır olanı kullanabiliriz.
 *
 * Not: bu uç yalnız karşılaştırma laboratuvarı ve ileride kart görseli için. Dosyanın
 * TAMAMI okunmaz — başlıktaki birkaç yüz KB yeterli (dosyalar 140 MB olabiliyor).
 */

/** Başlıkta gömülü tüm önizlemeleri bul; en büyüğünü döndür. */
function enBuyukOnizleme(bas: string): { genislik: number; yukseklik: number; base64: string } | null {
  const re = /; thumbnail(?:_JPG|_QOI)? begin (\d+)[ x](\d+) \d+\r?\n([\s\S]*?); thumbnail(?:_JPG|_QOI)? end/gi;
  let m: RegExpExecArray | null;
  let en: { genislik: number; yukseklik: number; base64: string } | null = null;
  while ((m = re.exec(bas)) !== null) {
    const genislik = Number(m[1]);
    const yukseklik = Number(m[2]);
    // Gövde her satırın başında "; " ile yazılmış — temizle.
    const base64 = m[3].replace(/^;\s?/gm, "").replace(/\s+/g, "");
    if (!base64) continue;
    if (!en || genislik * yukseklik > en.genislik * en.yukseklik) {
      en = { genislik, yukseklik, base64 };
    }
  }
  return en;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureRuntimeSchema();
  const { id } = await params;
  try {
    const mf = await prisma.productModelFile.findUnique({ where: { id } });
    if (!mf) return NextResponse.json({ error: "Model dosyası yok" }, { status: 404 });

    // Başlıktan 2 MB yeterli: gömülü önizlemeler dosyanın en başında. Dosyalar 140 MB
    // olabildiği için TAMAMI asla okunmaz.
    const KAFA = 2 * 1024 * 1024;
    let bas = "";
    if (!mf.r2Key && fs.existsSync(mf.storedPath)) {
      const fh = await fs.promises.open(mf.storedPath, "r");
      try {
        const buf = Buffer.alloc(KAFA);
        const { bytesRead } = await fh.read(buf, 0, KAFA, 0);
        bas = buf.subarray(0, bytesRead).toString("latin1");
      } finally {
        await fh.close();
      }
    } else if (mf.r2Key) {
      const cfg = await getR2Config();
      if (!cfg) return NextResponse.json({ error: "Bulut depolama ayarlı değil" }, { status: 400 });
      bas = (await getObjectHead(mf.r2Key, cfg, KAFA)).toString("latin1");
    }
    if (!bas) return NextResponse.json({ error: "Dosya bu cihazda yok" }, { status: 404 });

    const onizleme = enBuyukOnizleme(bas);
    if (!onizleme) {
      return NextResponse.json({ error: "Bu dosyada gömülü slicer önizlemesi yok" }, { status: 404 });
    }

    return NextResponse.json({
      genislik: onizleme.genislik,
      yukseklik: onizleme.yukseklik,
      dataUrl: `data:image/png;base64,${onizleme.base64}`,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Önizleme çıkarılamadı" },
      { status: 500 }
    );
  }
}
