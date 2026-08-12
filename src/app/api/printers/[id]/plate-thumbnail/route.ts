import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getMoonrakerMetaCached } from "@/core/printers/status-cache";

/**
 * Basılan plakanın dilimleyici görüntüsü (gcode'a gömülü küçük resim).
 *
 * Neden ayrı uç: Elegoo dosyalarındaki blok 800×800 (~130 KB). Panel 5 saniyede bir yenilendiği
 * için bunu JSON'a gömmek saatte yüzlerce MB gereksiz aktarım demekti. Görüntü dosya adına bağlı
 * ve DEĞİŞMEZ → uzun önbellekle bir kez indirilir.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const filename = req.nextUrl.searchParams.get("f");
    if (!filename) return NextResponse.json({ error: "Dosya belirtilmedi" }, { status: 400 });

    const cfg = await prisma.printerConfig.findUnique({ where: { id } });
    if (!cfg || cfg.type !== "moonraker") {
      return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });
    }

    const meta = await getMoonrakerMetaCached(cfg.host, cfg.port, filename);
    const dataUrl = meta?.thumbnailDataUrl;
    if (!dataUrl) return NextResponse.json({ error: "Görsel yok" }, { status: 404 });

    const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(dataUrl);
    if (!m) return NextResponse.json({ error: "Görsel okunamadı" }, { status: 404 });
    const bytes = Buffer.from(m[2], "base64");
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": m[1],
        "Content-Length": String(bytes.length),
        // Ad içerik imzası taşıdığı için aynı ad = aynı görüntü → uzun önbellek güvenli.
        "Cache-Control": "private, max-age=86400, immutable",
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
