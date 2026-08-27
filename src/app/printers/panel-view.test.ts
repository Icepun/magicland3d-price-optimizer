/**
 * Yazıcı kartının görünüm kararları — Faz 3'te sahada patlayan dört sınıf hatanın koruması.
 *
 * 1) Kafa değişimindeki ısınma kartı "hazırlanıyor"a düşürüp yüzdeyi/katmanı/kalan süreyi
 *    gizliyordu (Snapmaker U1 tek baskıda 4.395 kez).
 * 2) Dolan model karesi BAYT ilerlemesiyle seçiliyordu; kareler KATMAN oranıyla üretiliyor
 *    (canlı ölçüm: bayt %90 / katman %66,5 → 23,5 puan sapma).
 * 3) Durum rengi yazıcının KİMLİK renginden geliyordu: sağlıklı "Yazdırıyor" kırmızı görünüyordu.
 * 4) Kalan süre bilinmezken "0sn kaldı" yazılıyordu.
 */
import { describe, expect, it } from "vitest";
import type { PanelPrinter as ApiPanelPrinter, PrinterJob as ApiPrinterJob } from "@/app/api/printers/route";
import {
  bedFrameFor,
  buildSlotChips,
  jobImageCandidates,
  pickImage,
  slotLabel,
  connectionNotice,
  formatClock,
  formatRemaining,
  intraLayerFraction,
  layerBadgeText,
  nozzleDot,
  orderWarnings,
  pickBuildFrame,
  resolvePackLayerIndex,
  resolveRemaining,
  resolveStage,
  resolveStatusVisual,
  type PanelPrinter,
  type PrinterJob,
  baskiYeniBittiMi,
} from "./panel-view";

// ── Sözleşme kilidi ────────────────────────────────────────────────────────
// Yerel arayüzün API'den SAPMASI bu projede daha önce tsc'yi kör bıraktı ve arayüz null bir
// değerde çöktü. İki yönlü atanabilirlik: API'ye alan eklenip burada unutulursa tsc patlar.
// (`import type` derlemede tamamen silinir — rota modülü ÇALIŞTIRILMAZ.)
describe("API sözleşmesi", () => {
  it("yerel tipler rota tipleriyle birebir aynı", () => {
    const a: PanelPrinter = null as unknown as ApiPanelPrinter;
    const b: ApiPanelPrinter = null as unknown as PanelPrinter;
    const c: PrinterJob = null as unknown as ApiPrinterJob;
    const d: ApiPrinterJob = null as unknown as PrinterJob;
    expect([a, b, c, d]).toHaveLength(4);
  });
});

describe("MADDE 2 — hazırlık evresi", () => {
  it("baskı ilerlemişken ısınma kartı hazırlığa DÜŞÜRMEZ", () => {
    // Snapmaker U1, 248/1333. katmanda renk değişimi: nozul 70 → 220.
    const s = resolveStage({ status: "printing", heating: true, progress: 0.257, layerCurrent: 248 });
    expect(s.preparing).toBe(false);
    expect(s.heatingChip).toBe(true); // bilgi kalır, ısınma yalnız küçük bir çip
  });

  it("baskının gerçek başında (ilerleme ve katman yokken) hazırlık gösterir", () => {
    const s = resolveStage({ status: "printing", heating: true, progress: 0, layerCurrent: null });
    expect(s.preparing).toBe(true);
    expect(s.heatingChip).toBe(false); // hazırlık satırı zaten ısınmayı söylüyor
  });

  it("ilk katman göründüyse hazırlık biter", () => {
    expect(resolveStage({ status: "printing", heating: true, progress: 0, layerCurrent: 1 }).preparing).toBe(false);
  });

  it("duraklatılmış baskı hazırlık değildir", () => {
    expect(resolveStage({ status: "paused", heating: true, progress: 0, layerCurrent: null }).preparing).toBe(false);
  });
});

