/**
 * ORTAK ENTEGRASYON BİLGİLERİ — şifreleme (masaüstü + telefon ortak, saf).
 *
 * Pazaryeri ve kargo bilgileri (Trendyol, Hepsiburada, Shopify, n11, HepsiJet) ortak veritabanında
 * `IntegrationSecret` tablosunda, entegrasyon başına tek şifreli satır olarak durur: bir bilgisayarda
 * girilen bilgi diğer bilgisayarlarda ve telefonda da kullanılır (Berke, 26 Kas 2026: "her cihazda
 * ayrı girmem gerekmesin").
 *
 * ANAHTAR veritabanı erişim anahtarından türetilir (bütün cihazlarda aynı; veritabanını okuyabilen
 * zaten ona sahip). Erişim anahtarı olmadan ele geçen bir kopya (dışa aktarım, yedek) çözülemez.
 * Tablo günlük yedeğe de girmez (bkz. backup-payload `BACKUP_EXCLUDED_MODELS`).
 *
 * YÖNTEM: SHA-256 tabanlı. Akış = HMAC(şifre anahtarı, nonce‖sayaç), metin XOR akış; bütünlük =
 * HMAC(imza anahtarı, sürüm‖nonce‖şifreli metin). Bozuk ya da yanlış anahtarlı paket REDDEDİLİR.
 * Telefonda (Hermes) kripto modülü yok ve yeni yerel paket OTA kanalını keser → SHA-256 burada saf
 * TypeScript; testte Node'un kendi kriptosuyla karşılaştırılır.
 */

export const ORTAK_ENTEGRASYONLAR = ["trendyol", "hepsiburada", "shopify", "n11", "hepsijet"] as const;
export type OrtakEntegrasyon = (typeof ORTAK_ENTEGRASYONLAR)[number];

const SURUM = "v1";

// ── SHA-256 ─────────────────────────────────────────────────────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export function sha256(veri: Uint8Array): Uint8Array {
  const l = veri.length;
  const dolgulu = new Uint8Array(((l + 9 + 63) >> 6) << 6);
  dolgulu.set(veri);
  dolgulu[l] = 0x80;
  const dv = new DataView(dolgulu.buffer);
  const bit = l * 8;
  dv.setUint32(dolgulu.length - 4, bit >>> 0);
  dv.setUint32(dolgulu.length - 8, Math.floor(bit / 0x100000000));

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let i = 0; i < dolgulu.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const cikti = new Uint8Array(32);
  const cv = new DataView(cikti.buffer);
  for (let i = 0; i < 8; i++) cv.setUint32(i * 4, h[i]);
  return cikti;
}

export function hmacSha256(anahtar: Uint8Array, veri: Uint8Array): Uint8Array {
  const k = new Uint8Array(64);
  k.set(anahtar.length > 64 ? sha256(anahtar) : anahtar);
  const ic = new Uint8Array(64 + veri.length);
  const dis = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    ic[i] = k[i] ^ 0x36;
    dis[i] = k[i] ^ 0x5c;
  }
  ic.set(veri, 64);
  dis.set(sha256(ic), 64);
  return sha256(dis);
}

// ── Kodlama (Hermes'te TextEncoder/atob'a güvenmeden) ─────────────────────────

export function utf8(metin: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < metin.length; i++) {
    let c = metin.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < metin.length) {
      const d = metin.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

export function utf8Coz(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; ) {
    const c = b[i++];
    let kod: number;
    if (c < 0x80) kod = c;
    else if (c < 0xe0) kod = ((c & 31) << 6) | (b[i++] & 63);
    else if (c < 0xf0) kod = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    else kod = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    if (kod > 0xffff) {
      kod -= 0x10000;
      s += String.fromCharCode(0xd800 + (kod >> 10), 0xdc00 + (kod & 1023));
    } else s += String.fromCharCode(kod);
  }
  return s;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function base64url(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < b.length) s += B64[(n >> 6) & 63];
    if (i + 2 < b.length) s += B64[n & 63];
  }
  return s;
}

