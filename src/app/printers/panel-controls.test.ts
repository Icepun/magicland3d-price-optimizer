/**
 * Yazıcı kartının KONTROL kararları.
 *
 * Sahada ölçülen sorunlar: duraklamış yazıcıda düğme hâlâ "Duraklat" diyordu (sunucu reddediyor),
 * Snapmaker %150'de basarken kart hızı hiç göstermiyordu, iptal onayı %8 ile %92'ye aynı cümleyi
 * yazıyordu, hangi yazıcının önce boşalacağını görmek için dört kartı okumak gerekiyordu.
 */
import { describe, expect, it } from "vitest";
import { SPEED_PRESETS_PCT } from "@/core/printers/controls";
import {
  cancelSummary,
  parcaIptalDurumu,
  clampLayerValue,
  layerStepTarget,
  nextFinishing,
  pauseLayerRange,
  spentGramsText,
  pausedReminder,
  pendingBadgeLabel,
  resolveSpeedView,
  slotToolColors,
  transportControls,
  troubleList,
} from "./panel-controls";
import type { PanelPrinter, PrinterJob } from "./panel-view";

const CAPS: PanelPrinter["caps"] = {
  pauseResume: true, speed: true, light: true, lightReadable: true,
  pauseAtLayer: true, filamentChange: true, defectDetection: false,
};

function job(over: Partial<PrinterJob> = {}): PrinterJob {
  return {
    productName: "Ejderha", productImage: null,
    startedAt: new Date(0).toISOString(), endsAt: new Date(0).toISOString(),
    progress: 0.5, remainingSec: 600, layerCurrent: 100, layerTotal: 400,
    filamentType: "PLA", filamentColor: "#112233",
    remainingKnown: true, progressSource: "slicer", etaSource: "slicer",
    plateThumbnail: null, storeImage: null, filamentGrams: null, activeSlots: [],
    live: { filePosition: null, fileSize: null, zHeight: null, nozzleX: null, nozzleY: null },
    ...over,
  };
}

/** Gerçek uygulamada kademeler her zaman SPEED_PRESETS_PCT — kurgu da onu kullansın. */
const PRESETS = SPEED_PRESETS_PCT;

function printer(over: Partial<PanelPrinter> = {}): PanelPrinter {
  return {
    id: "p1", name: "Snapmaker U1", brand: "snapmaker", model: "U1", accent: "#ff8800",
    type: "moonraker", status: "printing", online: true, note: null, connection: "ok",
    statusMessage: null, warnings: [], currentFilename: "a.gcode", matchedProductId: null,
    temps: { nozzle: 220, nozzleTarget: 220, bed: 60, bedTarget: 60 },
    caps: CAPS,
    speed: { percent: 150, presets: PRESETS, levels: null, level: null },
    light: { supported: true, readable: true, on: false },
    pauseAtLayer: null, defectWatch: null, slots: [], job: job(),
    ...over,
  };
}

describe("MADDE 6 — taşıma düğmeleri", () => {
  it("duraklamışken 'Duraklat' ETKİSİZ, 'Devam et' etkin", () => {
    const c = transportControls({ status: "paused", online: true, connection: "ok", type: "moonraker", caps: CAPS });
    expect(c.canPause).toBe(false);
    expect(c.canResume).toBe(true);
    expect(c.canCancel).toBe(true);
  });

  it("yazdırırken 'Devam et' ETKİSİZ (sunucu reddederdi)", () => {
    const c = transportControls({ status: "printing", online: true, connection: "ok", type: "moonraker", caps: CAPS });
    expect(c.canPause).toBe(true);
    expect(c.canResume).toBe(false);
    expect(c.canStart).toBe(false);
  });

  it("boştayken yalnız 'Baskı Başlat'", () => {
    const c = transportControls({ status: "idle", online: true, connection: "ok", type: "moonraker", caps: CAPS });
    expect(c).toEqual({ canPause: false, canResume: false, canCancel: false, canStart: true });
  });

  it("çevrimdışı / kurulmamış yazıcıda hiçbir komut yok", () => {
    expect(transportControls({ status: "printing", online: false, connection: "offline", type: "moonraker", caps: CAPS }).canCancel).toBe(false);
    expect(transportControls({ status: "idle", online: true, connection: "unconfigured", type: "moonraker", caps: CAPS }).canStart).toBe(false);
  });

  it("caps okunamadıysa düğme GİZLENMEZ — son bilinen davranışla çizilir", () => {
    const c = transportControls({ status: "printing", online: true, connection: "ok", type: "moonraker", caps: undefined });
    expect(c.canPause).toBe(true);
  });

  it("ara durumda rozet 'oldu mu?' bırakmaz", () => {
    expect(pendingBadgeLabel("pause")).toBe("Duraklatılıyor…");
    expect(pendingBadgeLabel(null)).toBeNull();
  });
});

