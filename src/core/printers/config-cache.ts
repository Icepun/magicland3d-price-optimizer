/**
 * YAZICI YAPILANDIRMASI — KISA ÖMÜRLÜ ÖNBELLEK.
 *
 * Panel açıkken her 5 saniyede birkaç yazıcı ucu birden çağrılıyor (slotlar, depolama,
 * parçalar, plaka önizlemesi…) ve her biri AYNI satır için ayrı bir `printerConfig` sorgusu
 * açıyordu. Uzak-HTTP libSQL'de her sorgu ~96 ms ve HEPSİ süreç genelinde SIRALI — yani bu
 * yoklamalar, kullanıcının açmaya çalıştığı sayfanın sorgularıyla aynı tek şeritte kuyruğa
 * giriyordu. Ölçülen etki: yazıcı sayısı × uç sayısı kadar boşuna tur.
 *
 * Yapılandırma neredeyse hiç değişmez; değiştiğinde `printerCfgCacheClear()` çağrılır
 * (ayar kaydetme yolları bunu yapar). Bu yüzden kısa TTL güvenli.
 *
 * ⚠️ SADECE OKUYAN yollar için. Bir uç, okuduğu satıra dayanıp veri YAZACAKSA taze okumalı.
 *
 * ⚠️ Durum `globalThis` üzerinde tutulur: Next, instrumentation ile rotaları ayrı paketlere
 * derliyor ve modül kapsamındaki değişken İKİ kopya oluyor.
 */
import { prisma } from "@/lib/prisma";
import { processSingleton } from "./process-singleton";

/** Bu süre içinde aynı yazıcı tekrar sorulursa veritabanına gidilmez. */
const TTL_MS = 15_000;

type Satir = Record<string, unknown> & { id: string };

interface Kayit {
  at: number;
  cfg: Satir | null;
  ucus: Promise<Satir | null> | null; // aynı anda gelen istekler tek sorguyu paylaşsın
}

const onbellek = processSingleton("yazici_cfg_onbellek", () => new Map<string, Kayit>());

/** Yapılandırmayı önbellekten döner; yoksa/bayatsa bir kez sorar. */
export async function printerCfgCached<T = Satir>(id: string): Promise<T | null> {
  const k = onbellek.get(id);
  if (k && Date.now() - k.at < TTL_MS) return k.cfg as T | null;
  if (k?.ucus) return (await k.ucus) as T | null;

  const ucus = prisma.printerConfig
    .findUnique({ where: { id } })
    .then((r) => {
      onbellek.set(id, { at: Date.now(), cfg: (r as Satir | null) ?? null, ucus: null });
      return (r as Satir | null) ?? null;
    })
    .catch((e) => {
      onbellek.delete(id); // hatayı önbelleğe alma — sonraki istek yeniden dener
      throw e;
    });

  onbellek.set(id, { at: k?.at ?? 0, cfg: k?.cfg ?? null, ucus });
  return (await ucus) as T | null;
}

/** Ayar kaydedildiğinde/silindiğinde çağrılır. Kimlik verilmezse tümü boşaltılır. */
export function printerCfgCacheClear(id?: string): void {
  if (id) onbellek.delete(id);
  else onbellek.clear();
}
