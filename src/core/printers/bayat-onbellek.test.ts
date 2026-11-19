import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bayatOnbellek, bayatOnbellegiDusur, TAZELEME_HATA_BEKLEME_MS } from "./bayat-onbellek";

/**
 * Panelin her yoklamada veritabanını BEKLEMESİNİ bitiren önbellek (19 Kas 2026: Kasım'da 400
 * yanıt bu yüzden 3 saniyeyi aştı). Buradaki her test, sahada görülen bir davranışı kilitler.
 */
let sayac = 0;
const yeniAd = () => `test-${++sayac}-${Math.random().toString(36).slice(2)}`;

/** Elle çözülen yükleyici: çağrı sayısını tutar, her çağrı için ayrı söz verir. */
function elleYukleyici<T>() {
  const bekleyen: Array<{ coz: (v: T) => void; reddet: (e: unknown) => void }> = [];
  const yukle = vi.fn(
    () =>
      new Promise<T>((coz, reddet) => {
        bekleyen.push({ coz, reddet });
      })
  );
  return { yukle, bekleyen };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("bayatı hemen ver, arkada tazele", () => {
  it("hiç veri yokken yüklemeyi bekler; eşzamanlı çağrılar TEK sorgu paylaşır", async () => {
    const { yukle, bekleyen } = elleYukleyici<string>();
    const o = bayatOnbellek(yeniAd(), 1_000, yukle);
    const a = o.al();
    const b = o.al();
    const c = o.al();
    expect(yukle).toHaveBeenCalledTimes(1);
    bekleyen[0].coz("veri");
    expect(await Promise.all([a, b, c])).toEqual(["veri", "veri", "veri"]);
  });

  it("veri tazeyken veritabanına gitmez", async () => {
    const yukle = vi.fn(async () => "veri");
    const o = bayatOnbellek(yeniAd(), 1_000, yukle);
    await o.al();
    vi.setSystemTime(Date.now() + 999);
    expect(await o.al()).toBe("veri");
    expect(yukle).toHaveBeenCalledTimes(1);
  });

  it("veri bayatken BEKLETMEZ: eskiyi hemen verir, arkada bir kez tazeler", async () => {
    const { yukle, bekleyen } = elleYukleyici<string>();
    const o = bayatOnbellek(yeniAd(), 1_000, yukle);
    const ilk = o.al();
    bekleyen[0].coz("eski");
    await ilk;

    vi.setSystemTime(Date.now() + 1_500);
    // Tazeleme sorgusu ASKIDA — çağrılar yine de anında dönmeli.
    expect(await o.al()).toBe("eski");
    expect(await o.al()).toBe("eski");
    expect(await o.al()).toBe("eski");
    expect(yukle, "takılan tazeleme varken kopya sorgu açılmaz").toHaveBeenCalledTimes(2);

    bekleyen[1].coz("yeni");
    await Promise.resolve();
    await Promise.resolve();
    expect(await o.al()).toBe("yeni");
  });

  it("tazeleme başarısızsa eski veri kalır ve kısa süre yeniden denenmez", async () => {
    let cagri = 0;
    const yukle = vi.fn(async () => {
      cagri++;
      if (cagri === 1) return "eski";
      throw new Error("veritabanı yanıt vermiyor");
    });
    const o = bayatOnbellek(yeniAd(), 1_000, yukle);
    await o.al();
    vi.setSystemTime(Date.now() + 1_500);
    expect(await o.al()).toBe("eski"); // 2. çağrı arkada başlar ve düşer
    await new Promise((r) => setImmediate(r));
    expect(await o.al()).toBe("eski");
    expect(await o.al()).toBe("eski");
    expect(yukle, "hata sonrası ısrar edilmez").toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + TAZELEME_HATA_BEKLEME_MS + 1);
    expect(await o.al()).toBe("eski");
    expect(yukle, "bekleme dolunca yeniden denenir").toHaveBeenCalledTimes(3);
  });

  it("ilk yükleme başarısızsa hata çağırana ulaşır ve sonraki çağrı yeniden dener", async () => {
    let cagri = 0;
    const yukle = vi.fn(async () => {
      cagri++;
      if (cagri === 1) throw new Error("ilk deneme düştü");
      return "veri";
    });
    const o = bayatOnbellek(yeniAd(), 1_000, yukle);
    await expect(o.al()).rejects.toThrow("ilk deneme düştü");
    expect(await o.al()).toBe("veri");
  });
});

describe("geçersiz kılma", () => {
  it("geçersiz kılınınca sonraki çağrı TAZE veriyi bekler (kullanıcının kendi değişikliği anında görünür)", async () => {
    let surum = 1;
    const yukle = vi.fn(async () => `v${surum}`);
    const o = bayatOnbellek(yeniAd(), 60_000, yukle);
    expect(await o.al()).toBe("v1");
    surum = 2;
    expect(await o.al(), "süre dolmadı, eski veri").toBe("v1");
    o.gecersizKil();
    expect(await o.al()).toBe("v2");
  });

  it("yükleme sürerken geçersiz kılınırsa o yüklemenin ESKİ sonucu saklanmaz", async () => {
    const { yukle, bekleyen } = elleYukleyici<string>();
    const o = bayatOnbellek(yeniAd(), 60_000, yukle);
    const ilk = o.al(); // değişiklikten ÖNCE başlayan okuma
    o.gecersizKil(); // kullanıcı bu sırada bir şey değiştirdi
    const ikinci = o.al(); // değişiklikten sonraki okuma kendi sorgusunu açmalı
    expect(yukle).toHaveBeenCalledTimes(2);
    bekleyen[1].coz("değişiklikten sonra");
    expect(await ikinci).toBe("değişiklikten sonra");
    bekleyen[0].coz("değişiklikten önce"); // geç gelen eski yanıt
    expect(await ilk).toBe("değişiklikten önce");
    expect(await o.al(), "geç gelen eski yanıt taze verinin üstüne yazmaz").toBe("değişiklikten sonra");
  });

  it("adla düşürme, önbelleği kuran taraf başka pakette olsa da çalışır", async () => {
    const ad = yeniAd();
    let surum = 1;
    const o = bayatOnbellek(ad, 60_000, async () => `v${surum}`);
    expect(await o.al()).toBe("v1");
    surum = 2;

    // Next relay'i ve rotaları AYRI paketlere derler: ikinci modül örneği o durumu taklit eder.
    vi.resetModules();
    const diger = await import("./bayat-onbellek");
    expect(diger.bayatOnbellegiDusur).not.toBe(bayatOnbellegiDusur);
    diger.bayatOnbellegiDusur(ad);

    expect(await o.al()).toBe("v2");
  });

  it("iki paketteki örnekler AYNI veriyi paylaşır (relay ile panel çift sorgu atmaz)", async () => {
    const ad = yeniAd();
    const yukle = vi.fn(async () => "ortak");
    const panel = bayatOnbellek(ad, 60_000, yukle);
    await panel.al();
    vi.resetModules();
    const diger = await import("./bayat-onbellek");
    const relayYukle = vi.fn(async () => "relay kendi okudu");
    const relay = diger.bayatOnbellek(ad, 60_000, relayYukle);
    expect(await relay.al()).toBe("ortak");
    expect(relayYukle).not.toHaveBeenCalled();
  });
});
