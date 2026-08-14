import { NextRequest, NextResponse } from "next/server";
import net from "node:net";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getBambuStatusCached } from "@/core/printers/status-cache";
import { kararVer, olcAdim, type TestAsamasi, type TestSonucu } from "@/core/printers/diagnose";

export const dynamic = "force-dynamic";

/** Ağ katmanı: TCP bağlantısı açılıyor mu? (Kutu ayakta mı — yazılımı çalışmasa bile açılır.) */
function tcpDene(host: string, port: number, ms: number): Promise<{ ok: boolean; aciklama: string }> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let bitti = false;
    const kapat = (ok: boolean, aciklama: string) => {
      if (bitti) return;
      bitti = true;
      s.destroy();
      resolve({ ok, aciklama });
    };
    s.setTimeout(ms);
    s.once("connect", () => kapat(true, "Yanıt verdi"));
    s.once("timeout", () => kapat(false, "Yanıt vermedi"));
    s.once("error", (e: NodeJS.ErrnoException) =>
      kapat(false, e.code === "ECONNREFUSED" ? "Bağlantı reddedildi" : "Ağda bulunamadı"),
    );
    s.connect(port, host);
  });
}

/** HTTP katmanı: sunucu cevap veriyor mu? Hata kodu da CEVAPTIR — kutu ayakta demektir. */
async function httpDene(url: string, ms: number): Promise<{ ok: boolean; aciklama: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    return { ok: true, aciklama: r.ok ? "Yanıt verdi" : `Yanıt verdi (${r.status})` };
  } finally {
    clearTimeout(t);
  }
}

/**
 * BAĞLANTI TESTİ. Kullanıcı düğmeye basınca çalışır; hiçbir şeyi değiştirmez, yalnız okur.
 * Baskı sürerken de güvenlidir.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const cfg = await prisma.printerConfig.findUnique({
      where: { id },
      select: { host: true, port: true, brand: true, type: true, serial: true, accessCode: true },
    });
    if (!cfg?.host) {
      return NextResponse.json({
        asamalar: [],
        sonuc: "agda-yok",
        baslik: "Test yapılamadı",
        oneri: "Yazıcı bilgileri eksik.",
      } satisfies TestSonucu);
    }

    const asamalar: TestAsamasi[] = [];
    const bambu = cfg.type === "bambu" || cfg.brand === "bambu";
    const port = cfg.port ?? (bambu ? 8883 : 7125);

    if (bambu) {
      /**
       * ⚠️ 8883'Ü YOKLAMIYORUZ. Bambu aynı anda TEK MQTT istemcisi kabul ediyor; uygulamanın
       * kendi bağlantısı ayaktayken ikinci bir yoklama zaman aşımına düşüyor ve YANLIŞ ALARM
       * üretiyor. Ölçüldü (14 Ağu 2026): 8883 yoklaması "yanıt vermedi" derken aynı anda
       * "veri geliyor mu" aşaması BAŞARILI — yani kanal gayet çalışıyordu.
       * Ağ katmanı için FTPS portu (990) kullanılır: açık, paylaşımlı ve yazıcı ayaktaysa yanıtlar.
       */
      asamalar.push(await olcAdim("Yazıcı ağda mı", () => tcpDene(cfg.host, 990, 3000)));
      if (!cfg.serial || !cfg.accessCode) {
        asamalar.push({
          ad: "Kurulum bilgileri",
          durum: "hata",
          sureMs: 0,
          aciklama: "Seri no ya da erişim kodu eksik",
        });
      } else {
        // SON KATMAN — kanal açık olmak yetmez, veri GELİYOR mu? Bambu'da port açıkken de
        // oturum (kimlik doğrulama / abonelik) bozuk olabilir; o zaman sorun yazıcıda değil
        // bizim bağlantımızdadır ve kullanıcının yazıcıyı kapatıp açması işe yaramaz.
        asamalar.push(
          await olcAdim("Veri geliyor mu", async () => {
            // MQTT oturumu kurulması ~8 saniye sürebiliyor. Tek denemede "veri yok" demek,
            // uygulama az önce açıldıysa HAKSIZ suçlama olur — kısa bir pencere tanınır.
            const bitis = Date.now() + 9000;
            for (;;) {
              const st = await getBambuStatusCached(cfg.host, cfg.accessCode!, cfg.serial!);
              if (st.online) return { ok: true, aciklama: "Durum okunuyor" };
              if (Date.now() >= bitis) break;
              await new Promise((r) => setTimeout(r, 1000));
            }
            return { ok: false, aciklama: "Kanal açık ama veri yok" };
          }),
        );
      }
    } else {
      // Moonraker: kutu → web sunucusu → yazıcı yazılımı.
      asamalar.push(await olcAdim("Yazıcı ağda mı", () => tcpDene(cfg.host, port, 3000)));
      asamalar.push(
        await olcAdim("Web arayüzü", () => httpDene(`http://${cfg.host}:${port}/server/info`, 4000)),
      );
      asamalar.push(
        await olcAdim("Yazıcı yazılımı", async () => {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 4000);
          try {
            const r = await fetch(`http://${cfg.host}:${port}/printer/objects/query?print_stats`, {
              signal: ctrl.signal,
              cache: "no-store",
            });
            if (!r.ok) return { ok: false, aciklama: "Komut almıyor" };
            const j = (await r.json()) as { result?: { status?: { print_stats?: unknown } } };
            return j?.result?.status?.print_stats
              ? { ok: true, aciklama: "Komut alıyor" }
              : { ok: false, aciklama: "Beklenmedik yanıt" };
          } finally {
            clearTimeout(t);
          }
        }),
      );
    }

    return NextResponse.json({ asamalar, ...kararVer(asamalar) } satisfies TestSonucu);
  } catch (error) {
    return jsonError(error);
  }
}
