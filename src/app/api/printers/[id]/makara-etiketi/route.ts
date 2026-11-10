import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { fetchMoonrakerStatus, moonrakerEtiketBilgisiYaz } from "@/core/printers/moonraker";
import { bumpMoonrakerStatus } from "@/core/printers/status-cache";
import { renkKodu, U1_FILAMENT_TIPLERI } from "@/core/printers/filament-tipleri";
import { filamentDetectBilgisi } from "@/core/printers/makara-etiketi";
import { makaraEtiketiKaydet } from "@/core/printers/makara-etiketi-izleyici";

export const dynamic = "force-dynamic";

const Schema = z.object({
  /** U1 kafası (0 tabanlı). */
  kanal: z.number().int().min(0).max(3),
  /** Etiket kimliği — panel yazıcının bildirdiğini aynen geri yollar. */
  uid: z.string().regex(/^[0-9A-Fa-f]{8,20}$/),
  renk: z.string().regex(/^#?[0-9a-fA-F]{6}$/),
  tip: z.string().max(20),
});

/**
 * MAKARA ETİKETİNİ TANIT / DEĞİŞTİR (U1). Eşleşme (etiket → renk + tür) uygulamada saklanır;
 * makara şu an o kafadaysa bilgi yazıcıya hemen gider, baskı sürüyorsa baskı bitince arka plan
 * uygular (makara-etiketi-izleyici). Makara sonradan nereye takılırsa takılsın rengi kendiliğinden gelir.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const girdi = Schema.parse(await req.json());
    const renk = renkKodu(girdi.renk);
    if (!renk) return NextResponse.json({ error: "Renk tanınmadı." }, { status: 400 });
    if (!(U1_FILAMENT_TIPLERI as readonly string[]).includes(girdi.tip)) {
      return NextResponse.json({ error: "Bu malzeme türü seçilemiyor." }, { status: 400 });
    }
    const cfg = await prisma.printerConfig.findUnique({ where: { id }, select: { host: true, port: true, brand: true } });
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });
    if ((cfg.brand ?? "").toLowerCase() !== "snapmaker") {
      return NextResponse.json({ error: "Makara etiketi yalnız Snapmaker U1'de kullanılabiliyor." }, { status: 400 });
    }
    const uid = girdi.uid.toUpperCase();
    const kayit = await makaraEtiketiKaydet(uid, { renk, tip: girdi.tip });

    // Makara hâlâ o kafadaysa hemen uygula (önbelleği değil yazıcının o anki hâlini oku).
    const port = cfg.port ?? 7125;
    const st = await fetchMoonrakerStatus(cfg.host, port);
    const etiket = st.online ? st.etiketler?.find((e) => e.kanal === girdi.kanal && e.uid === uid) : undefined;
    if (!etiket) return NextResponse.json({ ok: true, bekliyor: true });
    if (st.state === "printing" || st.state === "paused") return NextResponse.json({ ok: true, bekliyor: true });
    try {
      await moonrakerEtiketBilgisiYaz(cfg.host, port, girdi.kanal, filamentDetectBilgisi(etiket, kayit));
    } catch (e) {
      // Eşleşme kaydedildi; yazıcıya gidemediyse arka plan tekrar dener.
      return NextResponse.json({ error: e instanceof Error ? e.message : "Makara bilgisi gönderilemedi." }, { status: 409 });
    }
    bumpMoonrakerStatus(cfg.host, port);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
