import fs from "node:fs";
import path from "node:path";
import { getUserDataDir } from "@/lib/storage";

/**
 * Kargo etiketlerinin YEREL kaydı — Trendyol ve Hepsiburada ortak.
 *
 * • Kopya (`userData/etiketler/<anahtar>.zpl`): yazıcıya gidecek SON hâl. Aynı etiketi ikinci kez
 *   basarken pazaryerine gidilmez (etiket bir gönderi için değişmez).
 * • Basılanlar (`etiket-basilanlar.json`): arayüzdeki "basıldı" işareti.
 * İkisi de 60 günde süpürülür — kopyalar müşteri adresi taşıyor.
 * Anahtar: takip/teslimat numarası (her iki pazaryerinde de gönderiye özgü).
 */

const KOPYA_KLASORU = "etiketler";
const BASILANLAR_DOSYASI = "etiket-basilanlar.json";
const SAKLAMA_MS = 60 * 24 * 60 * 60 * 1000;

/** Anahtar dosya adına girer → yalnız güvenli karakterler. */
export function takipNoTemizle(ham: unknown): string | null {
  const s = String(ham ?? "").trim();
  return /^[A-Za-z0-9-]{4,40}$/.test(s) ? s : null;
}

function kopyaYolu(anahtar: string): string {
  return path.join(getUserDataDir(), KOPYA_KLASORU, `${anahtar}.zpl`);
}

/** Kayıtlı etiket(ler) — her biri ^XA…^XZ; yoksa null. */
export function kopyaOku(anahtar: string): string[] | null {
  try {
    const metin = fs.readFileSync(kopyaYolu(anahtar), "utf8");
    const parcalar = metin.match(/\^XA[\s\S]*?\^XZ/g) ?? [];
    return parcalar.length ? parcalar : null;
  } catch {
    return null;
  }
}

export function kopyaKaydet(anahtar: string, etiketler: string[]): void {
  try {
    const yol = kopyaYolu(anahtar);
    fs.mkdirSync(path.dirname(yol), { recursive: true });
    fs.writeFileSync(yol, etiketler.map((e) => e.trim()).join("\n"), "utf8");
  } catch {
    /* kopya isteğe bağlı — basmayı engellemez */
  }
}

/** Yazıcıya gidecek tek parça: koli başına etiketler arka arkaya (her biri ^XA…^XZ). */
export function etiketleriBirlestir(etiketler: string[]): Buffer {
  return Buffer.from(etiketler.map((e) => e.trim()).join("\n") + "\n", "utf8");
}

function basilanlarYolu(): string {
  return path.join(getUserDataDir(), BASILANLAR_DOSYASI);
}

export function basilanlariOku(): Record<string, string> {
  try {
    const veri = JSON.parse(fs.readFileSync(basilanlarYolu(), "utf8")) as unknown;
    if (!veri || typeof veri !== "object") return {};
    const sinir = Date.now() - SAKLAMA_MS;
    const sonuc: Record<string, string> = {};
    for (const [k, v] of Object.entries(veri as Record<string, unknown>)) {
      if (typeof v === "string" && Date.parse(v) >= sinir) sonuc[k] = v;
    }
    return sonuc;
  } catch {
    return {};
  }
}

export function basildiIsaretle(anahtar: string, an = new Date()): string {
  const liste = basilanlariOku();
  liste[anahtar] = an.toISOString();
  try {
    fs.mkdirSync(path.dirname(basilanlarYolu()), { recursive: true });
    fs.writeFileSync(basilanlarYolu(), JSON.stringify(liste, null, 2), "utf8");
  } catch {
    /* işaret isteğe bağlı */
  }
  return liste[anahtar];
}

/** 60 günden eski yerel etiket kopyalarını siler. */
export function eskiKopyalariSupur(): void {
  const klasor = path.join(getUserDataDir(), KOPYA_KLASORU);
  let adlar: string[] = [];
  try {
    adlar = fs.readdirSync(klasor);
  } catch {
    return;
  }
  const sinir = Date.now() - SAKLAMA_MS;
  for (const ad of adlar) {
    const yol = path.join(klasor, ad);
    try {
      if (fs.statSync(yol).mtimeMs < sinir) fs.rmSync(yol, { force: true });
    } catch {
      /* sonraki */
    }
  }
}
