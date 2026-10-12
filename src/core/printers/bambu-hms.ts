/**
 * BAMBU UYARI / HATA KODU SÖZLÜĞÜ — üreticinin RESMİ Türkçe açıklamaları.
 *
 * NEDEN VAR (12 Eki 2026): kart "AMS — Yazıcı ciddi bir uyarı veriyor" diyordu; kullanıcı
 * yazıcının başına gidince filamentin bittiğini görüyordu. Kodun anlamı hiç okunmuyordu — yalnız
 * hangi birimden geldiği ve önem düzeyi yazılıyordu. Geçmiş bildirimlerde 34 kez "AMS — ciddi
 * uyarı", 20 kez "Ana kart — ciddi uyarı" var; hiçbiri ne olduğunu söylemiyor.
 *
 * Sözlük `bambu-hms-tr.json` — Bambu Studio'nun kullandığı uçtan üretilir, elle düzenlenmez:
 *   node scripts/bambu-hms-guncelle.mjs
 * Burada metin UYDURULMAZ: kod sözlükte yoksa null döner, çağıran genel bir cümleye düşer.
 */
import veri from "./bambu-hms-tr.json";

interface HmsSozlugu {
  surum: string;
  hms: Record<string, string>;
  err: Record<string, string>;
  modelHms: Record<string, Record<string, string>>;
  modelErr: Record<string, Record<string, string>>;
}

const sozluk = veri as unknown as HmsSozlugu;

/** Yazıcının seri numarasından model öneki (ilk 3 hane; A1: 039, A2L: 26A). */
export function bambuModelOneki(seri: string | null | undefined): string | null {
  const s = (seri ?? "").trim().toUpperCase();
  return s.length >= 3 ? s.slice(0, 3) : null;
}

const temizKod = (kod: string) => kod.replace(/[^0-9a-fA-F]/g, "").toUpperCase();

/**
 * HMS uyarısının açıklaması. `kod` "0700-2300-0002-0005" ya da 16 haneli düz hâliyle verilebilir.
 * Model öneki verilirse o modele özel metin önceliklidir.
 */
export function hmsAciklamasi(kod: string, modelOneki?: string | null): string | null {
  const k = temizKod(kod);
  if (k.length !== 16) return null;
  return (modelOneki && sozluk.modelHms[modelOneki]?.[k]) || sozluk.hms[k] || null;
}

/** `print.print_error` sayısını üreticinin 8 haneli koduna çevir ("12038011"). 0/geçersiz → null. */
export function bambuHataKodu(printError: number | null | undefined): string | null {
  if (typeof printError !== "number" || !Number.isFinite(printError) || printError === 0) return null;
  return (printError >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

/** Baskı hata kodunun (`print_error`) açıklaması — yazıcının ekranında çıkan cümle. */
export function bambuHataAciklamasi(
  printError: number | null | undefined,
  modelOneki?: string | null
): string | null {
  const k = bambuHataKodu(printError);
  if (!k) return null;
  return (modelOneki && sozluk.modelErr[modelOneki]?.[k]) || sozluk.err[k] || null;
}

/** Sözlüğün üretildiği liste sürümü (tanılama için). */
export const BAMBU_HMS_SURUMU = sozluk.surum;
