/**
 * KİLİT TESTİ — bu dosya "uygulama donuyor, yeniden başlatınca 15 saniye çalışıyor"
 * hatasının bir daha geri gelmemesi için var.
 *
 * libSQL HTTP istemcisi istekleri 20'lik bir eşzamanlılık havuzundan geçirir ve isteğin
 * kendisinde zaman aşımı YOKTUR. Takılan istek iznini bırakmadığı için 20 takılma
 * biriktiğinde uygulamadaki HER sorgu sonsuza kadar kuyrukta kalıyordu.
 */
import { describe, expect, it, vi } from "vitest";
import { dbFetchTimeoutMs, withDbFetchTimeout } from "./db-fetch-timeout";

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
      // Varsayılan, ölçülen en yavaş meşru sorgunun (~3,5sn) çok üstünde olmalı.
      expect(dbFetchTimeoutMs()).toBeGreaterThanOrEqual(20_000);
    } finally {
      if (eski === undefined) delete process.env.MLHUB_DB_FETCH_TIMEOUT_MS;
      else process.env.MLHUB_DB_FETCH_TIMEOUT_MS = eski;
    }
  });
});