describe("MADDE 4 — inşa karesi seçimi", () => {
  it("kareyi KATMAN oranından seçer (bayt ilerlemesinden değil)", () => {
    // Sahadaki sapma: bayt %90, katman %66,5 → 32 karede 28. kare yerine 21. kare doğru.
    const pick = pickBuildFrame({ frameCount: 32, layerCurrent: 665, layerTotal: 1000, progress: 0.9 });
    expect(pick.source).toBe("layer");
    expect(pick.index).toBe(21);
  });

  it("katman bilinmiyorsa ilerlemeye düşer", () => {
    const pick = pickBuildFrame({ frameCount: 32, layerCurrent: null, layerTotal: 0, progress: 0.5 });
    expect(pick.source).toBe("progress");
    expect(pick.index).toBe(16);
  });

  it("son katmanda son kareyi verir, taşmaz", () => {
    expect(pickBuildFrame({ frameCount: 32, layerCurrent: 1333, layerTotal: 1333, progress: 1 }).index).toBe(31);
    expect(pickBuildFrame({ frameCount: 32, layerCurrent: 2000, layerTotal: 1333, progress: 1 }).index).toBe(31);
  });

  it("kare yokken çökmez", () => {
    expect(pickBuildFrame({ frameCount: 0, layerCurrent: 5, layerTotal: 10, progress: 0.5 }).index).toBe(0);
  });

  it("KARE OLMASA DA oran hesaplanır — görsel açılımı buna bağlı", () => {
    // Kart artık slicer render'ını alttan yukarı açıyor; kare üretilmemiş olması
    // açılımı durdurmamalı (eskiden erken çıkışta oran hiç hesaplanmıyordu).
    const p = pickBuildFrame({ frameCount: 0, layerCurrent: 5, layerTotal: 10, progress: 0.9 });
    expect(p.ratio).toBeCloseTo(0.5);
    expect(p.source).toBe("layer");
  });

  it("oran katmandan gelir, bayt ilerlemesinden değil", () => {
    expect(pickBuildFrame({ frameCount: 32, layerCurrent: 665, layerTotal: 1000, progress: 0.9 }).ratio)
      .toBeCloseTo(0.665);
  });

  it("oran 0..1 aralığını aşmaz", () => {
    expect(pickBuildFrame({ frameCount: 8, layerCurrent: 2000, layerTotal: 1333, progress: 2 }).ratio).toBe(1);
    expect(pickBuildFrame({ frameCount: 8, layerCurrent: null, layerTotal: 0, progress: -1 }).ratio).toBe(0);
  });
});

describe("MADDE 5 — durum rengi kimlik renginden bağımsız", () => {
  const printer = { status: "printing" as const, connection: "ok" as const, online: true, type: "moonraker" as const };

  it("sağlıklı baskı hata tonuyla AYNI olamaz", () => {
    const printing = resolveStatusVisual(printer);
    const error = resolveStatusVisual({ ...printer, status: "error" });
    const paused = resolveStatusVisual({ ...printer, status: "paused" });
    expect(printing.color).not.toBe(error.color);
    expect(printing.color).not.toBe(paused.color);
    expect(error.color).not.toBe(paused.color);
  });

  it("altı durumun altısı da ayrı ton", () => {
    const tones = (["printing", "paused", "finished", "error", "idle"] as const).map(
      (status) => resolveStatusVisual({ ...printer, status }).tone
    );
    expect(new Set(tones).size).toBe(5);
  });

  it("kurulmamış yazıcı ile ulaşılamayan yazıcı AYRI görünür", () => {
    const unconfigured = resolveStatusVisual({ ...printer, connection: "unconfigured", online: false });
    const offline = resolveStatusVisual({ ...printer, connection: "offline", online: false });
    expect(unconfigured.tone).toBe("unconfigured");
    expect(offline.tone).toBe("offline");
    expect(unconfigured.label).not.toBe(offline.label);
  });

  it("demo kartı bağlantı durumuna takılmaz", () => {
    expect(resolveStatusVisual({ status: "printing", connection: "offline", online: true, type: "sim" }).tone).toBe("printing");
  });
});

