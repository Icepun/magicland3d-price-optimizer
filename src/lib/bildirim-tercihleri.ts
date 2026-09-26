import fs from "node:fs";
import path from "node:path";
import { getUserDataDir } from "./storage";
import {
  bildirimTuruBul,
  kapaliListesi,
  kapaliMetni,
  type BildirimTuru,
} from "@/core/bildirim-turleri";

/**
 * BU BİLGİSAYARIN bildirim tercihi — yerel dosyada (userData), veritabanında DEĞİL.
 *
 * Her masaüstü kendi kararını verir: dükkândaki bilgisayar stok uyarısını kapatınca evdeki
 * bilgisayar etkilenmez. Telefonların tercihi ise veritabanında (`PushToken.kapali`), çünkü
 * push'u telefon değil masaüstü gönderiyor.
 *
 * Kapatılan tür hem işletim sistemi bildirimi olarak çıkmaz hem zilde görünmez.
 * Dosya her istekte okunur (birkaç yüz bayt): Next rotaları ve arka plan ayrı paketlerde
 * çalıştığı için bellekte tutulan bir kopya diğer tarafta bayat kalırdı.
 */

const DOSYA_ADI = "bildirim-tercihleri.json";

function dosyaYolu(): string {
  return path.join(getUserDataDir(), DOSYA_ADI);
}

/** Bu bilgisayarda KAPATILAN türler. Dosya yok/bozuk → hepsi açık. */
export function masaustuKapaliOku(): BildirimTuru[] {
  try {
    const ham = JSON.parse(fs.readFileSync(dosyaYolu(), "utf8")) as { kapali?: unknown };
    if (!Array.isArray(ham?.kapali)) return [];
    return kapaliListesi(ham.kapali.filter((x): x is string => typeof x === "string").join(","));
  } catch {
    return [];
  }
}

/** Kaydet (geçici dosya + yeniden adlandırma: yarım yazılmış dosya tercihi sıfırlamasın). */
export function masaustuKapaliYaz(liste: readonly string[]): BildirimTuru[] {
  const temiz = kapaliListesi(kapaliMetni(liste));
  const hedef = dosyaYolu();
  fs.mkdirSync(path.dirname(hedef), { recursive: true });
  const gecici = `${hedef}.${process.pid}.tmp`;
  fs.writeFileSync(gecici, JSON.stringify({ kapali: temiz }, null, 2), "utf8");
  fs.renameSync(gecici, hedef);
  return temiz;
}

/** Bildirim bu bilgisayarda kapatılmış bir türe mi ait? */
export function masaustundeKapali(
  b: { id: string; type?: string | null },
  kapali: readonly BildirimTuru[]
): boolean {
  if (kapali.length === 0) return false;
  const tur = bildirimTuruBul(b);
  return tur !== null && kapali.includes(tur);
}
