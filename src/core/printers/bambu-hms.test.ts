import { describe, expect, it } from "vitest";
import { bambuStatusReason, toWarning } from "./bambu";
import { bambuHataAciklamasi, bambuHataKodu, bambuModelOneki, BAMBU_HMS_SURUMU, hmsAciklamasi } from "./bambu-hms";

/**
 * 12 Eki 2026 — "AMS — Yazıcı ciddi bir uyarı veriyor" yerine yazıcının GERÇEKTE ne dediği.
 * Sözlük üreticinin resmi Türkçe listesinden üretiliyor (scripts/bambu-hms-guncelle.mjs).
 */
describe("Bambu kod sözlüğü", () => {
  it("HMS kodu tireli ya da düz verilebilir; yuva numarası açıklamada", () => {
    expect(hmsAciklamasi("1200-2100-0002-0001")).toBe(
      "AMS lite yuva 2'deki filament tükendi; lütfen yeni bir filament takın."
    );
    expect(hmsAciklamasi("0700210000020001")).toMatch(/^AMS A yuva 2 filamenti tükendi/);
    expect(hmsAciklamasi("0300-0200-0001-0001")).toMatch(/sıcaklığı anormal/);
  });

  it("sözlükte olmayan ya da bozuk kod UYDURULMAZ", () => {
    expect(hmsAciklamasi("FFFF-FFFF-FFFF-FFFF")).toBeNull();
    expect(hmsAciklamasi("1200-2100")).toBeNull();
    expect(hmsAciklamasi("")).toBeNull();
  });

  it("baskı hata kodu (print_error) 8 haneli koda çevrilip açıklanır", () => {
    expect(bambuHataKodu(0x12038011)).toBe("12038011");
    expect(bambuHataKodu(0x0500400e)).toBe("0500400E");
    expect(bambuHataKodu(0)).toBeNull();
    expect(bambuHataKodu(null)).toBeNull();
    expect(bambuHataAciklamasi(0x12038011)).toMatch(/^AMS lite filamenti tükendi/);
    expect(bambuHataAciklamasi(0x0500400e)).toBe("İş iptal edildi.");
    expect(bambuHataAciklamasi(0x7fffffff)).toBeNull();
  });

  it("modele özel metin önceliklidir; model bilinmiyorsa genel metin", () => {
    expect(bambuModelOneki("039xxxxxxxxxxxx")).toBe("039");
    expect(bambuModelOneki("26a000000000000000")).toBe("26A");
    expect(bambuModelOneki("")).toBeNull();
    const genel = bambuHataAciklamasi(0x03008014);
    const a2l = bambuHataAciklamasi(0x03008014, "26A");
    expect(genel).toBeTruthy();
    expect(a2l).toBeTruthy();
    expect(a2l).not.toBe(genel);
    // Bilinmeyen model genel metne düşer.
    expect(bambuHataAciklamasi(0x03008014, "ZZZ")).toBe(genel);
  });

  it("sözlük boş değil (üretim betiği çalışmış)", () => {
    expect(BAMBU_HMS_SURUMU).toMatch(/^\d{12}$/);
  });
});

describe("bambuStatusReason — neden durdu", () => {
  const filamentBitti = toWarning(0x12002100, 0x00020001); // AMS lite yuva 2 — "serious"
  const bilgi = toWarning(0x12002000, 0x00030002); // "…aynı filamentin bulunduğu yuvaya geçildi" — "common"

  it("duraklamada müdahale isteyen uyarı nedendir — ÖNEKSİZ (\"Duraklatıldı ·\" yazan yer kendi ekler)", () => {
    expect(bambuStatusReason("PAUSE", 0x12038011, [bilgi, filamentBitti], "AMS lite filamenti tükendi.")).toBe(
      "AMS lite yuva 2'deki filament tükendi; lütfen yeni bir filament takın."
    );
  });

  it("uyarı yoksa yazıcının ekranındaki hata cümlesi kullanılır", () => {
    expect(bambuStatusReason("PAUSE", 0x12038011, [], bambuHataAciklamasi(0x12038011))).toMatch(
      /^AMS lite filamenti tükendi/
    );
    expect(bambuStatusReason("FAILED", 0x0500400e, [], bambuHataAciklamasi(0x0500400e))).toBe("İş iptal edildi.");
  });

  it("kod tanınmıyorsa uydurmaz, kodu söyler; kod yoksa (elle duraklatma) neden yazmaz", () => {
    expect(bambuStatusReason("PAUSE", 0x7fff1234, [], null)).toBe("Yazıcı bir sorun bildirdi (kod 7FFF-1234)");
    expect(bambuStatusReason("PAUSE", 0, [], null)).toBeNull();
    expect(bambuStatusReason("FAILED", null, [], null)).toBeNull();
  });

  it("sorunsuz basarken düşük önemli uyarı neden OLMAZ (telefonda kalıcı sahte uyarı üretirdi)", () => {
    expect(bambuStatusReason("RUNNING", 0, [bilgi], null)).toBeNull();
    expect(bambuStatusReason("RUNNING", 0, [filamentBitti], null)).toMatch(/filament tükendi/);
  });

  it("çok uzun açıklama cümle sınırında kısalır", () => {
    const uzun = { code: "X", level: "serious" as const, text: `Tabla algılanmadı. ${"Lütfen tablayı kontrol edin ".repeat(20)}` };
    expect(bambuStatusReason("PAUSE", 0, [uzun], null)).toBe("Tabla algılanmadı");
  });
});
