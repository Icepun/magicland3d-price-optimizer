import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64url,
  base64urlCoz,
  hmacSha256,
  kimlikCoz,
  kimlikPaketle,
  ortakAnahtar,
  ortakCoz,
  ortakSifrele,
  sha256,
  utf8,
  utf8Coz,
} from "./ortak-kimlik";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const nonce = (n = 7) => Uint8Array.from({ length: 16 }, (_, i) => (i * 31 + n) & 255);

describe("ortak kimlik — saf SHA-256 Node kriptosuyla aynı", () => {
  it("SHA-256: boş, blok sınırları (55/56/64 bayt), uzun ve Türkçe metin", () => {
    for (const metin of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "x".repeat(1000), "Şükrü ığdır ÇÖĞÜ 🚚"]) {
      expect(hex(sha256(utf8(metin)))).toBe(crypto.createHash("sha256").update(metin, "utf8").digest("hex"));
    }
  });

  it("HMAC-SHA256: kısa ve 64 bayttan uzun anahtar", () => {
    for (const anahtar of ["k", "a".repeat(64), "b".repeat(130)]) {
      const beklenen = crypto.createHmac("sha256", anahtar).update("mesaj", "utf8").digest("hex");
      expect(hex(hmacSha256(utf8(anahtar), utf8("mesaj")))).toBe(beklenen);
    }
  });

  it("UTF-8 ve base64url Node ile aynı, gidiş-dönüş kayıpsız", () => {
    const metin = "n11 · Hepsiburada — ğüşiöç 😀";
    expect(Buffer.from(utf8(metin)).toString("utf8")).toBe(metin);
    expect(utf8Coz(utf8(metin))).toBe(metin);
    for (const n of [0, 1, 2, 3, 16, 31]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 97) & 255);
      expect(base64url(b)).toBe(Buffer.from(b).toString("base64url"));
      expect(hex(base64urlCoz(base64url(b)) as Uint8Array)).toBe(hex(b));
    }
    expect(base64urlCoz("a")).toBeNull();
    expect(base64urlCoz("ab+c")).toBeNull();
  });
});

describe("ortak kimlik — paket", () => {
  const anahtar = ortakAnahtar("veritabani-erisim-anahtari");

  it("şifrele → çöz aynı metni verir; paket metni içermez", () => {
    const paket = ortakSifrele("gizli-n11-sifresi", anahtar, nonce());
    expect(paket.startsWith("v1.")).toBe(true);
    expect(paket).not.toContain("gizli");
    expect(ortakCoz(paket, anahtar)).toBe("gizli-n11-sifresi");
  });

  it("yanlış anahtar ya da bozulmuş paket REDDEDİLİR", () => {
    const paket = ortakSifrele("deger", anahtar, nonce());
    expect(ortakCoz(paket, ortakAnahtar("baska-anahtar"))).toBeNull();
    const [s, n, c, e] = paket.split(".");
    const bozuk = c.slice(0, -1) + (c.endsWith("A") ? "B" : "A");
    expect(ortakCoz([s, n, bozuk, e].join("."), anahtar)).toBeNull();
    expect(ortakCoz("v2." + paket.slice(3), anahtar)).toBeNull();
    expect(ortakCoz("bozuk", anahtar)).toBeNull();
  });

  it("aynı metin farklı nonce ile farklı paket üretir", () => {
    expect(ortakSifrele("x", anahtar, nonce(1))).not.toBe(ortakSifrele("x", anahtar, nonce(2)));
  });

  it("alan haritası gidiş-dönüş; yalnız metin alanlar kalır", () => {
    const alanlar = { appKey: "anahtar", appSecret: "şifre", "test.sifre": "uzun".repeat(40) };
    expect(kimlikCoz(kimlikPaketle(alanlar, anahtar, nonce()), anahtar)).toEqual(alanlar);
    expect(kimlikCoz(ortakSifrele("[1,2]", anahtar, nonce()), anahtar)).toBeNull();
    expect(kimlikCoz(ortakSifrele('{"a":"b","c":3}', anahtar, nonce()), anahtar)).toEqual({ a: "b" });
  });

  it("anahtar, erişim anahtarının baş/son boşluğundan etkilenmez", () => {
    expect(hex(ortakAnahtar(" abc \n"))).toBe(hex(ortakAnahtar("abc")));
  });
});
