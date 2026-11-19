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

/**
 * 19 Kas 2026 — "hiçbir şey açılmıyor". Sunucu yavaşlayınca her zaman aşımı + yeniden deneme,
 * sunucuda süren İKİ sorgu bırakıyordu (istemci kesse de Turso çalıştırmaya devam ediyor);
 * üst üste bindikçe en basit sorgu bile saniyelerce bekledi. Suçlu sorgu ise ancak Turso'nun
 * panelinden bulunabildi — uygulamanın kendi kaydında sorgunun adı yoktu.
 */
describe("sunucu yavaşken yük ikiye katlanmaz", () => {
  const iptalEden = () => {
    let cagri = 0;
    const sahte = async () => {
      cagri++;
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    return { sahte, sayi: () => cagri };
  };

  it("yeniden deneme de başarısız olduysa sonraki iptaller YENİDEN DENENMEZ", async () => {
    const m = await import("./db-fetch-timeout");
    m.dbOlaylariSifirla();
    const ilk = iptalEden();
    await expect(m.withDbFetchTimeout(ilk.sahte, 50)("http://x", { body: "SELECT 1" })).rejects.toThrow();
    expect(ilk.sayi(), "ilk istek bir kez yeniden denenir").toBe(2);

    const ikinci = iptalEden();
    await expect(m.withDbFetchTimeout(ikinci.sahte, 50)("http://x", { body: "SELECT 2" })).rejects.toThrow();
    expect(ikinci.sayi(), "soğuma süresinde ısrar edilmez").toBe(1);
    expect(m.dbOlaylari().ozet["yeniden-atlandi"]).toBe(1);
  });

  it("soğuma süresi dolunca yeniden deneme geri gelir", async () => {
    const m = await import("./db-fetch-timeout");
    m.dbOlaylariSifirla();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const ilk = iptalEden();
      await expect(m.withDbFetchTimeout(ilk.sahte, 50)("http://x", { body: "SELECT 1" })).rejects.toThrow();
      vi.setSystemTime(Date.now() + m.YENIDEN_SOGUTMA_MS + 1);
      const sonra = iptalEden();
      await expect(m.withDbFetchTimeout(sonra.sahte, 50)("http://x", { body: "SELECT 1" })).rejects.toThrow();
      expect(sonra.sayi()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("BAŞARILI yeniden deneme freni tetiklemez (ölü bağlantı her seferinde kurtarılır)", async () => {
    const m = await import("./db-fetch-timeout");
    m.dbOlaylariSifirla();
    for (let tur = 0; tur < 3; tur++) {
      let cagri = 0;
      const sahte = async () => {
        cagri++;
        if (cagri === 1) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        return { ok: true };
      };
      await expect(m.withDbFetchTimeout(sahte, 50)("http://x", { body: "SELECT 1" })).resolves.toEqual({ ok: true });
      expect(cagri).toBe(2);
    }
    expect(m.dbOlaylari().ozet["yeniden-atlandi"]).toBe(0);
  });
});

describe("yavaş ve iptal olan sorgu ADIYLA kaydedilir", () => {
  it("gövdeden yalnız SQL metnini alır — parametre değerlerini ALMAZ", async () => {
    const { sorguBasi } = await import("./db-fetch-timeout");
    const govde = JSON.stringify({
      baton: null,
      requests: [
        { type: "execute", stmt: { sql: 'SELECT "id"\n  FROM "Product"   WHERE "barcode" = ?', args: [{ type: "text", value: "GIZLI-8690000000001" }] } },
        { type: "close" },
      ],
    });
    const bas = sorguBasi(govde);
    expect(bas).toBe('SELECT "id" FROM "Product" WHERE "barcode" = ?');
    expect(bas).not.toContain("GIZLI");
    expect(sorguBasi("SELECT 1")).toBe("SELECT 1");
    expect(sorguBasi('{"requests":[{"type":"close"}]}')).toBeUndefined();
    expect(sorguBasi(null)).toBeUndefined();
    expect(sorguBasi("x".repeat(500))?.length).toBe(160);
  });

  it("iptal olan Request isteğinin sorgusu özetin başında görünür", async () => {
    const m = await import("./db-fetch-timeout");
    m.dbOlaylariSifirla();
    const sahte = async (input: unknown, init?: { signal?: AbortSignal }) => {
      await new Request(input as Request, init as RequestInit).text();
      return takilanFetch(init);
    };
    const istek = new Request("https://db.example/v3/pipeline", {
      method: "POST",
      body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql: "SELECT id, contentMd5 FROM ProductModelFile", args: [] } }] }),
    });
    await expect(m.withDbFetchTimeout(sahte, 40)(istek)).rejects.toThrow();
    const ozet = m.dbSorguOzeti();
    expect(ozet[0]?.sql).toBe("SELECT id, contentMd5 FROM ProductModelFile");
    expect(ozet[0]?.iptal).toBe(1);
    expect(ozet[0]?.toplamMs).toBeGreaterThanOrEqual(30);
  });

  it("yavaş ama başarılı sorgu da adıyla kaydedilir", async () => {
    const m = await import("./db-fetch-timeout");
    m.dbOlaylariSifirla();
    process.env.MLHUB_DB_SLOW_MS = "300";
    try {
      const sahte = async () => {
        await new Promise((r) => setTimeout(r, 330));
        return { ok: true };
      };
      await m.withDbFetchTimeout(sahte, 5_000)("http://x", { body: "SELECT * FROM PrinterStatusSample" });
    } finally {
      delete process.env.MLHUB_DB_SLOW_MS;
    }
    expect(m.dbSorguOzeti()[0]).toMatchObject({ sql: "SELECT * FROM PrinterStatusSample", adet: 1, iptal: 0 });
  });
});