describe("MADDE 10 — hız", () => {
  it("Snapmaker %150'de: ORTAK ad yazar, bir aşağı kademe etkin", () => {
    // Kademeler beşe indi (%50-150) ve rozet yüzde yerine ortak adı gösteriyor:
    // üç marka aynı dili konuşsun diye. %150 en üst kademe → yukarı yön ETKİSİZ.
    const v = resolveSpeedView({ caps: CAPS, speed: printer().speed });
    expect(v).not.toBeNull();
    expect(v!.label).toBe("Çok hızlı");
    expect(v!.down).toBe(125);
    expect(v!.up).toBeNull();
  });

  it("uçlarda taşan yön ETKİSİZ", () => {
    const at150 = resolveSpeedView({ caps: CAPS, speed: { percent: 150, presets: PRESETS, levels: null, level: null } });
    expect(at150!.up).toBeNull();
    expect(at150!.down).toBe(125);
    const at50 = resolveSpeedView({ caps: CAPS, speed: { percent: 50, presets: PRESETS, levels: null, level: null } });
    expect(at50!.down).toBeNull();
  });

  it("kademe dışı değerde ham yüzde yazılır, yalnız ±%25 içindeki kademeler sunulur", () => {
    // Yazıcı kendi ekranından %137'ye çekilmişse uydurma ad koyma, olduğu gibi yaz.
    const v = resolveSpeedView({ caps: CAPS, speed: { percent: 137, presets: PRESETS, levels: null, level: null } });
    expect(v!.label).toBe("%137");
    expect(v!.down).toBe(125);
    expect(v!.up).toBe(150);
  });

  it("Bambu'da yüzde değil profil gösterilir", () => {
    const v = resolveSpeedView({
      caps: CAPS,
      speed: {
        percent: 124, presets: [], level: 3,
        levels: [
          { level: 1, label: "Sessiz", pct: 50 },
          { level: 2, label: "Standart", pct: 100 },
          { level: 3, label: "Hızlı", pct: 124 },
          { level: 4, label: "Çok hızlı", pct: 166 },
        ],
      },
    });
    expect(v!.kind).toBe("level");
    expect(v!.label).toBe("Hızlı");
    expect(v!.down).toBe(2);
    expect(v!.up).toBe(4);
  });

  it("hız desteklenmiyorsa ya da değer okunmadıysa hiç çizilmez", () => {
    expect(resolveSpeedView({ caps: { ...CAPS, speed: false }, speed: printer().speed })).toBeNull();
    expect(resolveSpeedView({ caps: CAPS, speed: { percent: null, presets: [100], levels: null, level: null } })).toBeNull();
  });

  // Moonraker hızı boştayken de bildiriyor → rozet hiç değişmeden dört kartta duruyordu.
  it("varsayılan hız rozet üretmez, ayarlı hız üretir", () => {
    const at = (percent: number) =>
      resolveSpeedView({ caps: CAPS, speed: { percent, presets: [50, 75, 100, 125, 150], levels: null, level: null } })!;
    expect(at(100).atDefault).toBe(true);
    expect(at(150).atDefault).toBe(false);
  });

  it("Bambu'da standart profil varsayılan sayılır", () => {
    const levels = [
      { level: 1, label: "Sessiz", pct: 50 },
      { level: 2, label: "Standart", pct: 100 },
      { level: 3, label: "Hızlı", pct: 124 },
    ];
    const view = (level: number) =>
      resolveSpeedView({ caps: CAPS, speed: { percent: null, presets: [], levels, level } })!;
    expect(view(2).atDefault).toBe(true);
    expect(view(3).atDefault).toBe(false);
  });
});