export function base64urlCoz(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const parca = s.slice(i, i + 4);
    let n = 0;
    for (let j = 0; j < 4; j++) n = (n << 6) | (j < parca.length ? B64.indexOf(parca[j]) : 0);
    out.push((n >> 16) & 255);
    if (parca.length > 2) out.push((n >> 8) & 255);
    if (parca.length > 3) out.push(n & 255);
  }
  return Uint8Array.from(out);
}

function birlestir(...parcalar: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parcalar.reduce((t, p) => t + p.length, 0));
  let o = 0;
  for (const p of parcalar) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function sabitZamanliEsit(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let fark = 0;
  for (let i = 0; i < a.length; i++) fark |= a[i] ^ b[i];
  return fark === 0;
}

// ── Paket ───────────────────────────────────────────────────────────────────────

/** Ortak anahtar: veritabanı erişim anahtarından (bütün cihazlarda aynı). */
export function ortakAnahtar(veritabaniAnahtari: string): Uint8Array {
  return sha256(utf8(`mlhub-ortak-kimlik-${SURUM}\n${veritabaniAnahtari.trim()}`));
}

function akis(sifreAnahtari: Uint8Array, nonce: Uint8Array, uzunluk: number): Uint8Array {
  const out = new Uint8Array(uzunluk);
  for (let blok = 0, o = 0; o < uzunluk; blok++, o += 32) {
    const sayac = new Uint8Array(4);
    new DataView(sayac.buffer).setUint32(0, blok);
    out.set(hmacSha256(sifreAnahtari, birlestir(nonce, sayac)).subarray(0, Math.min(32, uzunluk - o)), o);
  }
  return out;
}

function altAnahtarlar(anahtar: Uint8Array) {
  return { sifre: hmacSha256(anahtar, utf8("sifre")), imza: hmacSha256(anahtar, utf8("imza")) };
}

/** `nonce`: 16 rastgele bayt — çağıran üretir (masaüstü node:crypto). Telefon yalnız ÇÖZER. */
export function ortakSifrele(metin: string, anahtar: Uint8Array, nonce: Uint8Array): string {
  if (nonce.length !== 16) throw new Error("nonce 16 bayt olmalı");
  const { sifre, imza } = altAnahtarlar(anahtar);
  const duz = utf8(metin);
  const ks = akis(sifre, nonce, duz.length);
  const sifreli = duz.map((x, i) => x ^ ks[i]);
  const etiket = hmacSha256(imza, birlestir(utf8(SURUM), nonce, sifreli));
  return [SURUM, base64url(nonce), base64url(sifreli), base64url(etiket)].join(".");
}

/** Bozuk, yanlış anahtarlı ya da tanınmayan pakette null. */
export function ortakCoz(paket: string, anahtar: Uint8Array): string | null {
  const [surum, n, c, e] = paket.split(".");
  if (surum !== SURUM || n == null || c == null || e == null) return null;
  const nonce = base64urlCoz(n);
  const sifreli = base64urlCoz(c);
  const etiket = base64urlCoz(e);
  if (!nonce || nonce.length !== 16 || !sifreli || !etiket) return null;
  const { sifre, imza } = altAnahtarlar(anahtar);
  if (!sabitZamanliEsit(etiket, hmacSha256(imza, birlestir(utf8(SURUM), nonce, sifreli)))) return null;
  const ks = akis(sifre, nonce, sifreli.length);
  return utf8Coz(sifreli.map((x, i) => x ^ ks[i]));
}

/** Alan haritası (noktalı yol → düz metin) → paket. */
export function kimlikPaketle(alanlar: Record<string, string>, anahtar: Uint8Array, nonce: Uint8Array): string {
  return ortakSifrele(JSON.stringify(alanlar), anahtar, nonce);
}

/** Paket → alan haritası; çözülemez ya da biçimi bozuksa null. */
export function kimlikCoz(paket: string, anahtar: Uint8Array): Record<string, string> | null {
  const metin = ortakCoz(paket, anahtar);
  if (metin == null) return null;
  try {
    const veri = JSON.parse(metin) as unknown;
    if (!veri || typeof veri !== "object" || Array.isArray(veri)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(veri as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return null;
  }
}
