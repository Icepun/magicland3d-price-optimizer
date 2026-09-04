import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  KALICI_SORGULAR,
  ONBELLEK_BICIMI,
  ONBELLEK_MAKSIMUM_YAS_MS,
  jsonGuvenliMi,
  kaliciSorguMu,
  onbellekGecerliMi,
} from "../../mobile/src/lib/offline-cache-policy";

/**
 * ÇEVRİMDIŞI ÖNBELLEK — atölyede zayıf ağda uygulama boş açılmasın.
 *
 * Riskler burada test ediliyor:
 *  1. BAYAT VERİ CANLI SANILMASIN — çok eski dosya yüklenmemeli, yüklenen veri de ekranda
 *     "ne zaman güncellendi" damgasıyla görünmeli.
 *  2. ANLIK DURUM YAZILMASIN — kapanışta %62'de olan baskı ertesi gün "%62 sürüyor" diye
 *     görünürse kullanıcı yazıcının başına boşuna gider.
 *  3. YENİ NATIVE PAKET EKLENMESİN — parmak izi değişirse telefonun OTA kanalı kesilir ve
 *     yeni TestFlight derlemesi yüklenene kadar HİÇBİR güncelleme ulaşmaz.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("önbellek geçerlilik kuralı", () => {
  const simdi = 1_800_000_000_000;

  it("taze dosya kullanılır", () => {
    expect(onbellekGecerliMi({ bicim: ONBELLEK_BICIMI, yazilma: simdi - 60_000 }, simdi)).toBe(true);
  });

  it("çok eski dosya atılır", () => {
    const eski = simdi - ONBELLEK_MAKSIMUM_YAS_MS - 1;
    expect(onbellekGecerliMi({ bicim: ONBELLEK_BICIMI, yazilma: eski }, simdi)).toBe(false);
  });

  it("eski biçim atılır (alan düzeni değişmiş olabilir)", () => {
    expect(onbellekGecerliMi({ bicim: ONBELLEK_BICIMI - 1, yazilma: simdi }, simdi)).toBe(false);
  });

  it("bozuk/boş dosya çökmeye yol açmaz", () => {
    expect(onbellekGecerliMi(null, simdi)).toBe(false);
    expect(onbellekGecerliMi({}, simdi)).toBe(false);
    expect(onbellekGecerliMi({ bicim: ONBELLEK_BICIMI, yazilma: "dün" }, simdi)).toBe(false);
  });

  /** Cihaz saati ileri alınıp geri alınırsa damga "gelecekten" gelir; yaş hesabı anlamını yitirir. */
  it("gelecek tarihli damgaya güvenilmez", () => {
    expect(onbellekGecerliMi({ bicim: ONBELLEK_BICIMI, yazilma: simdi + 600_000 }, simdi)).toBe(
      false
    );
  });
});

describe("hangi sorgular diske yazılır", () => {
  it("açılışta gösterilen ağır veriler yazılır", () => {
    for (const k of ["orders", "dashboard-data", "match-products", "settings"]) {
      expect(kaliciSorguMu([k])).toBe(true);
    }
  });

  it("ANLIK yazıcı durumu YAZILMAZ — eski baskı yüzdesi yanlış bilgi olur", () => {
    expect(kaliciSorguMu(["printer-snapshots"])).toBe(false);
    expect(KALICI_SORGULAR).not.toContain("printer-snapshots");
  });

  /**
   * ⚠️ UYGULAMAYI AÇILIŞTA ÇÖKERTTİ (17 Ağu 2026). `["rules"]` listedeydi; `getRules()`
   * içindeki `financialByExternalId`/`financialByOrderNumber` birer `Map` ve
   * `JSON.stringify(new Map())` → `{}`. Geri yüklenen düz nesnede `.get()` olmadığı için
   * ilk render "get is not a function" ile patlıyor, uygulama hiç açılmıyordu. Dosya diske
   * yazıldığı için hata İKİNCİ açılışta ortaya çıktı — ilk turda her şey normal görünüyordu.
   */
  it("Map içeren kurallar sorgusu YAZILMAZ", () => {
    expect(KALICI_SORGULAR).not.toContain("rules");
    expect(kaliciSorguMu(["rules"])).toBe(false);
  });

  it("tanımadığımız sorgu yazılmaz (liste açık uçlu değil)", () => {
    expect(kaliciSorguMu(["rastgele-sorgu"])).toBe(false);
    expect(kaliciSorguMu([])).toBe(false);
    expect(kaliciSorguMu([42])).toBe(false);
  });
});

describe("JSON güvenlik süzgeci (ikinci savunma)", () => {
  it("düz veri geçer", () => {
    expect(jsonGuvenliMi({ a: 1, b: "x", c: [1, 2, { d: null }] })).toBe(true);
    expect(jsonGuvenliMi([])).toBe(true);
    expect(jsonGuvenliMi(null)).toBe(true);
  });

  it("Map/Set/Date geçmez — sessizce {} olarak yazılıp geri yüklerken patlarlar", () => {
    expect(jsonGuvenliMi(new Map([["a", 1]]))).toBe(false);
    expect(jsonGuvenliMi(new Set([1]))).toBe(false);
    expect(jsonGuvenliMi(new Date())).toBe(false);
  });

  it("derinde gizlenmiş Map de yakalanır", () => {
    expect(jsonGuvenliMi({ rules: { financialByExternalId: new Map() } })).toBe(false);
    expect(jsonGuvenliMi([{ liste: [{ x: new Map() }] }])).toBe(false);
  });

  it("gerçek getRules() çıktısının şekli reddedilir", () => {
    const rulesBenzeri = {
      commission: [],
      cargo: [],
      expense: [],
      financialByExternalId: new Map(),
      financialByOrderNumber: new Map(),
      adBudgets: [],
    };
    expect(jsonGuvenliMi(rulesBenzeri)).toBe(false);
  });

  it("süzgeç dehydrate çağrısına gerçekten bağlı", () => {
    expect(oku("mobile/src/lib/offline-cache.ts")).toContain("jsonGuvenliMi(q.state.data)");
  });
});