/**
 * GÖVDE BEKÇİSİ (19 Kas 2026): zaman aşımı yanıt başlıkları gelince bitiyordu; gövde inerken
 * soket ölürse istek dakikalarca asılı kalıyor ve kilit bütün sorguları bekletiyordu.
 */
describe("yanıt gövdesi yarıda kalırsa istek asılı kalmaz", () => {
  /** Başlıkları hemen veren, gövdesini elle akıtan sahte yanıt. */
  function akanYanit() {
    let denetci!: ReadableStreamDefaultController<Uint8Array>;
    const govde = new ReadableStream<Uint8Array>({ start(c) { denetci = c; } });
    const yanit = new Response(govde, { status: 200, headers: { "content-type": "application/json" } });
    const kodla = (s: string) => new TextEncoder().encode(s);
    return { yanit, gonder: (s: string) => denetci.enqueue(kodla(s)), bitir: () => denetci.close() };
  }

  it("gövde hiç akmazsa okuyan taraf sessizlik süresi dolunca hata alır", async () => {
    const { govdeBekcisi } = await import("./db-fetch-timeout");
    const { yanit, gonder } = akanYanit();
    gonder('{"yarim":');
    const sarili = govdeBekcisi(yanit, new AbortController(), 60) as Response;
    const bas = Date.now();
    await expect(sarili.text()).rejects.toThrow(/yarıda kaldı/);
    expect(Date.now() - bas).toBeLessThan(1_000);
  });

  it("yavaş ama AKAN gövde kesilmez (her parça sayacı sıfırlar)", async () => {
    const { govdeBekcisi } = await import("./db-fetch-timeout");
    const { yanit, gonder, bitir } = akanYanit();
    const sarili = govdeBekcisi(yanit, new AbortController(), 80) as Response;
    const okuma = sarili.json();
    for (const parca of ['{"satir', 'lar":[1,', "2,3]}"]) {
      await new Promise((r) => setTimeout(r, 50)); // her aralık sessizlik süresinden kısa, toplamı uzun
      gonder(parca);
    }
    bitir();
    expect(await okuma).toEqual({ satirlar: [1, 2, 3] });
  });

  it("sağlıklı yanıt durum, başlık ve içerik olarak aynen geçer", async () => {
    const { withDbFetchTimeout } = await import("./db-fetch-timeout");
    const sahte = async () => new Response('{"ok":true}', { status: 200, headers: { "x-ornek": "1" } });
    const r = (await withDbFetchTimeout(sahte, 5_000)("https://ornek", { body: "SELECT 1" })) as Response;
    expect(r.status).toBe(200);
    expect(r.ok).toBe(true);
    expect(r.headers.get("x-ornek")).toBe("1");
    expect(await r.json()).toEqual({ ok: true });
  });

  it("gövdesiz yanıt ve yanıt olmayan değerler dokunulmadan döner", async () => {
    const { govdeBekcisi } = await import("./db-fetch-timeout");
    const bos = new Response(null, { status: 204 });
    expect(govdeBekcisi(bos, new AbortController(), 50)).toBe(bos);
    const duz = { ok: true };
    expect(govdeBekcisi(duz, new AbortController(), 50)).toBe(duz);
  });

  it("okuyan taraf vazgeçerse (iptal) alttaki akış da bırakılır, sayaç kalmaz", async () => {
    const { govdeBekcisi } = await import("./db-fetch-timeout");
    let birakildi = false;
    const govde = new ReadableStream<Uint8Array>({ pull() {}, cancel() { birakildi = true; } });
    const sarili = govdeBekcisi(new Response(govde), new AbortController(), 40) as Response;
    await sarili.body!.cancel("artık gerek yok");
    expect(birakildi).toBe(true);
    await new Promise((r) => setTimeout(r, 60)); // sayaç kaldıysa burada patlardı
  });
});