describe("MADDE 17 — katmanda duraklat aralığı", () => {
  it("aralık geçilmiş katmandan SONRA başlar", () => {
    const r = pauseLayerRange(job({ layerCurrent: 448, layerTotal: 1333 }));
    expect(r).toEqual({ min: 449, max: 1333, suggested: 453 });
  });

  it("son katmandayken kurulacak katman kalmaz", () => {
    expect(pauseLayerRange(job({ layerCurrent: 1333, layerTotal: 1333 }))).toBeNull();
  });

  it("toplam katman bilinmiyorsa seçici açılmaz", () => {
    expect(pauseLayerRange(job({ layerCurrent: 10, layerTotal: 0 }))).toBeNull();
    expect(pauseLayerRange(null)).toBeNull();
  });

  it("öneri hiçbir zaman toplamı aşmaz", () => {
    expect(pauseLayerRange(job({ layerCurrent: 99, layerTotal: 100 }))!.suggested).toBe(100);
  });

  // Sahada ölçülen: U1 282/1333'teyken kaydırıcı 1200'e sürüklenip "+100"e basılınca değer
  // 1200 → 382'ye DÜŞÜYORDU; "Kur"a basınca baskı 900 katman erken durup bekliyordu.
  it("hızlı adımlar GERÇEKTEN ekler — değeri aralığın başına atmaz", () => {
    const r = pauseLayerRange(job({ layerCurrent: 282, layerTotal: 1333 }))!;
    expect(layerStepTarget(1200, 100, r)).toBe(1300);
    expect(layerStepTarget(1200, 25, r)).toBe(1225);
    expect(layerStepTarget(1200, 5, r)).toBe(1205);
  });

  it("adım tavanı aşmaz ve tavanda ölü tık üretmez", () => {
    const r = pauseLayerRange(job({ layerCurrent: 282, layerTotal: 1333 }))!;
    expect(layerStepTarget(1300, 100, r)).toBe(1333);
    expect(layerStepTarget(1333, 5, r)).toBe(1333); // hedef = değer → düğme etkisiz çizilir
  });

  it("açılış değerine basılan '+5' artık ÖLÜ DEĞİL", () => {
    const r = pauseLayerRange(job({ layerCurrent: 282, layerTotal: 1333 }))!;
    expect(layerStepTarget(r.suggested, 5, r)).toBe(r.suggested + 5);
  });

  // Seçici açıkken baskı ilerliyor: sunucu `validatePauseLayer` ile "Bu katman geçildi" diyor.
  it("baskı ilerlediyse seçili katman ileri taşınır", () => {
    const r = pauseLayerRange(job({ layerCurrent: 470, layerTotal: 1333 }))!;
    expect(clampLayerValue(453, r)).toBe(471);
    expect(clampLayerValue(9999, r)).toBe(1333);
    expect(clampLayerValue(600, r)).toBe(600);
    expect(clampLayerValue(Number.NaN, r)).toBe(r.suggested);
  });
});

describe("MADDE 15 — iptal onayı neyi kaybettiğini söyler", () => {
  const nowMs = 3 * 3600_000; // baskı 3 saat önce başladı

  it("%92 / 18 dk kalmış baskı 'bitmek üzere' uyarısı alır", () => {
    const s = cancelSummary({
      job: job({ progress: 0.92, remainingSec: 1080, filamentGrams: 128, endsAt: new Date(nowMs + 1080_000).toISOString() }),
      nowMs, paused: false,
    });
    expect(s.pct).toBe(92);
    expect(s.nearFinish).toBe(true);
    // Dilimleyicinin sayısı baskının TOPLAMI; iptalde kaybedilen kısmı yazıyoruz.
    expect(s.gramsText).toBe("~118 g harcandı");
    expect(s.elapsedText).toBe("3sa 0dk");
    expect(s.remainingText).toBe("18dk 00sn");
  });

  it("%8 / 11 saat kalmış baskı AYNI cümleyi görmez", () => {
    const s = cancelSummary({
      job: job({ progress: 0.08, remainingSec: 39600, endsAt: new Date(nowMs + 39600_000).toISOString() }),
      nowMs, paused: false,
    });
    expect(s.pct).toBe(8);
    expect(s.nearFinish).toBe(false);
    expect(s.remainingText).toBe("11sa 0dk");
  });

  it("BİLİNMEYEN ≠ SIFIR: kalan süre bilinmiyorsa metin yazılmaz", () => {
    const s = cancelSummary({ job: job({ remainingKnown: false }), nowMs, paused: false });
    expect(s.remainingText).toBeNull();
  });

  it("gramaj bildirilmemişse çip çıkmaz", () => {
    expect(cancelSummary({ job: job({ filamentGrams: null }), nowMs, paused: false }).gramsText).toBeNull();
    expect(cancelSummary({ job: null, nowMs, paused: false }).pct).toBeNull();
  });

  // %30'unda iptal edilen 128 g'lık baskıda çöpe giden ~38 g. Etiketsiz "128 g" kullanıcıya
  // üç kat fazla kayıp gösterip bozuk baskıyı iptal etmekten VAZGEÇİRİYORDU.
  it("iptalde harcanan gösterilir, baskının toplamı değil", () => {
    expect(spentGramsText(128, 30)).toBe("~38 g harcandı");
    expect(spentGramsText(128, 100)).toBe("~128 g harcandı");
  });

  it("yüzde bilinmiyorsa toplam olduğu AÇIKÇA yazılır", () => {
    expect(spentGramsText(128, null)).toBe("toplam 128 g");
    expect(spentGramsText(0, 30)).toBeNull();
    expect(spentGramsText(null, 30)).toBeNull();
  });

  it("duraklatılmışta anlık snapshot kullanılır (endsAt ileri kayıyor)", () => {
    const s = cancelSummary({
      job: job({ remainingSec: 900, endsAt: new Date(nowMs + 99_000_000).toISOString() }),
      nowMs, paused: true,
    });
    expect(s.remainingText).toBe("15dk 00sn");
  });
});

