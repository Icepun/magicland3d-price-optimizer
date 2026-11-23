import fs from "node:fs/promises";
import path from "node:path";

/**
 * Entegrasyon ayar dosyaları (Trendyol, Hepsiburada, Shopify, HepsiJet) için GÜVENLİ okuma/yazma.
 *
 * Eskiden her okuma hatası "ayar yok" sayılıyordu: dosya yazılırken çökme ya da virüs tarayıcısı
 * kilidi olunca ekran "Bağlı değil" diyor, kullanıcı hatırladığı alanları girip kaydediyor ve
 * öbür anahtarlar boş dosyanın üstüne yazılıp KAYBOLUYORDU (denetim, 23 Kas 2026).
 *  - Dosya hiç yoksa (ENOENT) → boş ayar.
 *  - Bozuk/okunamıyorsa → son iyi yedek (`.yedek`); o da yoksa HATA (kayıt reddedilir).
 *  - Yazma: önce geçici dosya, sonra yeniden adlandırma (yarım dosya kalmaz) + önceki iyi kopya yedeğe.
 */
export class AyarDosyasiOkunamadi extends Error {
  constructor() {
    super("Bağlantı ayarları okunamadı — bilgileri yeniden girmeden önce uygulamayı yeniden başlat.");
    this.name = "AyarDosyasiOkunamadi";
  }
}

async function jsonOku(yol: string): Promise<Record<string, unknown>> {
  const ham = await fs.readFile(yol, "utf8");
  const veri = JSON.parse(ham);
  if (!veri || typeof veri !== "object" || Array.isArray(veri)) throw new Error("geçersiz ayar dosyası");
  return veri as Record<string, unknown>;
}

export async function ayarDosyasiOku<T>(yol: string): Promise<T> {
  try {
    return (await jsonOku(yol)) as T;
  } catch (hata) {
    if ((hata as NodeJS.ErrnoException).code === "ENOENT") return {} as T;
    try {
      return (await jsonOku(`${yol}.yedek`)) as T;
    } catch {
      throw new AyarDosyasiOkunamadi();
    }
  }
}

export async function ayarDosyasiYaz(yol: string, veri: unknown): Promise<void> {
  await fs.mkdir(path.dirname(yol), { recursive: true });
  const gecici = `${yol}.${process.pid}.tmp`;
  await fs.writeFile(gecici, `${JSON.stringify(veri, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // Önceki dosya sağlamsa yedeğe al (bozuk dosya iyi yedeği ezmesin).
  try {
    await jsonOku(yol);
    await fs.copyFile(yol, `${yol}.yedek`);
  } catch {
    /* ilk kayıt ya da bozuk dosya — yedek korunur */
  }
  await fs.rename(gecici, yol);
}
