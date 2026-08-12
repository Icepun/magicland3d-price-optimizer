import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import {
  moonrakerControl, moonrakerStartExisting, moonrakerSetSpeed, moonrakerSetLight,
  moonrakerSetPauseAtLayer, moonrakerChangeFilament, fetchMoonrakerCaps, fetchMoonrakerStatus,
} from "@/core/printers/moonraker";
import { bambuControl, bambuSetSpeedLevel, BAMBU_SPEED_LEVELS } from "@/core/printers/bambu";
import { validateSpeedChange, validatePauseLayer } from "@/core/printers/controls";
import { bumpMoonrakerStatus, bumpBambuStatus } from "@/core/printers/status-cache";

/** Yetenekler o an okunamadı — "desteklemiyor" DEĞİL, "şu an bilinmiyor". */
const NOT_DISCOVERED = "Yazıcı şu an yanıt vermiyor — biraz sonra tekrar dene.";

const Schema = z.object({
  action: z.enum([
    "pause", "resume", "cancel", "start",
    "speed", "light", "pauseAtLayer", "changeFilament",
  ]),
  filename: z.string().optional(),
  /** speed: Moonraker'da yüzde (%50–200 kademeleri), Bambu'da profil (1–4). */
  speedPercent: z.number().optional(),
  speedLevel: z.number().optional(),
  /** light: true = aç, false = kapa, "toggle" = değiştir (durumu okunamayan modeller). */
  light: z.union([z.boolean(), z.literal("toggle")]).optional(),
  /** pauseAtLayer: null = duraklatmayı kaldır. */
  layer: z.number().nullable().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const body = Schema.parse(await req.json());
    const { action, filename } = body;

    const cfg = await prisma.printerConfig.findUnique({ where: { id } });
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });

    if (cfg.type === "bambu") {
      if (!cfg.accessCode || !cfg.serial) {
        return NextResponse.json({ error: "Kurulum tamamlanmadı — access code ve seri no gerekiyor." }, { status: 400 });
      }
      // MADDE 6: komut sonrası kart eski duruma zıplamasın diye önbelleği ŞİMDİDEN geçersiz kıl.
      bumpBambuStatus(cfg.host, cfg.serial);

      if (action === "start") {
        return NextResponse.json({ error: "Bambu'da uygulamadan baskı başlatma henüz desteklenmiyor" }, { status: 400 });
      }
      if (action === "speed") {
        const level = body.speedLevel;
        if (!BAMBU_SPEED_LEVELS.some((l) => l.level === level)) {
          return NextResponse.json({ error: "Bu yazıcıda hız hazır profillerden seçilir." }, { status: 400 });
        }
        const applied = await bambuSetSpeedLevel(cfg.host, cfg.accessCode, cfg.serial, level as number);
        bumpBambuStatus(cfg.host, cfg.serial);
        return NextResponse.json({ ok: true, speedLevel: applied });
      }
      if (action === "light" || action === "pauseAtLayer" || action === "changeFilament") {
        return NextResponse.json(
          { error: `${cfg.name} bu özelliği desteklemiyor — yazıcının kendi ekranından yapılabilir.` },
          { status: 400 },
        );
      }
      // await ŞART: eski fire-and-forget hali her zaman {ok:true} dönüyordu — çevrimdışı yazıcıya
      // basılan "duraklat" sessizce kayboluyordu (kullanıcı başarılı sanıyordu).
      const res = await bambuControl(cfg.host, cfg.accessCode, cfg.serial, action);
      bumpBambuStatus(cfg.host, cfg.serial);
      return NextResponse.json({ ok: true, verified: res.verified, state: res.state });
    }

    if (cfg.type !== "moonraker") {
      return NextResponse.json({ error: "Bu yazıcı tipi için kontrol desteklenmiyor" }, { status: 400 });
    }

    bumpMoonrakerStatus(cfg.host, cfg.port);

    if (action === "start") {
      if (!filename) return NextResponse.json({ error: "Dosya seçilmedi" }, { status: 400 });
      // Marka-doğru başlatma: Snapmaker U1 native WITH_PARAMETERS akışına girmezse sahte
      // "filament runout" (id=523) verir — düz moonrakerStart bu yüzden yeterli değil.
      await moonrakerStartExisting(cfg.host, cfg.port, filename, cfg.brand);
      bumpMoonrakerStatus(cfg.host, cfg.port);
      return NextResponse.json({ ok: true });
    }

    if (action === "speed") {
      // MADDE 10: sınır SUNUCUDA. Arayüz düğmeyi kısıtlasa da telefon/eski sürüm buraya
      // serbest sayı gönderebilir; tek geçerli kapı burası.
      const live = await fetchMoonrakerStatus(cfg.host, cfg.port);
      if (!live.online) return NextResponse.json({ error: "Yazıcıya ulaşılamadı." }, { status: 400 });
      const check = validateSpeedChange(body.speedPercent, live.speedPercent);
      if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
      const applied = await moonrakerSetSpeed(cfg.host, cfg.port, check.value);
      bumpMoonrakerStatus(cfg.host, cfg.port);
      return NextResponse.json({ ok: true, speedPercent: applied });
    }

    if (action === "light") {
      const caps = await fetchMoonrakerCaps(cfg.host, cfg.port);
      // "Keşfedilemedi" ile "desteklenmiyor" AYRI: yazıcı o an yanıt vermediyse kullanıcıya
      // yanlış kesinlikle "yazıcın bunu desteklemiyor" denmemeli.
      if (!caps.discovered) return NextResponse.json({ error: NOT_DISCOVERED }, { status: 503 });
      if (caps.lightKind === "none") {
        return NextResponse.json({ error: `${cfg.name} için uygulamadan ışık kontrolü yok.` }, { status: 400 });
      }
      const want = body.light ?? "toggle";
      const state = await moonrakerSetLight(cfg.host, cfg.port, want);
      bumpMoonrakerStatus(cfg.host, cfg.port);
      return NextResponse.json({ ok: true, light: state });
    }

    if (action === "pauseAtLayer") {
      const caps = await fetchMoonrakerCaps(cfg.host, cfg.port);
      if (!caps.discovered) return NextResponse.json({ error: NOT_DISCOVERED }, { status: 503 });
      if (!caps.pauseAtLayer) {
        return NextResponse.json({ error: `${cfg.name} katmanda duraklatmayı desteklemiyor.` }, { status: 400 });
      }
      // "Alan gönderilmedi" ≠ "kaldır". Eskiden ikisi de ayarı SİLİYORDU: layer alanı olmadan
      // gelen bir istek, kullanıcının kurduğu katman duraklatmasını sessizce kaldırıyordu.
      if (body.layer === undefined) {
        return NextResponse.json({ error: "Katman belirtilmedi." }, { status: 400 });
      }
      const layer = body.layer;
      if (layer != null) {
        const live = await fetchMoonrakerStatus(cfg.host, cfg.port);
        const check = validatePauseLayer(layer, live.currentLayer, live.totalLayer);
        if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
        await moonrakerSetPauseAtLayer(cfg.host, cfg.port, check.value);
      } else {
        await moonrakerSetPauseAtLayer(cfg.host, cfg.port, null);
      }
      bumpMoonrakerStatus(cfg.host, cfg.port);
      return NextResponse.json({ ok: true, pauseAtLayer: layer });
    }

    if (action === "changeFilament") {
      const caps = await fetchMoonrakerCaps(cfg.host, cfg.port);
      if (!caps.discovered) return NextResponse.json({ error: NOT_DISCOVERED }, { status: 503 });
      if (!caps.filamentChange) {
        return NextResponse.json({ error: `${cfg.name} filament değişimini desteklemiyor.` }, { status: 400 });
      }
      await moonrakerChangeFilament(cfg.host, cfg.port);
      bumpMoonrakerStatus(cfg.host, cfg.port);
      return NextResponse.json({ ok: true });
    }

    // MADDE 9: pause/resume/cancel artık DURUMDAN doğrulanıyor; zaman aşımına uğrayan istek
    // yüzünden kullanıcıya ham İngilizce hata düşmüyor.
    const res = await moonrakerControl(cfg.host, cfg.port, action);
    bumpMoonrakerStatus(cfg.host, cfg.port);
    return NextResponse.json({ ok: true, verified: res.verified, state: res.state });
  } catch (error) {
    return jsonError(error);
  }
}
