/**
 * LİSTEDEN KALDIRILAN TIMELAPSE VİDEOLARI.
 *
 * Snapmaker U1'de videolar yazıcıdan SİLİNEMİYOR: `camera` klasörü Moonraker'da salt-okunur
 * (DELETE 405), Snapmaker'ın özel RPC'lerinde silme yok, cihazın MQTT kanalı istemci
 * sertifikası istiyor — hepsi 29 Ağu 2026'da gerçek cihazda ölçüldü.
 *
 * Kullanıcı yine de gereksiz videoları gözünün önünden kaldırabilmeli. Bu liste yalnız
 * UYGULAMADA gizler; dosya yazıcıda durmaya devam eder. Geri alınabilir olması şart —
 * yanlışlıkla kaldırılan video başka türlü bir daha görünmezdi.
 *
 * Depolama: `AppSetting` (anahtar-değer) → yeni tablo/şema sürümü gerekmiyor.
 */
import { prisma } from "@/lib/prisma";

const anahtar = (printerId: string) => `timelapse.hidden.${printerId}`;

/**
 * Kayıtlı JSON'u ad listesine çevir.
 *
 * Bozuk/eski bir değer yüzünden galeri patlamasın: tanımadığımız her şey "gizli yok"
 * demektir — en kötü ihtimalle kullanıcı kaldırdığı videoyu tekrar görür, veri kaybolmaz.
 */
export function adlariCoz(ham: string | null | undefined): string[] {
  if (!ham) return [];
  try {
    const j = JSON.parse(ham);
    if (!Array.isArray(j)) return [];
    return j.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

/** Bir adı listeye ekle/çıkar (sırayı korur, tekrar etmez). */
export function adiUygula(mevcut: string[], name: string, gizli: boolean): string[] {
  const set = mevcut.filter((x) => x !== name);
  return gizli ? [...set, name] : set;
}

export async function gizlenenAdlar(printerId: string): Promise<Set<string>> {
  const row = await prisma.appSetting.findUnique({ where: { key: anahtar(printerId) } });
  return new Set(adlariCoz(row?.value));
}

export async function gizliligiDegistir(printerId: string, name: string, gizli: boolean): Promise<void> {
  const key = anahtar(printerId);
  const row = await prisma.appSetting.findUnique({ where: { key } });
  const value = JSON.stringify(adiUygula(adlariCoz(row?.value), name, gizli));
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}