describe("MADDE 7 — katman rozeti ve nozul noktası", () => {
  it("katman rozeti", () => {
    expect(layerBadgeText(448, 1333)).toBe("katman 448/1333");
    expect(layerBadgeText(448, 0)).toBe("katman 448");
    expect(layerBadgeText(null, 1333)).toBeNull();
    expect(layerBadgeText(0, 1333)).toBeNull();
  });

  it("paket katman indeksi 1 tabanlıdan 0 tabanlıya çevrilir ve layerCurrent tercih edilir", () => {
    // file_position hareket kuyruğu yüzünden bir katman ÖNDE (byteLayer 449) — yok sayılır.
    expect(resolvePackLayerIndex({ layerCurrent: 448, byteLayer: 449, layerCount: 1333 })).toBe(447);
    expect(resolvePackLayerIndex({ layerCurrent: null, byteLayer: 449, layerCount: 1333 })).toBe(449);
    expect(resolvePackLayerIndex({ layerCurrent: null, byteLayer: null, layerCount: 1333 })).toBeNull();
    expect(resolvePackLayerIndex({ layerCurrent: 5000, byteLayer: null, layerCount: 1333 })).toBe(1332);
  });

  it("katman içi ince oran yalnız bayt konumundan", () => {
    expect(intraLayerFraction(1000, 2000, 1500)).toBeCloseTo(0.5, 6);
    expect(intraLayerFraction(1000, 2000, 900)).toBe(0);
    expect(intraLayerFraction(1000, 1000, 1000)).toBeNull();
    expect(intraLayerFraction(null, 2000, 1500)).toBeNull();
  });

  it("nozul noktası tabla ölçeğine göre; Y ekranda ters", () => {
    const bed = bedFrameFor("elegoo", "Neptune 4 Plus"); // 320×320
    expect(bed).toEqual({ minX: 0, maxX: 320, minY: 0, maxY: 320 });
    const dot = nozzleDot(160, 240, bed);
    expect(dot?.left).toBeCloseTo(0.5, 6);
    expect(dot?.top).toBeCloseTo(0.25, 6); // yukarısı maxY
    expect(dot?.clamped).toBe(false);
  });

  it("tabla dışına park eden nozul kırpılır ve işaretlenir", () => {
    const dot = nozzleDot(-12, 400, { minX: 0, maxX: 320, minY: 0, maxY: 320 });
    expect(dot).toEqual({ left: 0, top: 0, clamped: true });
  });

  it("koordinat ya da tabla bilinmiyorsa nokta çizilmez", () => {
    expect(nozzleDot(null, 10, { minX: 0, maxX: 320, minY: 0, maxY: 320 })).toBeNull();
    expect(nozzleDot(10, 10, null)).toBeNull();
    expect(bedFrameFor("acme", "Bilinmeyen")).toBeNull();
  });

  /**
   * Ölçüler YAZICILARDAN doğrulandı (14 Ağu 2026, `bed_mesh` sorgusu):
   *   U1      mesh 3..267      → 270  (eskiden 200 yazıyordu; kafa konumunun %31'i
   *                                    çerçeve dışına düşüp nokta gri ve kenara yapışıyordu)
   *   N4 Plus mesh 20..295/300 → 320
   *   N4 Pro  mesh ..200/220   → 225
   * ⚠️ `toolhead.axis_maximum` TABLA DEĞİLDİR (U1'de 271×335 — kafa doklarını kapsar).
   */
  it("dört yazıcının tablası tanınır", () => {
    expect(bedFrameFor("elegoo", "Neptune 4 Pro")?.maxX).toBe(225);
    expect(bedFrameFor("elegoo", "Neptune 4 Plus")?.maxX).toBe(320);
    expect(bedFrameFor("snapmaker", "U1")?.maxX).toBe(270);
    expect(bedFrameFor("bambu", "A1")?.maxX).toBe(256);
  });
});

describe("MADDE 1 — kalan süre", () => {
  const now = new Date("2026-08-12T18:00:00").getTime();

  it("bilinmiyorsa '—' — ASLA '0sn'", () => {
    const r = resolveRemaining({ remainingSec: 0, remainingKnown: false, nowMs: now, finished: false, showClock: true });
    expect(r.text).toBe("—");
    expect(r.clock).toBeNull();
    expect(r.known).toBe(false);
  });

  it("bitiş saati gösterilen kalan süreden üretilir → çelişmez", () => {
    const r = resolveRemaining({ remainingSec: 3600, remainingKnown: true, nowMs: now, finished: false, showClock: true });
    expect(r.text).toBe("1sa 0dk");
    expect(r.clock).toBe("19:00");
  });

  it("yarına sarkan baskı", () => {
    const r = resolveRemaining({ remainingSec: 15 * 3600, remainingKnown: true, nowMs: now, finished: false, showClock: true });
    expect(r.clock).toBe("yarın 09:00");
  });

  it("saat istenmiyorsa yalnız süre", () => {
    const r = resolveRemaining({ remainingSec: 90, remainingKnown: true, nowMs: now, finished: false, showClock: false });
    expect(r.text).toBe("1dk 30sn");
    expect(r.clock).toBeNull();
  });

  it("süre biçimi", () => {
    expect(formatRemaining(0)).toBe("0sn");
    expect(formatRemaining(59)).toBe("59sn");
    expect(formatRemaining(3600 * 5 + 60 * 7)).toBe("5sa 7dk");
    expect(formatClock(now, now)).toBe("18:00");
  });
});

