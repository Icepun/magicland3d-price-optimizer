import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { YAZICI_DURUM, durumBilgisi, kalanSure, yazicilariSirala } from "../../mobile/src/lib/yazici-durum";

/**
 * MOBİL İYİLEŞTİRME PAKETİ 1 (24 Eyl 2026) — kullanıcıyla birlikte listelenen sorunlar.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("yazıcı durumu — Atölye ve Yazıcılar AYNI tablo", () => {
  it("iki ekran da ortak tabloyu kullanıyor (bir tur renk ve adlar çelişiyordu)", () => {
    expect(oku("mobile/src/app/(tabs)/atolye.tsx")).toContain('from "@/lib/yazici-durum"');
    expect(oku("mobile/src/app/printers.tsx")).toContain("const STATUS = YAZICI_DURUM;");
    expect(oku("mobile/src/app/(tabs)/atolye.tsx")).not.toMatch(/const DURUM: Record</);
  });

  it("yeşil = tamamlandı, mor = basıyor", () => {
    expect(YAZICI_DURUM.finished.label).toBe("Tamamlandı");
    expect(YAZICI_DURUM.printing.color).not.toBe(YAZICI_DURUM.finished.color);
  });

  it("bağlantısız yazıcı durumu ne olursa olsun Çevrimdışı görünür", () => {
    expect(durumBilgisi("printing", false).label).toBe("Çevrimdışı");
    expect(durumBilgisi("bilinmeyen").label).toBe("Hazır");
  });

  it("sıralama: hata, duraklama, basan, biten, hazır, çevrimdışı — eşitlerde özgün sıra", () => {
    const liste = [
      { id: "a", status: "idle", online: 1 },
      { id: "b", status: "printing", online: 1 },
      { id: "c", status: "finished", online: 1 },
      { id: "d", status: "printing", online: 0 },
      { id: "e", status: "error", online: 1 },
      { id: "f", status: "printing", online: 1 },
    ];
    expect(yazicilariSirala(liste).map((x) => x.id)).toEqual(["e", "b", "f", "c", "a", "d"]);
  });

  it("kalan süre okunur biçimde; bilinmiyorsa null", () => {
    expect(kalanSure(13020)).toBe("3 sa 37 dk");
    expect(kalanSure(900)).toBe("15 dk");
    expect(kalanSure(40)).toBe("40 sn");
    expect(kalanSure(0)).toBeNull();
    expect(kalanSure(null)).toBeNull();
  });
});

describe("Atölye — dört yazıcının dördü, dokunulabilir olduğu belli", () => {
  const atolye = oku("mobile/src/app/(tabs)/atolye.tsx");

  it("tüm yazıcılar listeleniyor (yalnız basanlar değil)", () => {
    expect(atolye).toContain("const yazicilar = yazicilariSirala(snaps);");
    expect(atolye).toContain("{yazicilar.map((s, i) => (");
  });

  it("kartta ve bölüm başlığında ok işareti + 'Tümü' var", () => {
    expect(atolye.match(/name="chevron\.right"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(atolye).toContain("Tümü");
  });

  it("kartta baskının görseli ilerleme halkasının içinde", () => {
    expect(atolye).toMatch(/<Ring value=\{isVar \? oran : 0\}/);
    expect(atolye).toContain("thumbUrl(s.productImage, 120)");
  });
});

describe("Ürünler — satır ve yükleme", () => {
  const urunler = oku("mobile/src/app/(tabs)/products.tsx");

  it("stok ve desi uyarısı daralmaz; önce kategori daralır", () => {
    expect(urunler).toContain("sabit: { flexShrink: 0 }");
    expect(urunler).toContain("kategori: { flexShrink: 1, minWidth: 0 }");
    expect(urunler).toMatch(/style=\{\[styles\.sabit, \{ color: out \? color\.bad : color\.textDim \}\]\}/);
  });

  it("platform tutarları kısa adla ayırt ediliyor (turuncular karışıyordu)", () => {
    expect(urunler).toContain('const PLATFORM_KISA: Record<Platform, string> = { shopify: "S", trendyol: "TY", hepsiburada: "HB" };');
  });

  it("yüklenirken filtre sayıları gösterilmiyor", () => {
    expect(urunler).toContain("count={products ? sayilar[f.key] : undefined}");
  });

  it("ürün detayında otomatik Shopify kimliği gösterilmiyor", () => {
    const detay = oku("mobile/src/app/product/[id].tsx");
    expect(detay).toContain("const OTOMATIK_KOD = /^shopify-variant-\\d+$/i;");
    expect(detay).not.toMatch(/\{product\.sku\}/);
  });
});

describe("Uygulamaya dönünce tazeleme ve bildirim durumu", () => {
  it("React Query uygulamanın öne gelişini biliyor; yalnız dar liste tazeleniyor", () => {
    const q = oku("mobile/src/lib/query.tsx");
    expect(q).toContain("focusManager.setEventListener");
    expect(q).toContain('const ODAKTA_TAZELENEN = new Set(["orders", "notifications", "printer-snapshots", "prep-done"]);');
    expect(q).toContain("refetchOnWindowFocus: (q) => odaktaTazelensinMi(q)");
  });

  it("bildirimler ekranı bu telefondaki bildirim durumunu gösteriyor", () => {
    expect(oku("mobile/src/app/notifications.tsx")).toContain("ListHeaderComponent={<PushDurumSatiri />}");
    const satir = oku("mobile/src/components/PushDurumSatiri.tsx");
    expect(satir).toContain("Linking.openSettings()");
    expect(satir).toContain("useSyncExternalStore(pushDurumunaAbone, pushDurumu)");
  });
});
