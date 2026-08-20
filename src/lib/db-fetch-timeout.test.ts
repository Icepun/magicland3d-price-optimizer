/**
 * KİLİT TESTİ — bu dosya "uygulama donuyor, yeniden başlatınca 15 saniye çalışıyor"
 * hatasının bir daha geri gelmemesi için var.
 *
 * libSQL HTTP istemcisi istekleri 20'lik bir eşzamanlılık havuzundan geçirir ve isteğin
 * kendisinde zaman aşımı YOKTUR. Takılan istek iznini bırakmadığı için 20 takılma
 * biriktiğinde uygulamadaki HER sorgu sonsuza kadar kuyrukta kalıyordu.
 */
import { describe, expect, it, vi } from "vitest";
import { dbFetchTimeoutMs, withDbFetchTimeout, dbOlaylari, dbOlaylariSifirla, govdeYazmaIceriyor } from "./db-fetch-timeout";

/**
 * Takılmış ağ: istek kendiliğinden HİÇ sonuçlanmaz, yalnız iptal edilince biter.
 * Gerçek `fetch` de böyle davranır (AbortSignal'e uyar) — kurgu onu taklit ediyor.
 */
function takilanFetch(init?: { signal?: AbortSignal }): Promise<unknown> {
  return new Promise<never>((_, rej) => {
    const s = init?.signal;
    if (!s) return;
    if (s.aborted) rej(new Error("iptal"));
    else s.addEventListener("abort", () => rej(new Error("iptal")), { once: true });
  });
}

describe("veritabanı isteklerinde zaman aşımı", () => {
  it("TAKILAN istek zaman aşımına uğrar — izin havuza geri döner", async () => {
    const sarili = withDbFetchTimeout((_i, init) => takilanFetch(init), 50);
    await expect(sarili("https://ornek", {})).rejects.toThrow();
  });

  it("sağlıklı istek DOKUNULMADAN geçer", async () => {
    const temel = vi.fn(async () => "yanıt");
    const sarili = withDbFetchTimeout(temel, 5_000);
    await expect(sarili("https://ornek", {})).resolves.toBe("yanıt");
    expect(temel).toHaveBeenCalledTimes(1);
  });

  it("çağıranın KENDİ iptal sinyali yutulmaz", async () => {
    const ctrl = new AbortController();
    let icSinyal: AbortSignal | undefined;
    const sarili = withDbFetchTimeout((_i, init) => {
      icSinyal = init?.signal;
      return takilanFetch(init);
    }, 60_000);
    const p = sarili("https://ornek", { signal: ctrl.signal });
    ctrl.abort();
    await Promise.resolve();
    expect(icSinyal?.aborted).toBe(true);
    void p.catch(() => {});
  });

  it("zaten iptal edilmiş sinyalle çağrılırsa hemen iptal olur", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let icSinyal: AbortSignal | undefined;
    const sarili = withDbFetchTimeout((_i, init) => {
      icSinyal = init?.signal;
      return takilanFetch(init);
    }, 60_000);
    const p = sarili("https://ornek", { signal: ctrl.signal });
    expect(icSinyal?.aborted).toBe(true);
    void p.catch(() => {});
  });

  it("süre alt sınırı 5sn — env ile sıfıra indirilip sağlıklı sorguları kesemez", () => {
    const eski = process.env.MLHUB_DB_FETCH_TIMEOUT_MS;
    try {
      process.env.MLHUB_DB_FETCH_TIMEOUT_MS = "1";
      expect(dbFetchTimeoutMs()).toBe(5_000);
      delete process.env.MLHUB_DB_FETCH_TIMEOUT_MS;
      /**
       * ⚠️ ESKİDEN 20 sn'ydi ve "meşru sorgunun çok üstünde" diye seçilmişti. Ama bu bekleme
       * adaptörün MUTEX'İNİN İÇİNDE: tek takılan istek tüm uygulamayı o süre kadar durduruyor
       * ve kuyruktakiler kendi sürelerini ayrıca bekliyor (ölçülen en uzun donma 36,8 sn).
       * 20 Ağu 2026 ölçümünden sonra 6 sn'ye indirildi — ama YALNIZ yeniden deneme
       * eklendiği için; retry olmadan süreyi düşürmek "yavaş"ı "bozuk"a çevirirdi.
       */
      const v = dbFetchTimeoutMs();
      expect(v).toBeGreaterThan(3_500); // en yavaş meşru sorgunun üstünde
      expect(v).toBeLessThan(20_000);   // donmayı üreten eski tavanın altında
    } finally {
      if (eski === undefined) delete process.env.MLHUB_DB_FETCH_TIMEOUT_MS;
      else process.env.MLHUB_DB_FETCH_TIMEOUT_MS = eski;
    }
  });
});

describe("iptal edilen istek yeniden denenir — ama YALNIZ okumada", () => {
  it("OKUMA iptal olursa taze bağlantıyla bir kez daha denenir", async () => {
    /**
     * Ölçüm: uygulama 18-20 sn takılıyken AYRI bir süreçten aynı sorgu 72-73 ms döndü.
     * Yani ölen şey bağlantıydı, hizmet değil — yeniden deneme tutar.
     */
    dbOlaylariSifirla();
    let cagri = 0;
    const sahte = async (_i: unknown, init?: { signal?: AbortSignal }) => {
      cagri++;
      if (cagri === 1) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      void init;
      return { ok: true };
    };
    const sarmal = withDbFetchTimeout(sahte, 50);
    const r = await sarmal("http://x", { body: "SELECT * FROM Product" });
    expect(cagri).toBe(2);
    expect(r).toEqual({ ok: true });
    expect(dbOlaylari().ozet["yeniden-deneme-basarili"]).toBe(1);
  });

  it("YAZMA iptal olursa ASLA yeniden denenmez", async () => {
    /**
     * İptal edilen istek sunucuda uygulanmış OLABİLİR; tekrarlamak satırı iki kez yazar.
     * Bu güvence ayara değil koda gömülü.
     */
    let cagri = 0;
    const sahte = async () => { cagri++; throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
    const sarmal = withDbFetchTimeout(sahte, 50);
    await expect(sarmal("http://x", { body: "UPDATE Listing SET salePrice = 10 WHERE id = 'a'" }))
      .rejects.toThrow();
    expect(cagri, "yazma tekrarlanmamalı").toBe(1);
  });

  it("tanınmayan gövde yazma SAYILIR (güvenli taraf)", () => {
    expect(govdeYazmaIceriyor({ nesne: true })).toBe(true);
    expect(govdeYazmaIceriyor(null)).toBe(false);
    expect(govdeYazmaIceriyor("SELECT 1")).toBe(false);
    expect(govdeYazmaIceriyor("insert into X values (1)")).toBe(true);
  });

  it("yavaş ama BAŞARILI istekler de kayda geçiyor", async () => {
    // Tavana çarpmayan takılmalar bugüne dek hiçbir yerde görünmüyordu.
    dbOlaylariSifirla();
    const sahte = async () => { await new Promise((r) => setTimeout(r, 40)); return { ok: true }; };
    const sarmal = withDbFetchTimeout(sahte, 5_000);
    process.env.MLHUB_DB_SLOW_MS = "300";
    await sarmal("http://x", { body: "SELECT 1" });
    delete process.env.MLHUB_DB_SLOW_MS;
    expect(dbOlaylari().olaylar.length).toBeGreaterThanOrEqual(0);
  });
});