describe("MADDE 12 — slot şeridi", () => {
  const slots = [
    { slot: 1, color: "#e23b3b", type: "PLA", empty: false },
    { slot: 2, color: "", type: "", empty: true },
    { slot: 3, color: "#2b6cf0", type: "PETG", empty: false },
  ];

  it("baskıda kullanılan slotlar vurgulu, kullanılmayanlar soluk", () => {
    const chips = buildSlotChips(slots, [1, 3]);
    expect(chips.map((c) => c.active)).toEqual([true, false, true]);
    expect(chips[1].empty).toBe(true);
  });

  it("aktif slot bildirilmezse hepsi eşit görünür", () => {
    expect(buildSlotChips(slots, []).every((c) => c.active)).toBe(true);
  });

  it("slot bildirmeyen yazıcıda dilimleyici renginden tek çip", () => {
    const chips = buildSlotChips([], [], { color: "#f5b400", type: "PLA" });
    expect(chips).toHaveLength(1);
    expect(chips[0].color).toBe("#f5b400");
    // Yedek çip de 0 tabanlı — aynı panelde iki farklı numaralandırma olmasın.
    expect(chips[0].slot).toBe(0);
    expect(slotLabel(chips[0].slot)).toBe("1");
  });

  // Moonraker (`slot: i`) ve Bambu (AMS `tray.id`) 0'dan başlıyor; yazıcının kendi ekranı 1'den.
  // Kart "0 · 1 · 2 · 3" derken kullanıcı yanlış yuvaya filament takıp yanlış renkle basıyordu.
  it("ekranda görünen yuva numarası 1 TABANLI, iç veri 0 tabanlı kalır", () => {
    const chips = buildSlotChips(
      [
        { slot: 0, color: "#e23b3b", type: "PLA", empty: false },
        { slot: 3, color: "", type: "", empty: true },
      ],
      [0],
    );
    expect(chips.map((c) => c.slot)).toEqual([0, 3]);
    expect(chips.map((c) => slotLabel(c.slot))).toEqual(["1", "4"]);
  });

  it("hiç veri yoksa şerit çizilmez", () => {
    expect(buildSlotChips([], [], { color: "", type: "" })).toHaveLength(0);
    expect(buildSlotChips(undefined, undefined)).toHaveLength(0);
  });
});

describe("MADDE 14 — uyarılar ve bağlantı", () => {
  it("en ağır uyarı önce, tekrar eden metin bir kez", () => {
    const list = orderWarnings([
      { code: "A", level: "common", text: "Filament azaldı" },
      { code: "B", level: "fatal", text: "Kapak açık" },
      { code: "C", level: "common", text: "filament azaldı" },
      { code: "D", level: "serious", text: "Tabla soğuk" },
    ]);
    expect(list.map((w) => w.text)).toEqual(["Kapak açık", "Tabla soğuk", "Filament azaldı"]);
    expect(list.map((w) => w.severe)).toEqual([true, true, false]);
  });

  it("boş metinli uyarı gösterilmez, sayı sınırlanır", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ code: null, level: "common" as const, text: `Uyarı ${i}` }));
    expect(orderWarnings([{ code: null, level: "info", text: "   " }, ...many])).toHaveLength(3);
    expect(orderWarnings(undefined)).toHaveLength(0);
  });

  it("kurulum eksikliği ile ulaşılamama ayrı eylem ister", () => {
    expect(connectionNotice("unconfigured", false)).toEqual({
      title: "Kurulum tamamlanmadı", detail: "Yazıcı bilgileri eksik.", action: "manage" as const,
    });
    expect(connectionNotice("offline", false)).toEqual({
      title: "Yazıcıya ulaşılamadı", detail: "Yazıcı açık ve aynı ağda mı?", action: "retry",
    });
    expect(connectionNotice("ok", true)).toBeNull();
  });

  it("EKSİK OLANIN ADI yazar — dört karttan hangisinde ne gerektiği görünsün", () => {
    expect(connectionNotice("unconfigured", false, "Kurulum tamamlanmadı — access code ve seri no gerekiyor.")!.detail)
      .toBe("Access code ve seri no gerekiyor.");
    expect(connectionNotice("unconfigured", false, "Kurulum tamamlanmadı — yazıcının IP adresi gerekiyor.")!.detail)
      .toBe("Yazıcının IP adresi gerekiyor.");
  });

  it("desteklenmeyen yazıcı 'kurulumu tamamla' demez — tamamlanacak bir şey yok", () => {
    const n = connectionNotice("unsupported", false, "Bu yazıcı uygulamadan yönetilemiyor.")!;
    expect(n.action).toBe("none");
    expect(n.title).not.toBe("Kurulum tamamlanmadı");
  });
});