describe("MADDE 18 — üst özet", () => {
  const nowMs = 1_000_000;

  it("sıradaki bitiş EN YAKIN baskıdır", () => {
    const a = printer({ id: "a", name: "Neptune", job: job({ endsAt: new Date(nowMs + 3600_000).toISOString() }) });
    const b = printer({ id: "b", name: "Snapmaker", job: job({ endsAt: new Date(nowMs + 600_000).toISOString() }) });
    expect(nextFinishing([a, b], nowMs)).toEqual({ id: "b", name: "Snapmaker", remainingSec: 600 });
  });

  it("kalan süresi bilinmeyen baskı sıraya girmez (uydurma sıra yok)", () => {
    const a = printer({ id: "a", job: job({ remainingKnown: false, endsAt: new Date(nowMs + 60_000).toISOString() }) });
    expect(nextFinishing([a], nowMs)).toBeNull();
  });

  it("sorunlar en ağırdan sıralanır", () => {
    const ok = printer({ id: "ok" });
    const paused = printer({ id: "pz", name: "Duran", status: "paused" });
    const dead = printer({ id: "dd", name: "Kopuk", online: false, connection: "offline" });
    const list = troubleList([ok, paused, dead]);
    expect(list.map((t) => t.id)).toEqual(["dd", "pz"]);
    expect(list[0].severe).toBe(true);
  });

  it("örnek (sim) kartlar sorun sayılmaz", () => {
    expect(troubleList([printer({ type: "sim", status: "error" })])).toHaveLength(0);
  });

  it("20 dakikayı geçen duraklatma hatırlatılır, öncesi sessiz", () => {
    expect(pausedReminder(nowMs - 19 * 60_000, nowMs)).toBeNull();
    // Damga "ilk görüldüğü an" olduğu için süre ALT SINIR olarak yazılır.
    expect(pausedReminder(nowMs - 23 * 60_000, nowMs)).toBe("En az 23 dakikadır duraklatılmış");
    expect(pausedReminder(nowMs - 3 * 3600_000, nowMs)).toBe("En az 3 saattir duraklatılmış");
    expect(pausedReminder(null, nowMs)).toBeNull();
  });
});

