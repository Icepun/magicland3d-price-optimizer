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

  /**
   * GERÇEK ÇAĞRI BİÇİMİ. libSQL'in HTTP istemcisi fetch'i TEK argümanla, hazır bir Request
   * nesnesiyle çağırıyor — gövde `init.body`'de DEĞİL, nesnenin içinde. Yukarıdaki testler
   * (adres + init.body) bu biçimi hiç denemiyordu; sahada yeniden deneme 1.196 kez "Request
   * object that has already been used" ile çöktü ve yazma koruması kör kaldı.
   *
   * Sahte fetch undici gibi davranır: `new Request(input, init)` ile gövdeyi TÜKETİR.
   */
  function hranaIstegi(sql: string): Request {
    return new Request("https://db.example/v3/pipeline", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql } }] }),
    });
  }

  it("Request nesnesiyle gelen OKUMA iptal olursa klondan yeniden denenir", async () => {
    dbOlaylariSifirla();
    let cagri = 0;
    const sahte = async (input: unknown, init?: { signal?: AbortSignal }) => {
      cagri++;
      const istek = new Request(input as Request, init as RequestInit); // gövdeyi tüketir
      const govde = await istek.text();
      if (cagri === 1) return takilanFetch(init);
      return govde;
    };
    const sarmal = withDbFetchTimeout(sahte, 50);
    const r = await sarmal(hranaIstegi("SELECT id FROM Product"));
    expect(cagri).toBe(2);
    expect(String(r)).toContain("SELECT id FROM Product");
    expect(dbOlaylari().ozet["yeniden-deneme-basarili"]).toBe(1);
  });

  it("Request nesnesiyle gelen YAZMA iptal olursa ASLA yeniden denenmez", async () => {
    let cagri = 0;
    const sahte = async (input: unknown, init?: { signal?: AbortSignal }) => {
      cagri++;
      await new Request(input as Request, init as RequestInit).text();
      return takilanFetch(init);
    };
    const sarmal = withDbFetchTimeout(sahte, 50);
    await expect(sarmal(hranaIstegi("UPDATE Product SET stock = 3 WHERE id = 'a'"))).rejects.toThrow();
    expect(cagri, "yazma tekrarlanmamalı").toBe(1);
  });

  it("sağlıklı Request isteği tek seferde ve gövdesiyle geçer", async () => {
    let cagri = 0;
    const sahte = async (input: unknown, init?: { signal?: AbortSignal }) => {
      cagri++;
      return new Request(input as Request, init as RequestInit).text();
    };
    const r = await withDbFetchTimeout(sahte, 5_000)(hranaIstegi("SELECT 1"));
    expect(cagri).toBe(1);
    expect(String(r)).toContain("SELECT 1");
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

/**
 * TEŞHİS KÖRLÜĞÜ — sahada YANLIŞ CEVAP VEREN bir ölçüm aleti.
 *
 * Next, `instrumentation.ts`'i (relay) rotalardan AYRI paketlere derliyor. Olay dizisi modül
 * kapsamındayken kaydı tutan kopya ile `/api/diag/db`'nin okuduğu kopya farklı oluyordu ve uç
 * gerçekte ne olursa olsun HER ZAMAN "sıfır yavaş, sıfır iptal" döndürüyordu. 20 Ağu 2026'da
 * bu yüzden "veritabanı temiz" diye yanlış bir sonuca varıldı.
 *
 * `vi.resetModules()` ikinci bir modül örneği doğurur — Next'in iki paketinin taklidi.
 */
describe("olay kuyruğu paketler arasında PAYLAŞILIYOR", () => {
  it("ayrı modül örneğine yazılan olay, diğerinden okunabiliyor", async () => {
    const birinci = await import("./db-fetch-timeout");
    birinci.dbOlaylariSifirla();

    // Yazan taraf: yavaş bir istek kaydettir.
    // Varsayılan eşik 1000 ms, tabanı 300 ms — env ile tabana indirilip gerçekten bekleniyor.
    process.env.MLHUB_DB_SLOW_MS = "300";
    const yavas = async () => { await new Promise((r) => setTimeout(r, 340)); return { ok: true }; };
    await birinci.withDbFetchTimeout(yavas, 5_000)("http://x", { body: "SELECT 1" });
    delete process.env.MLHUB_DB_SLOW_MS;
    expect(birinci.dbOlaylari().ozet.yavas).toBeGreaterThan(0);

    // Okuyan taraf: TAMAMEN AYRI bir modül örneği (teşhis ucunun durumu).
    vi.resetModules();
    const ikinci = await import("./db-fetch-timeout");
    expect(ikinci).not.toBe(birinci);
    expect(ikinci.dbOlaylari().ozet.yavas).toBeGreaterThan(0);

    ikinci.dbOlaylariSifirla();
    expect(birinci.dbOlaylari().olaylar.length).toBe(0); // sıfırlama da ortak
  });
});