describe("çevrimdışı önbellek kurulumu", () => {
  /**
   * Zehirli dosyalar telefonlarda DURUYOR. Biçim sürümü artmazsa uygulama o dosyayı yükleyip
   * çökmeye devam eder — düzeltmenin kullanıcıya ulaşmasının tek yolu sürüm artışı.
   */
  it("biçim sürümü zehirli dosyaları atacak kadar ileri (>= 3)", () => {
    expect(ONBELLEK_BICIMI).toBeGreaterThanOrEqual(3);
  });

  /**
   * `loadOfflineCache` ilk render'dan ÖNCE, useState başlatıcısında çalışıyor: buradan fırlayan
   * her hata açılış çökmesidir. Dosya nesnesinin kurulumu bile try içinde olmalı.
   */
  it("açılış yolunda try dışında hiçbir iş yok", () => {
    const kaynak = oku("mobile/src/lib/offline-cache.ts");
    const govde = kaynak.slice(
      kaynak.indexOf("export function loadOfflineCache"),
      kaynak.indexOf("function diskeYaz")
    );
    const tryIndex = govde.indexOf("try {");
    // `onbellekDosyasi()` çağrısı try bloğundan SONRA gelmeli (yani içinde).
    expect(govde.indexOf("DOSYA = onbellekDosyasi()")).toBeGreaterThan(tryIndex);
    expect(govde.indexOf("DOSYA.textSync()")).toBeGreaterThan(tryIndex);
    expect(govde.indexOf("hydrate(qc")).toBeGreaterThan(tryIndex);
  });

  it("yeni native paket EKLENMEDİ — parmak izi korunur, OTA kanalı kesilmez", () => {
    const pkg = JSON.parse(oku("mobile/package.json")) as { dependencies: Record<string, string> };
    // async-storage/mmkv/sqlite gibi bir depo paketi eklenirse çalışma parmak izi değişir ve
    // telefon yeni TestFlight derlemesi yüklenene dek güncelleme ALAMAZ.
    expect(pkg.dependencies["@react-native-async-storage/async-storage"]).toBeUndefined();
    expect(pkg.dependencies["react-native-mmkv"]).toBeUndefined();
    expect(pkg.dependencies["expo-sqlite"]).toBeUndefined();
    // Kullanılan modül uygulamada zaten var (expo-asset üzerinden otomatik bağlanıyor).
    expect(oku("mobile/src/lib/offline-cache.ts")).toContain('from "expo-file-system"');
  });

  it("önbellek İLK ÇİZİMDEN ÖNCE yüklenir (boş ekran flaşı olmasın)", () => {
    const provider = oku("mobile/src/lib/query.tsx");
    const useStateIci = provider.slice(
      provider.indexOf("useState(() => {"),
      provider.indexOf("return qc;")
    );
    expect(useStateIci).toContain("loadOfflineCache(qc)");
  });

  it("arka plana geçerken hemen diske yazılır (iOS süreci öldürebilir)", () => {
    const provider = oku("mobile/src/lib/query.tsx");
    expect(provider).toContain("flushOfflineCache(client)");
    expect(provider).toContain('AppState.addEventListener("change"');
  });

  /**
   * ⚠️ SAHADA YAŞANDI: dosya nesnesi modül düzeyinde kuruluyordu ve `eas update` düştü.
   * Yayın adımı WEB çıktısını da üretiyor, expo-router'ı Node içinde çalıştırıyor; orada
   * `expo-file-system`'in web karşılığı yapıcıda patlıyor. `expo export --platform ios`
   * sorunsuz geçtiği için hata ancak yayın anında görüldü.
   */
  it("dosya nesnesi TEMBEL kurulur — modül yüklenirken değil", () => {
    const kaynak = oku("mobile/src/lib/offline-cache.ts");
    expect(kaynak).not.toMatch(/^(const|let|var)\s+\w+\s*=\s*new File\(/m);
    expect(kaynak).toContain('Platform.OS === "web"');
  });

  /**
   * ⚠️ SAHADA YAŞANDI (aynı gün, ikinci tuzak): yayın öncesi kontrolü kolaylaştırmak için
   * `package.json`'a `check-bundle` betiği eklendi ve iOS parmak izi 05bc725f… → 66cbc9ec…
   * oldu. `packageJson:scripts` çalışma parmak izinin BİR KAYNAĞI: betik eklemek yayını YENİ
   * bir çalışma sürümüne gönderir, telefondaki uygulama güncellemeyi HİÇ görmez. Sessiz kopma;
   * ancak "neden güncelleme gelmiyor" diye bakınca fark edilir.
   */
  it("mobil betik listesi sabit — parmak izi kaynağı", () => {
    const pkg = JSON.parse(oku("mobile/package.json")) as { scripts: Record<string, string> };
    expect(Object.keys(pkg.scripts).sort()).toEqual([
      "android",
      "check-core",
      "deploy:testflight",
      "ios",
      "lint",
      "reset-project",
      "start",
      "sync-core",
      "web",
    ]);
  });

  it("bayat veri damgayla gösterilir — sessizce eski rakam gösterilmez", () => {
    const header = oku("mobile/src/components/kit/Header.tsx");
    expect(header).toContain("FreshnessStamp");
    for (const ekran of ["index", "orders", "products", "atolye"]) {
      expect(oku(`mobile/src/app/(tabs)/${ekran}.tsx`), `${ekran} damgası`).toContain("updatedAt=");
    }
  });
});