describe("MADDE 11 — izleyiciye gerçek filament renkleri", () => {
  it("dizin = kafa indeksi", () => {
    const colors = slotToolColors([
      { slot: 0, color: "#112233", type: "PLA", empty: false },
      { slot: 2, color: "#AABBCC", type: "PETG", empty: false },
    ]);
    expect(colors).toEqual(["#112233", null, "#AABBCC"]);
  });

  it("boş slot ve okunamayan renk dosyanın rengine bırakılır", () => {
    const colors = slotToolColors([
      { slot: 0, color: "#112233", type: "", empty: true },
      { slot: 1, color: "kırmızı", type: "PLA", empty: false },
    ]);
    expect(colors).toEqual([null, null]);
  });

  it("slot yoksa boş dizi", () => {
    expect(slotToolColors(undefined)).toEqual([]);
  });

  /**
   * Gcode `T<n>` MANTIKSAL indeks yazar, yazıcının renkleri FİZİKSEL kafaya aittir. Eşleme
   * uygulanmazsa 3B görünüm yanlış makaranın rengini boyar. Canlı U1 ölçümü (14 Ağu 2026):
   * `extruder_map_table = [0,1,2,3,0,0,…]`, `filament_color_rgba` = kahve/kırmızı/siyah/beyaz.
   */
  const U1_SLOTLAR = [
    { slot: 0, color: "#6F4C2F", type: "PLA", empty: false },
    { slot: 1, color: "#E72F1D", type: "PLA", empty: false },
    { slot: 2, color: "#000000", type: "PLA", empty: false },
    { slot: 3, color: "#FFFFFF", type: "PLA", empty: false },
  ];

  it("eşleme KİMLİK ise renkler olduğu gibi kalır (gerçek U1 tablosu)", () => {
    expect(slotToolColors(U1_SLOTLAR, [0, 1, 2, 3])).toEqual(["#6F4C2F", "#E72F1D", "#000000", "#FFFFFF"]);
  });

  it("eşleme KAYDIRILMIŞSA mantıksal takım doğru kafanın rengini alır", () => {
    // Dilimleyicinin 0. filamenti 3. kafaya, 1. filamenti 2. kafaya bağlanmış.
    expect(slotToolColors(U1_SLOTLAR, [3, 2, 1, 0])).toEqual(["#FFFFFF", "#000000", "#E72F1D", "#6F4C2F"]);
  });

  it("firmware DOLGUSU (-1) kimliğe düşer, yanlış kafaya sapmaz", () => {
    // Gerçek tablo 32 elemanlı; sonu geçersiz dolgu. Dolgu 0'a eşlenirse her fazladan
    // mantıksal indeks 0. kafanın rengini alırdı — bu test onu engeller.
    expect(slotToolColors(U1_SLOTLAR, [0, 1, -1, -1])).toEqual(["#6F4C2F", "#E72F1D", "#000000", "#FFFFFF"]);
  });

  it("eşleme YOKSA (tek kafalı / okunamadı) eski davranış korunur", () => {
    expect(slotToolColors(U1_SLOTLAR)).toEqual(["#6F4C2F", "#E72F1D", "#000000", "#FFFFFF"]);
    expect(slotToolColors(U1_SLOTLAR, [])).toEqual(["#6F4C2F", "#E72F1D", "#000000", "#FFFFFF"]);
  });
});

/**
 * PARÇA İPTALİ DÜĞMESİ — neden kapalı?
 *
 * ÖLÇÜLDÜ (23 Ağu 2026, kullanıcının üç yazıcısı): Neptune 4 Pro, Neptune 4 Plus ve
 * Snapmaker U1'in ÜÇÜNDE de Klipper'ın `exclude_object` nesnesi var. Ama o an basılan
 * dosyalarda etiketli parça sayısı Plus'ta 1, diğer ikisinde 0'dı. Yani "sadece Plus'ta
 * çalışıyor" görüntüsü YAZICIDAN değil, dosyanın nasıl dilimlendiğinden geliyordu.
 *
 * Düğme eskiden bu durumda hiç çizilmiyordu; kullanıcı da özelliğin o yazıcılarda
 * olmadığını sanıyordu. Artık görünür kalıp nedenini söylüyor.
 */
describe("parcaIptalDurumu", () => {
  it("Moonraker + basıyor + etiketli parça var → AÇIK", () => {
    const d = parcaIptalDurumu({ tip: "moonraker", basiyor: true, parcaVar: true });
    expect(d.acik).toBe(true);
  });

  it("etiket yoksa kapalı ve NE YAPILACAĞINI söylüyor", () => {
    const d = parcaIptalDurumu({ tip: "moonraker", basiyor: true, parcaVar: false });
    expect(d.acik).toBe(false);
    // Kullanıcı "neden yok" değil "ne yapmalıyım" cevabını almalı.
    expect(d.ipucu).toMatch(/dilimley/i);
  });

  it("baskı yokken kapalı", () => {
    const d = parcaIptalDurumu({ tip: "moonraker", basiyor: false, parcaVar: true });
    expect(d.acik).toBe(false);
    expect(d.ipucu).toMatch(/baskı/i);
  });

  it("Bambu'da desteklenmiyor — ama düğme yine de bir şey söylüyor", () => {
    const d = parcaIptalDurumu({ tip: "bambu", basiyor: true, parcaVar: true });
    expect(d.acik).toBe(false);
    expect(d.ipucu.length).toBeGreaterThan(0);
  });

  it("hiçbir durumda boş ipucu dönmez", () => {
    for (const tip of ["moonraker", "bambu"]) {
      for (const basiyor of [true, false]) {
        for (const parcaVar of [true, false]) {
          expect(parcaIptalDurumu({ tip, basiyor, parcaVar }).ipucu.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });
});
