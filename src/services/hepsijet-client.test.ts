/**
 * HEPSIJET bağlantısı — giriş, token önbelleği, hata mesajları, ayarların saklanması.
 *
 * İstek biçimi HepsiJet dokümanının cURL örneğinden: POST /auth/token, başlıklar `X-Origin:
 * integration` + `X-Client-Id: hj-integration`, yanıtta `data.token` + `data.company` + `data.xdock`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HepsijetClient, HepsijetHatasi, hepsijetTokenlariniTemizle, yerListesi } from "./hepsijet-client";

const kimlik = { ortam: "test" as const, kullaniciAdi: "deneme_kullanici", sifre: "deneme-sifre" };

interface Cagri { url: string; method: string; headers: Record<string, string>; body: unknown }
let cagrilar: Cagri[];
let yanitla: (c: Cagri) => { status: number; body?: unknown };

const girisYaniti = {
  status: "OK",
  data: {
    token: "tkn-1",
    company: { name: "ÖRNEK MAĞAZA", abbreviationCode: "ORNKMGZ" },
    xdock: { name: "MENEMEN", abbreviationCode: "ORNKMGZMENEMEN" },
  },
};

beforeEach(() => {
  hepsijetTokenlariniTemizle();
  cagrilar = [];
  yanitla = () => ({ status: 200, body: girisYaniti });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const c: Cagri = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    cagrilar.push(c);
    const { status, body } = yanitla(c);
    return { ok: status < 400, status, text: async () => (body === undefined ? "" : JSON.stringify(body)) } as unknown as Response;
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("giriş", () => {
  it("dokümandaki cURL ile aynı istek; hesabın şirket ve şubesi döner", async () => {
    const hesap = await new HepsijetClient(kimlik).girisYap();
    expect(cagrilar).toHaveLength(1);
    expect(cagrilar[0].url).toBe("https://integration-apitest.hepsijet.com/auth/token");
    expect(cagrilar[0].method).toBe("POST");
    expect(cagrilar[0].headers).toMatchObject({
      "Content-Type": "application/json", "X-Origin": "integration", "X-Client-Id": "hj-integration",
    });
    expect(cagrilar[0].body).toEqual({ username: "deneme_kullanici", password: "deneme-sifre" });
    expect(hesap).toEqual({
      sirketAdi: "ÖRNEK MAĞAZA", sirketKodu: "ORNKMGZ", aktarmaAdi: "MENEMEN", aktarmaKodu: "ORNKMGZMENEMEN",
    });
  });

  it("canlı ortam ayrı adrese gider", async () => {
    await new HepsijetClient({ ...kimlik, ortam: "prod" }).girisYap();
    expect(cagrilar[0].url).toBe("https://integration.hepsijet.com/auth/token");
  });

  it("yanlış şifre / token'sız yanıt → anlaşılır mesaj; sunucu hatası ve ağ kopması ayrı", async () => {
    // Sahadaki yanıt (19 Kas 2026): 401 {"status":"FAIL","message":"Kullanıcı Adı veya Parola Hatalı"}
    yanitla = () => ({ status: 401, body: { status: "FAIL", message: "Kullanıcı Adı veya Parola Hatalı" } });
    await expect(new HepsijetClient(kimlik).girisYap()).rejects.toThrow(/kabul etmedi/);
    hepsijetTokenlariniTemizle();
    yanitla = () => ({ status: 200, body: { status: "FAIL", message: "Bad credentials" } });
    await expect(new HepsijetClient(kimlik).girisYap()).rejects.toThrow(/kabul etmedi/);
    hepsijetTokenlariniTemizle();
    yanitla = () => ({ status: 503 });
    await expect(new HepsijetClient(kimlik).girisYap()).rejects.toThrow(/yanıt vermiyor/);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const hata = await new HepsijetClient(kimlik).girisYap().catch((e) => e);
    expect(hata).toBeInstanceOf(HepsijetHatasi);
    expect(hata.message).toMatch(/ulaşılamadı/);
  });
});

describe("hesap kilitlenmesin", () => {
  it("reddedilen bilgi yeniden SUNUCUYA GİTMEZ; şifre değişince hemen denenir", async () => {
    yanitla = () => ({ status: 401, body: { status: "FAIL" } });
    await expect(new HepsijetClient(kimlik).girisYap()).rejects.toThrow(/kabul etmedi/);
    await expect(new HepsijetClient(kimlik).girisYap()).rejects.toThrow(/az önce reddedildi/);
    // Arka plan yolu (liste isteği → giriş) da aynı kilide takılır.
    await expect(new HepsijetClient(kimlik).iller()).rejects.toThrow(/az önce reddedildi/);
    expect(cagrilar).toHaveLength(1);

    yanitla = () => ({ status: 200, body: girisYaniti });
    await new HepsijetClient({ ...kimlik, sifre: "duzeltilmis-sifre" }).girisYap();
    expect(cagrilar).toHaveLength(2);
  });

  it("süre dolunca aynı bilgi yeniden denenebilir; başarılı giriş kilidi kaldırır", async () => {
    vi.useFakeTimers();
    try {
      yanitla = () => ({ status: 401, body: { status: "FAIL" } });
      await expect(new HepsijetClient(kimlik).girisYap()).rejects.toThrow(/kabul etmedi/);
      vi.advanceTimersByTime(5 * 60_000 + 1000);
      yanitla = () => ({ status: 200, body: girisYaniti });
      await new HepsijetClient(kimlik).girisYap();
      await new HepsijetClient(kimlik).girisYap();
      expect(cagrilar).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("askıya alınmış hesap (423) ayrı söylenir ve yarım saat hiç denenmez", async () => {
    // Sahadaki yanıt: 423 {"status":"FAIL","message":"Hesabınız askıya alınmıştır! …"}
    yanitla = () => ({ status: 423, body: { status: "FAIL", message: "Hesabınız askıya alınmıştır!" } });
    const hata = await new HepsijetClient(kimlik).girisYap().catch((e) => e);
    expect(hata).toBeInstanceOf(HepsijetHatasi);
    expect(hata.message).toMatch(/askıya almış/);
    expect(hata.durum).toBe(423);
    await expect(new HepsijetClient(kimlik).girisYap()).rejects.toThrow(/askıya almış/);
    expect(cagrilar).toHaveLength(1);
  });
});

describe("il / ilçe listeleri", () => {
  const iller = { status: "OK", data: [{ id: 33, name: "İZMİR" }, { id: 35, name: "MERSİN" }, { id: "x" }, { name: "Adsız" }] };

  it("token bir kez alınır, sonraki istekler onu kullanır", async () => {
    yanitla = (c) => (c.url.endsWith("/auth/token") ? { status: 200, body: girisYaniti } : { status: 200, body: iller });
    const istemci = new HepsijetClient(kimlik);
    expect(await istemci.iller()).toEqual([{ id: 33, ad: "İZMİR" }, { id: 35, ad: "MERSİN" }]);
    await istemci.ilceler(33);
    expect(cagrilar.filter((c) => c.url.endsWith("/auth/token"))).toHaveLength(1);
    expect(cagrilar[1].headers["X-Auth-Token"]).toBe("tkn-1");
    // Standart dağıtım ağı: serviceType BOŞ gönderilir (dokümanın kuralı).
    expect(cagrilar[2].url).toBe(
      "https://integration-apitest.hepsijet.com/settlement/city/33/towns?productCode=HX_STD&serviceType=&deliveryType=MARKET_PLACE",
    );
  });

  it("token erken geçersiz kılındıysa (401) bir kez yeniden giriş yapılır", async () => {
    let ilk = true;
    yanitla = (c) => {
      if (c.url.endsWith("/auth/token")) return { status: 200, body: girisYaniti };
      if (ilk) { ilk = false; return { status: 401 }; }
      return { status: 200, body: iller };
    };
    expect(await new HepsijetClient(kimlik).iller()).toHaveLength(2);
    expect(cagrilar.filter((c) => c.url.endsWith("/auth/token"))).toHaveLength(2);
  });

  it("yanıt zarfı: data içinde ya da çıplak dizi; ad alanı değişebilir", () => {
    expect(yerListesi([{ id: 1, townName: "MENEMEN" }])).toEqual([{ id: 1, ad: "MENEMEN" }]);
    expect(yerListesi({ data: [{ id: 2, districtName: "29 EKİM" }] })).toEqual([{ id: 2, ad: "29 EKİM" }]);
    expect(yerListesi(null)).toEqual([]);
    expect(yerListesi({ data: "x" })).toEqual([]);
  });
});

describe("ayarlar", () => {
  let klasor: string;
  beforeEach(() => {
    klasor = fs.mkdtempSync(path.join(os.tmpdir(), "hj-ayar-"));
    vi.stubEnv("HEPSIJET_SETTINGS_FILE", path.join(klasor, "hepsijet-settings.json"));
    vi.stubEnv("TRENDYOL_CREDENTIAL_KEY", "a".repeat(64));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(klasor, { recursive: true, force: true });
  });

  it("şifre dosyaya düz yazılmaz; test ve canlı ayrı tutulur; boş şifre kayıtlıyı korur", async () => {
    const { hepsijetAcikAyarlar, hepsijetAyarlariniKaydet, hepsijetKimligi } = await import("./hepsijet-settings");
    await expect(hepsijetKimligi()).rejects.toThrow(/girilmedi/);

    await hepsijetAyarlariniKaydet({ ortam: "test", kullaniciAdi: " test_kullanici ", sifre: "gizli-test" });
    const ham = fs.readFileSync(process.env.HEPSIJET_SETTINGS_FILE!, "utf8");
    expect(ham).not.toContain("gizli-test");
    expect(await hepsijetKimligi()).toEqual({ ortam: "test", kullaniciAdi: "test_kullanici", sifre: "gizli-test" });

    await hepsijetAyarlariniKaydet({ ortam: "prod", kullaniciAdi: "canli_kullanici", sifre: "gizli-canli" });
    expect(await hepsijetKimligi()).toEqual({ ortam: "prod", kullaniciAdi: "canli_kullanici", sifre: "gizli-canli" });

    // Teste geri dön, şifreyi yeniden yazmadan: kayıtlı şifre durur.
    await hepsijetAyarlariniKaydet({ ortam: "test", kullaniciAdi: "test_kullanici" });
    expect(await hepsijetKimligi()).toEqual({ ortam: "test", kullaniciAdi: "test_kullanici", sifre: "gizli-test" });
    expect(await hepsijetAcikAyarlar()).toEqual({
      ortam: "test",
      test: { kullaniciAdi: "test_kullanici", sifreVar: true },
      prod: { kullaniciAdi: "canli_kullanici", sifreVar: true },
    });
  });

  it("kullanıcı adı değişince eski şifre atılır (başka kullanıcının şifresiyle denenmez)", async () => {
    const { hepsijetAcikAyarlar, hepsijetAyarlariniKaydet } = await import("./hepsijet-settings");
    await hepsijetAyarlariniKaydet({ ortam: "test", kullaniciAdi: "bir", sifre: "s1" });
    await hepsijetAyarlariniKaydet({ ortam: "test", kullaniciAdi: "iki" });
    expect((await hepsijetAcikAyarlar()).test).toEqual({ kullaniciAdi: "iki", sifreVar: false });
  });
});