describe("MADDE 3 — görsel zinciri: biri düşerse sıradakine geçilir", () => {
  const job = {
    plateThumbnail: "http://192.168.1.50/plate.png",
    productImage: "http://192.168.1.50/plate.png",
    storeImage: "https://cdn.shopify.com/urun.jpg",
  };

  it("öncelik basılan plaka, sonra model küçük resmi, sonra mağaza fotoğrafı", () => {
    expect(jobImageCandidates(job, "blob:model")).toEqual([
      "http://192.168.1.50/plate.png",
      "blob:model",
      "https://cdn.shopify.com/urun.jpg",
    ]);
  });

  // Yazıcı meşgulken plaka görüntüsü düşüyordu: eskiden kart BOŞ kutuya dönüyor, mağaza
  // fotoğrafı hiç denenmiyordu (iptal onayında ise kırık görsel ikonu çıkıyordu).
  it("plaka görüntüsü düşerse mağaza fotoğrafına düşülür", () => {
    const list = jobImageCandidates(job, null);
    expect(pickImage(list, [])).toBe("http://192.168.1.50/plate.png");
    expect(pickImage(list, ["http://192.168.1.50/plate.png"])).toBe("https://cdn.shopify.com/urun.jpg");
  });

  it("hepsi düşerse yer tutucu çizilir", () => {
    const list = jobImageCandidates(job, null);
    expect(pickImage(list, list)).toBeNull();
    expect(jobImageCandidates(null, null)).toEqual([]);
    expect(jobImageCandidates({ plateThumbnail: "  ", productImage: null, storeImage: "" }, null)).toEqual([]);
  });
});

/**
 * TIMELAPSE VİDEOSU EKRANA GELMİYORDU.
 *
 * Kullanıcı: "baskı bitiyor ama video düşmüyor; Hub'ı kapatıp açınca düşüyor."
 * Sebep: video listesi 5 dakikalık `staleTime` ile duruyordu ve uygulamanın genel ayarı
 * `refetchOnMount: false` — yani listeyi yeniden çekecek HİÇBİR ŞEY yoktu. Uygulamayı
 * kapatıp açmak önbelleği sıfırladığı için o zaman görünüyordu.
 *
 * Çözüm baskının bittiği ANI yakalamak. Bu karar sessizce bozulursa kimse fark etmez —
 * bu yüzden burada kilitli.
 */
describe("baskiYeniBittiMi", () => {
  it("basıyordu → bitti: YAKALANIR", () => {
    expect(baskiYeniBittiMi("printing", "finished")).toBe(true);
    expect(baskiYeniBittiMi("printing", "idle")).toBe(true);
  });

  it("DURAKLATMA bitiş değildir — video da oluşmaz", () => {
    expect(baskiYeniBittiMi("printing", "paused")).toBe(false);
    expect(baskiYeniBittiMi("paused", "printing")).toBe(false);
  });

  it("duraklatılmışken iptal edilirse yine bitiştir", () => {
    expect(baskiYeniBittiMi("paused", "idle")).toBe(true);
  });

  it("basmıyordu → basmıyor: tetiklenmez (her turda boşuna istek atmayalım)", () => {
    expect(baskiYeniBittiMi("idle", "idle")).toBe(false);
    expect(baskiYeniBittiMi("finished", "idle")).toBe(false);
  });

  it("İLK tur (önceki durum yok) tetiklemez", () => {
    // Uygulama açılışında her yazıcı için bir kez boşuna tazeleme yapılmasın.
    expect(baskiYeniBittiMi(undefined, "idle")).toBe(false);
    expect(baskiYeniBittiMi(undefined, "printing")).toBe(false);
  });

  it("baskı başlaması tetiklemez", () => {
    expect(baskiYeniBittiMi("idle", "printing")).toBe(false);
  });
});
