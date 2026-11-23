/**
 * Yazıcılar denetimi (23 Kas 2026) — sunucu tarafı düzeltmelerinin saf parçaları.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {}, remotePrisma: {} }));

import { bitisCapasi } from "./bitis-capasi";
import { bambuDurumMesaji } from "./bambu";
import { gecisIcinOncekiDurum } from "./relay";

describe("kısa kopukluk bildirim geçişini yutmaz", () => {
  it("basıyor → çevrimdışı → bitti: geçiş 'basıyor'dan görülür (bildirim gider)", () => {
    const h = new Map<string, string>();
    expect(gecisIcinOncekiDurum(h, "u1", "printing")).toBeUndefined();
    expect(gecisIcinOncekiDurum(h, "u1", "offline")).toBe("printing");
    expect(gecisIcinOncekiDurum(h, "u1", "offline")).toBe("printing");
    // Yazıcı geri geldi ve baskı bu arada bitmişti → önceki durum hâlâ "printing".
    expect(gecisIcinOncekiDurum(h, "u1", "finished")).toBe("printing");
    expect(gecisIcinOncekiDurum(h, "u1", "finished")).toBe("finished");
  });

  it("yazıcılar birbirini etkilemez", () => {
    const h = new Map<string, string>();
    gecisIcinOncekiDurum(h, "a", "printing");
    gecisIcinOncekiDurum(h, "b", "idle");
    expect(gecisIcinOncekiDurum(h, "a", "paused")).toBe("printing");
    expect(gecisIcinOncekiDurum(h, "b", "offline")).toBe("idle");
  });
});

describe("Bambu bitiş çapası — kalan süre geri zıplamaz", () => {
  it("dakikalık değer aynı kaldıkça bitiş anı sabit; değişince yeniden kurulur", () => {
    const t0 = 1_000_000;
    const b1 = bitisCapasi("a1|x.3mf", 35 * 60, 35 * 60, t0);
    // 2 sn sonra yazıcı hâlâ "35 dk" diyor → aynı bitiş (eskiden 35:00'a geri zıplıyordu).
    expect(bitisCapasi("a1|x.3mf", 35 * 60, 35 * 60, t0 + 2_000)).toBe(b1);
    expect(bitisCapasi("a1|x.3mf", 35 * 60, 35 * 60, t0 + 58_000)).toBe(b1);
    // Değer 34 dk'ya indi → yeni çapa.
    const b2 = bitisCapasi("a1|x.3mf", 34 * 60, 34 * 60, t0 + 60_000);
    expect(b2).toBe(t0 + 60_000 + 34 * 60_000);
  });

  it("başka dosya ya da bilinmeyen kalan süre çapayı kullanmaz", () => {
    const t0 = 5_000_000;
    bitisCapasi("a1|eski.3mf", 600, 600, t0);
    expect(bitisCapasi("a1|yeni.3mf", 600, 600, t0 + 10_000)).toBe(t0 + 10_000 + 600_000);
    expect(bitisCapasi("a1|yeni.3mf", null, null, t0 + 20_000)).toBeNull();
  });

  it("geçmişte kalmış çapa kullanılmaz (bitiş geçti, değer aynı kaldı)", () => {
    const t0 = 9_000_000;
    bitisCapasi("a2|y.3mf", 60, 60, t0);
    expect(bitisCapasi("a2|y.3mf", 60, 60, t0 + 61_000)).toBe(t0 + 61_000 + 60_000);
  });
});

describe("Bambu hata metni masaüstü ve telefonda aynı", () => {
  it("hata kodu onaltılık; neden varsa o", () => {
    expect(bambuDurumMesaji("error", { statusReason: null, printError: 50348044 })).toBe("Baskı hatayla durdu (kod 0x300400C)");
    expect(bambuDurumMesaji("error", { statusReason: null, printError: null })).toBe("Baskı hatayla durdu");
    expect(bambuDurumMesaji("paused", { statusReason: "Filament bitti", printError: null })).toBe("Filament bitti");
    expect(bambuDurumMesaji("printing", { statusReason: null, printError: null })).toBeNull();
  });
});
