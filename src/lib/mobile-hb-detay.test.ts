import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Göreli yol ve içe aktarması olmayan saf modül (bkz. dosyanın başındaki not).
import {
  HB_DETAY_BICIMI,
  hbDetayGovdesiYaz,
  hbDetayGovdesiniOku,
  type HbDetayKaydi,
} from "../../mobile/src/lib/api/hb-detay-bicim";

/**
 * HEPSİBURADA DETAY ÖNBELLEĞİ DİSKTE — soğuk açılıştaki ~40 detay isteği yerine yalnız yeniler.
 *
 * Korunanlar:
 *  • Diske yazılan geri okunur (gidiş-dönüş), kâr hesabına giren alanlar birebir.
 *  • Bozuk dosya/kayıt uygulamayı ÇÖKERTMEZ (çevrimdışı önbellek `Map` tuzağının dersi).
 *  • Sipariş hattı dosya sistemine doğrudan dokunmaz → Node'daki rakam düzeneği çalışır.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const kayit = (ad: string): HbDetayKaydi => ({
  lines: [
    {
      name: ad,
      quantity: 2,
      unitPrice: 149.9,
      matchKeys: ["SKU-1", "869000"],
      barcodes: ["869000"],
      externalIds: [],
      skus: ["SKU-1"],
    },
  ],
  customer: null,
  date: 1_790_000_000_000,
});

describe("dosya biçimi", () => {
  it("yazılan okunur — kalem, anahtarlar ve tarih birebir", () => {
    const kaynak = new Map([
      ["HB1", kayit("Vazo")],
      ["HB2", kayit("Kupa")],
    ]);
    const hedef = new Map<string, HbDetayKaydi>();
    expect(hbDetayGovdesiniOku(hbDetayGovdesiYaz(kaynak, 600, 1), hedef)).toBe(true);
    expect([...hedef.entries()]).toEqual([...kaynak.entries()]);
  });

  it("yalnız en yeni kayıtlar tutulur (ekleme sırası = eskiden yeniye)", () => {
    const kaynak = new Map([
      ["ESKI", kayit("a")],
      ["ORTA", kayit("b")],
      ["YENI", kayit("c")],
    ]);
    const hedef = new Map<string, HbDetayKaydi>();
    hbDetayGovdesiniOku(hbDetayGovdesiYaz(kaynak, 2, 1), hedef);
    expect([...hedef.keys()]).toEqual(["ORTA", "YENI"]);
  });

  it("bellekteki taze kayıt diskteki eskisiyle EZİLMEZ", () => {
    const hedef = new Map([["HB1", kayit("taze")]]);
    hbDetayGovdesiniOku(hbDetayGovdesiYaz(new Map([["HB1", kayit("eski")]]), 600, 1), hedef);
    expect(hedef.get("HB1")?.lines[0].name).toBe("taze");
  });
});

describe("bozuk dosya çökertmez", () => {
  it("tanınmayan biçim → false (çağıran dosyayı siler), hiçbir kayıt eklenmez", () => {
    const hedef = new Map<string, HbDetayKaydi>();
    expect(hbDetayGovdesiniOku(JSON.stringify({ bicim: HB_DETAY_BICIMI + 1, kayitlar: [] }), hedef)).toBe(false);
    expect(hbDetayGovdesiniOku(JSON.stringify({ bicim: HB_DETAY_BICIMI, kayitlar: {} }), hedef)).toBe(false);
    expect(hedef.size).toBe(0);
  });

  it("bozuk tek tek kayıtlar atlanır, sağlamlar alınır", () => {
    const hedef = new Map<string, HbDetayKaydi>();
    const govde = JSON.stringify({
      bicim: HB_DETAY_BICIMI,
      kayitlar: [
        ["IYI", kayit("iyi")],
        ["BOS", { lines: [], customer: null, date: null }],
        ["NAN", { lines: [{ name: "x", quantity: "2", unitPrice: 1, matchKeys: [] }], customer: null, date: null }],
        // Map diske `{}` olarak yazılmış bir kayıt (eski tuzak) — satır dizisi değil.
        ["MAP", { lines: {}, customer: null, date: null }],
        [42, kayit("anahtar sayı")],
        "çöp",
      ],
    });
    expect(hbDetayGovdesiniOku(govde, hedef)).toBe(true);
    expect([...hedef.keys()]).toEqual(["IYI"]);
  });

  it("bozuk JSON fırlatır — çağıran yakalayıp dosyayı siler", () => {
    expect(() => hbDetayGovdesiniOku("{yarım", new Map())).toThrow();
    expect(oku("mobile/src/lib/api/hb-detay-onbellek.ts")).toMatch(/catch \{\s*try \{\s*f\?\.delete\(\);/);
  });
});

describe("bağlantılar", () => {
  it("sipariş hattı dosya sistemine doğrudan dokunmaz (Node'daki rakam düzeneği için)", () => {
    const hb = oku("mobile/src/lib/api/hepsiburada.ts");
    expect(hb).not.toMatch(/from "expo-file-system"/);
    expect(hb).not.toMatch(/from "react-native"/);
    expect(hb).toContain("export function hbDetayDeposunuKur(");
  });

  it("uygulama açılışta disk deposunu bağlıyor, yeni detay gelince yazılıyor", () => {
    expect(oku("mobile/src/lib/query.tsx")).toContain("hbDetayDeposunuKur(hbDiskDeposu);");
    expect(oku("mobile/src/lib/api/hepsiburada.ts")).toContain("if (yeniDetay && depo) depo.kaydet(detailCache, DETAIL_CACHE_MAX);");
  });

  it("çevrimdışı önbellek sürümü türlü anahtarlarla birlikte artırıldı", () => {
    const politika = oku("mobile/src/lib/offline-cache-policy.ts");
    expect(Number(/export const ONBELLEK_BICIMI = (\d+)/.exec(politika)![1])).toBeGreaterThanOrEqual(4);
  });
});
