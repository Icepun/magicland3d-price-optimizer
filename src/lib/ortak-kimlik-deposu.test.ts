import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ remotePrisma: { integrationSecret: { findUnique: h.findUnique, upsert: h.upsert } } }));
vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: vi.fn(async () => {}) }));

import { encryptSecret, tryDecryptSecret } from "@/lib/crypto";
import {
  duzMetinHaritasi,
  ortakIleBirlestir,
  ortakKimlikleriEsitle,
  yuklemeGerekli,
  type KimlikTanimi,
} from "./ortak-kimlik-deposu";

const HEPSIJET: KimlikTanimi = {
  ad: "hepsijet",
  dosyaYolu: () => "",
  gizli: ["test.sifre", "prod.sifre"],
  acik: ["ortam", "test.kullaniciAdi", "prod.kullaniciAdi"],
};
const HB: KimlikTanimi = {
  ad: "hepsiburada",
  dosyaYolu: () => "",
  gizli: ["secretKey", "username", "password"],
  acik: ["merchantId", "developerUsername", "environment"],
};

beforeAll(() => {
  vi.stubEnv("TRENDYOL_CREDENTIAL_KEY", "test-yerel-anahtar");
});

describe("ortak kimlik deposu", () => {
  it("yerel şifreli kayıt → düz metin harita (iç içe alanlar, boşlar girmez)", () => {
    const kayit = { ortam: "prod", prod: { kullaniciAdi: "magic", sifre: encryptSecret("gizli") }, test: { kullaniciAdi: "" } };
    expect(duzMetinHaritasi(HEPSIJET, kayit)).toEqual({ ortam: "prod", "prod.kullaniciAdi": "magic", "prod.sifre": "gizli" });
  });

  it("ortak kayıt yerelin YERİNE geçer: gizli alan bu bilgisayarın anahtarıyla şifrelenir, ortakta olmayan tanımlı alan silinir", () => {
    const yerel = { merchantId: "eski", password: encryptSecret("eski-sifre"), baskaAlan: "kalsin" };
    const sonuc = ortakIleBirlestir(HB, yerel, { merchantId: "yeni", secretKey: "yeni-anahtar", developerUsername: "dev" }) as Record<string, string>;
    expect(sonuc.merchantId).toBe("yeni");
    expect(tryDecryptSecret(sonuc.secretKey)).toBe("yeni-anahtar");
    expect(sonuc.secretKey).not.toContain("yeni-anahtar");
    expect(sonuc.password).toBeUndefined(); // ortakta yok → eski yerel şifre dirilmez
    expect(sonuc.baskaAlan).toBe("kalsin"); // tanım dışı alana dokunulmaz
    expect(yerel.merchantId).toBe("eski"); // girdi değişmez
  });

  it("iç içe alan da birleşir", () => {
    const sonuc = ortakIleBirlestir(HEPSIJET, {}, { ortam: "test", "test.kullaniciAdi": "u", "test.sifre": "s" }) as {
      ortam: string;
      test: { kullaniciAdi: string; sifre: string };
    };
    expect(sonuc.ortam).toBe("test");
    expect(sonuc.test.kullaniciAdi).toBe("u");
    expect(tryDecryptSecret(sonuc.test.sifre)).toBe("s");
  });

  it("açılış eşitlemesi: ortakta yoksa yükle; aynıysa yükleme; farklıysa en son kaydedilen kazanır", () => {
    const a = { appKey: "a", appSecret: "b" };
    expect(yuklemeGerekli({ yerel: a, yerelMs: 100, ortak: null, ortakMs: null })).toBe(true);
    expect(yuklemeGerekli({ yerel: {}, yerelMs: 100, ortak: null, ortakMs: null })).toBe(false);
    expect(yuklemeGerekli({ yerel: a, yerelMs: 500, ortak: { appSecret: "b", appKey: "a" }, ortakMs: 100 })).toBe(false);
    // Bu bilgisayardaki bilgi daha ESKİ → başka bilgisayarda girilen yeni bilgi ezilmez.
    expect(yuklemeGerekli({ yerel: a, yerelMs: 100, ortak: { appKey: "yeni", appSecret: "b" }, ortakMs: 500 })).toBe(false);
    // Bu bilgisayardaki daha YENİ → yüklenir.
    expect(yuklemeGerekli({ yerel: a, yerelMs: 900, ortak: { appKey: "eski", appSecret: "b" }, ortakMs: 500 })).toBe(true);
  });
});

describe("açılış eşitlemesi — yüklemeden önce salt okunur deneme", () => {
  function n11Tanimi() {
    const klasor = fs.mkdtempSync(path.join(os.tmpdir(), "ortak-kimlik-"));
    const dosya = path.join(klasor, "n11-settings.json");
    fs.writeFileSync(dosya, JSON.stringify({ appKey: encryptSecret("anahtar"), appSecret: encryptSecret("sifre") }));
    const tanim: KimlikTanimi = { ad: "n11", dosyaYolu: () => dosya, gizli: ["appKey", "appSecret"], acik: [] };
    return { tanim, klasor };
  }

  it("çalışmayan bilgi ortak kayda YÜKLENMEZ ve aynı dosya ikinci açılışta yeniden DENENMEZ", async () => {
    vi.stubEnv("TURSO_AUTH_TOKEN", "erisim");
    h.findUnique.mockReset().mockResolvedValue(null);
    h.upsert.mockReset();
    const { tanim, klasor } = n11Tanimi();
    const dogrula = vi.fn(async () => {
      throw new Error("401");
    });
    await ortakKimlikleriEsitle([tanim], { n11: dogrula });
    await ortakKimlikleriEsitle([tanim], { n11: dogrula });
    expect(dogrula).toHaveBeenCalledTimes(1);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(klasor, "ortak-kimlik-denemeleri.json"))).toBe(true);
  });

  it("çalışan bilgi, dosyanın kaydedilme anıyla yüklenir (başka bilgisayardaki yeniyi ezmesin)", async () => {
    vi.stubEnv("TURSO_AUTH_TOKEN", "erisim");
    h.findUnique.mockReset().mockResolvedValue(null);
    h.upsert.mockReset().mockResolvedValue({});
    const { tanim } = n11Tanimi();
    const dogrula = vi.fn(async () => {});
    await ortakKimlikleriEsitle([tanim], { n11: dogrula });
    expect(dogrula).toHaveBeenCalledWith({ appKey: "anahtar", appSecret: "sifre" });
    expect(h.upsert).toHaveBeenCalledTimes(1);
    const veri = h.upsert.mock.calls[0][0].create;
    expect(veri.name).toBe("n11");
    expect(veri.updatedAtMs).toBe(fs.statSync(tanim.dosyaYolu()).mtimeMs);
    expect(veri.payload).not.toContain("anahtar");
  });

  it("veritabanı anahtarı yoksa (yerel veritabanı) hiçbir şey yapmaz", async () => {
    vi.stubEnv("TURSO_AUTH_TOKEN", "");
    h.findUnique.mockReset();
    const { tanim } = n11Tanimi();
    await ortakKimlikleriEsitle([tanim], {});
    expect(h.findUnique).not.toHaveBeenCalled();
  });
});
