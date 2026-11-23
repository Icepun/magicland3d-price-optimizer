/**
 * MAKARA ETİKETİ — eşleşme deposu + otomatik uygulayıcı (U1).
 *
 * Akış: makara U1'e takılır → firmware etiketin kimliğini `filament_detect`'e yazar → kalıcı
 * WebSocket aboneliği bunu anında getirir → relay'in yoklaması `makaraEtiketleriniIsle`'yi çağırır →
 * kayıtlı eşleşme varsa renk + tür `filament_detect/set` ile yazıcıya gider. Kayıt yoksa panel
 * "yeni etiket" gösterir; kullanıcı bir kez tanıtır (`api/printers/[id]/makara-etiketi`).
 *
 * Depolama: `AppSetting` (tek JSON, UID → kayıt) — yeni tablo / şema sürümü gerekmez; kayıt sayısı
 * makara sayısı kadar (onlarca). Önbellek `processSingleton`: relay ile rotalar AYRI pakette
 * derlendiği için modül kapsamındaki önbellek iki kopya olur ve kayıttan sonra relay eskiyi görürdü.
 */
import { prisma, remotePrisma } from "@/lib/prisma";
import { processSingleton } from "./process-singleton";
import { bayatOnbellek, bayatOnbellegiDusur } from "./bayat-onbellek";
import {
  etiketKarari, filamentDetectBilgisi, kayitlariCoz,
  type KanalEtiketi, type MakaraEtiketKaydi,
} from "./makara-etiketi";
import { moonrakerEtiketBilgisiYaz } from "./moonraker";

const AYAR_ANAHTARI = "printers.makaraEtiketleri";
const ONBELLEK_MS = 60_000;
/** Aynı kanala aynı bilgiyi art arda göndermeyi önler (WS gecikmesi / ret durumunda döngü). */
const TEKRAR_BEKLEME_MS = 30_000;

const sonDeneme = processSingleton("me_sonDeneme", () => new Map<string, number>());

/**
 * Bayatı HEMEN ver, arkada ayrı bağlantıdan (`remotePrisma`) tazele. Eskiden süre dolunca panelin
 * 2 sn'lik yoklaması ana veritabanı kuyruğunda bu sorguyu BEKLİYOR, hata olunca her yoklama yeniden
 * deniyordu (denetim, 23 Kas 2026). Kayıttan sonra önbellek düşürülür → yeni eşleşme anında görünür.
 */
const ONBELLEK_ADI = "makaraEtiketleri";
const kayitOnbellegi = bayatOnbellek(ONBELLEK_ADI, ONBELLEK_MS, async () => {
  const row = await remotePrisma.appSetting.findUnique({ where: { key: AYAR_ANAHTARI } });
  return kayitlariCoz(row?.value);
});

export async function makaraEtiketKayitlari(): Promise<Record<string, MakaraEtiketKaydi>> {
  try {
    return await kayitOnbellegi.al();
  } catch {
    // Hiç okunamadı (ilk açılış + veritabanı yanıt vermedi): boş — etiket "yeni" görünür, sonraki
    // yoklama yeniden dener (10 sn bekleme bayat-onbellek'te).
    return {};
  }
}

export async function makaraEtiketiKaydet(uid: string, ayar: { renk: string; tip: string }): Promise<MakaraEtiketKaydi> {
  const row = await prisma.appSetting.findUnique({ where: { key: AYAR_ANAHTARI } });
  const tum = kayitlariCoz(row?.value);
  const kayit: MakaraEtiketKaydi = { renk: ayar.renk.toUpperCase(), tip: ayar.tip, guncellendi: new Date().toISOString() };
  tum[uid] = kayit;
  const value = JSON.stringify(tum);
  await prisma.appSetting.upsert({ where: { key: AYAR_ANAHTARI }, create: { key: AYAR_ANAHTARI, value }, update: { value } });
  bayatOnbellegiDusur(ONBELLEK_ADI);
  return kayit;
}

/**
 * Bir U1'in etiketlerini işle: tanımlı olup yazıcıda henüz doğru görünmeyenleri gönder.
 * Baskı sürerken dokunulmaz (firmware her filament değişiminde o kafanın akış ayarını sıfırlıyor) —
 * baskı bitince sıradaki yoklamada uygulanır. Hata yutulur: bu arka plan işi, paneli düşürmemeli.
 */
export async function makaraEtiketleriniIsle(
  host: string,
  port: number,
  etiketler: KanalEtiketi[] | undefined,
  yazdiriyor: boolean,
): Promise<number> {
  if (!etiketler?.length || yazdiriyor) return 0;
  const kayitlar = await makaraEtiketKayitlari();
  let gonderilen = 0;
  for (const e of etiketler) {
    const karar = etiketKarari(e, kayitlar[e.uid]);
    if (karar.tur !== "uygula") continue;
    const anahtar = `${host}:${port}:${e.kanal}:${e.uid}:${karar.kayit.renk}:${karar.kayit.tip}`;
    if (Date.now() - (sonDeneme.get(anahtar) ?? 0) < TEKRAR_BEKLEME_MS) continue;
    sonDeneme.set(anahtar, Date.now());
    try {
      await moonrakerEtiketBilgisiYaz(host, port, e.kanal, filamentDetectBilgisi(e, karar.kayit));
      gonderilen += 1;
      console.info(`[makara-etiketi] ${host} kafa ${e.kanal + 1}: ${e.uid} → ${karar.kayit.tip} #${karar.kayit.renk}`);
    } catch (err) {
      console.warn(`[makara-etiketi] ${host} kafa ${e.kanal + 1} uygulanamadı:`, err instanceof Error ? err.message : err);
    }
  }
  return gonderilen;
}

/** Testler için. */
export function makaraEtiketiOnbellekSifirla(): void {
  bayatOnbellegiDusur(ONBELLEK_ADI);
  sonDeneme.clear();
}
