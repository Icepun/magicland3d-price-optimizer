/**
 * TELEFONA 3B — masaüstü kartındaki canlı 3B'nin (KartUcBoyut) telefondaki karşılığı için
 * görselleştirme paketini ve plaka görselini R2'ye koyar, imzalı okuma adreslerini yazıcı
 * ayrıntısına (`PrinterSnapshot.detail`) ekletir.
 *
 * NEDEN: telefon gcode'a ulaşamaz, 178 MB'lık dosyayı tarayıp paket de üretemez. Masaüstü bu
 * paketi zaten üretiyor (pack-server.ts, diskte önbellekli); burada yalnız sıkıştırılıp bir kez
 * buluta konur. Telefondaki izleyici paketi doğrudan R2'den indirir (kova CORS'u `*`).
 *
 * YÜK: paket DOSYA başına bir kez üretilir ve bir kez yüklenir (anahtar içerik özetinden —
 * aynı dosya yeniden basılınca R2'deki nesne kullanılır). İşler SIRAYLA yürür: aynı anda tek
 * tarama/yükleme, relay turunu hiç bekletmez (`vizDurumu` eşzamanlı döner, hazırlığı kuyruğa atar).
 *
 * ⚠️ Anahtar önekleri `viz/` ve `plates/` — depo hademesinin sildiği `models/`/`meshes/`ten
 * AYRI (bkz. r2.ts makeMeshKey notu). Eskiyenleri burada süpürülür.
 */
import zlib from "node:zlib";
import { promisify } from "node:util";
import { prisma } from "@/lib/prisma";
import { getR2Config, headObjectSize, listModelObjects, deleteObject, presignGetUrl, putObjectBytes } from "@/lib/r2";
import { resolvePrintModel, type PrintModelInfo } from "@/lib/print-model-resolve";
import { getVizPack, packCacheKey } from "@/lib/gcode-viz/pack-server";
import { processSingleton } from "./process-singleton";

const gzip = promisify(zlib.gzip);

/** İmzalı adresin ömrü; yarısı dolunca tazelenir (telefon eskisini indirirken geçersizleşmesin). */
const ADRES_OMRU_SN = 24 * 3600;
const TAZELEME_MS = (ADRES_OMRU_SN * 1000) / 2;
/** Eşleşme/paket bulunamadıysa bu süre yeniden denenmez (her relay turunda sorgu atılmasın). */
const YOK_BEKLEME_MS = 5 * 60_000;
/** Beklenmeyen hatadan sonra yeniden deneme. */
const HATA_BEKLEME_MS = 2 * 60_000;
/** Bundan büyük paket telefona gönderilmez — indirme ve telefon belleği için fazla. */
export const AZAMI_PAKET_BAYT = 40 * 1024 * 1024;
/** Bu kadar eski (son değişiklik) 3B paketi/plaka görseli süpürülür; yeniden basılırsa tekrar yüklenir. */
const SUPURME_YASI_MS = 45 * 24 * 3600_000;

export interface VizDurumu {
  viz: { url: string; key: string } | null;
  plateUrl: string | null;
}

interface Kayit {
  durum: "hazir" | "yok" | "hata";
  viz: { url: string; key: string } | null;
  plateUrl: string | null;
  /** R2'deki plaka görselinin anahtarı — tazelemede yeniden aranmasın. */
  plateKey?: string | null;
  /** Adreslerin tazelenmesi gereken an (hazırda) ya da yeniden denemenin serbest kalacağı an. */
  sonraki: number;
}

const kayitlar = processSingleton("viz_kayitlar", () => new Map<string, Kayit>());
const kuyruk = processSingleton("viz_kuyruk", () => ({
  calisiyor: false,
  bekleyen: [] as { anahtar: string; yaziciId: string; dosya: string }[],
  supuruldu: false,
}));

const kayitAnahtari = (yaziciId: string, dosya: string) => `${yaziciId}::${dosya}`;

/**
 * Relay turundan çağrılır — BEKLETMEZ. Hazır olanı döner; yoksa ya da tazelenmesi gerekiyorsa
 * hazırlığı kuyruğa atar (sonraki turlarda hazır olur).
 */
export function vizDurumu(yaziciId: string, dosya: string | null): VizDurumu {
  if (!dosya) return { viz: null, plateUrl: null };
  const anahtar = kayitAnahtari(yaziciId, dosya);
  const k = kayitlar.get(anahtar);
  if (!k || Date.now() >= k.sonraki) kuyrugaEkle(anahtar, yaziciId, dosya);
  return k?.durum === "hazir" ? { viz: k.viz, plateUrl: k.plateUrl } : { viz: null, plateUrl: null };
}

function kuyrugaEkle(anahtar: string, yaziciId: string, dosya: string): void {
  if (kuyruk.bekleyen.some((b) => b.anahtar === anahtar)) return;
  kuyruk.bekleyen.push({ anahtar, yaziciId, dosya });
  if (!kuyruk.calisiyor) void kuyruguIsle();
}

async function kuyruguIsle(): Promise<void> {
  if (kuyruk.calisiyor) return;
  kuyruk.calisiyor = true;
  try {
    for (;;) {
      const is = kuyruk.bekleyen.shift();
      if (!is) break;
      // Uyku/uyanma koruması (relay ile aynı bayrak): ağ işine girme, sonra yeniden denenir.
      if ((globalThis as { __MLHUB_DB_PAUSED__?: boolean }).__MLHUB_DB_PAUSED__) {
        kayitlar.set(is.anahtar, { durum: "hata", viz: null, plateUrl: null, sonraki: Date.now() + 30_000 });
        continue;
      }
      try {
        kayitlar.set(is.anahtar, await hazirla(is.yaziciId, is.dosya, kayitlar.get(is.anahtar)));
      } catch {
        const onceki = kayitlar.get(is.anahtar);
        // Hazır bir kayıt varken tazeleme düştüyse eldekini koru (adres hâlâ geçerli).
        kayitlar.set(is.anahtar, onceki?.durum === "hazir"
          ? { ...onceki, sonraki: Date.now() + HATA_BEKLEME_MS }
          : { durum: "hata", viz: null, plateUrl: null, sonraki: Date.now() + HATA_BEKLEME_MS });
      }
    }
    if (!kuyruk.supuruldu) {
      kuyruk.supuruldu = true;
      void eskileriSupur().catch(() => {});
    }
  } finally {
    kuyruk.calisiyor = false;
  }
}

/** İçerik özetinden anahtar — pack-server'ın disk önbelleğiyle AYNI kural (biçim sürümü dahil). */
export function vizNesneAnahtari(model: Pick<PrintModelInfo, "id" | "contentMd5" | "sizeBytes">): string {
  return `viz/${packCacheKey(model)}.mlvz`;
}

/** Veri adresini (data:image/png;base64,…) bayt + türe çevir; değilse null. */
export function veriAdresiniCoz(v: string | null | undefined): { tur: string; uzanti: string; bayt: Buffer } | null {
  const m = /^data:(image\/(png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(v?.trim() ?? "");
  if (!m) return null;
  const bayt = Buffer.from(m[3].replace(/\s+/g, ""), "base64");
  if (!bayt.length) return null;
  const uzanti = m[2].toLowerCase() === "jpeg" ? "jpg" : m[2].toLowerCase();
  return { tur: m[1].toLowerCase(), uzanti, bayt };
}

async function hazirla(yaziciId: string, dosya: string, onceki: Kayit | undefined): Promise<Kayit> {
  const cfg = await getR2Config();
  if (!cfg) return { durum: "yok", viz: null, plateUrl: null, sonraki: Date.now() + YOK_BEKLEME_MS };
  const model = await resolvePrintModel(yaziciId, dosya);
  if (!model) return { durum: "yok", viz: null, plateUrl: null, sonraki: Date.now() + YOK_BEKLEME_MS };

  // ── 3B paketi ──
  let viz: Kayit["viz"] = null;
  const vizAnahtari = vizNesneAnahtari(model);
  const bulutta = onceki?.viz?.key === vizAnahtari || (await headObjectSize(vizAnahtari, cfg)) != null;
  if (!bulutta) {
    const paket = await getVizPack(model.id); // diskte varsa anında; yoksa BİR KEZ taranır
    if (paket.bytes.byteLength <= AZAMI_PAKET_BAYT) {
      const sikisik = await gzip(paket.bytes, { level: 6 });
      await putObjectBytes(vizAnahtari, new Uint8Array(sikisik), "application/octet-stream", cfg, {
        contentEncoding: "gzip",
        // İçerik anahtarı değişmez → WebView önbelleği güvenle tutabilir.
        cacheControl: "private, max-age=31536000, immutable",
      });
      viz = { url: await presignGetUrl(vizAnahtari, cfg, ADRES_OMRU_SN), key: vizAnahtari };
    }
  } else {
    viz = { url: await presignGetUrl(vizAnahtari, cfg, ADRES_OMRU_SN), key: vizAnahtari };
  }

  // ── Plaka görseli (dilimleyicinin önizlemesi) ──
  // Görsel kayıtta veri adresi olarak duruyor (yüzlerce KB); satıra gömülmez, R2'ye bir kez konur.
  let plateKey: string | null = null;
  if (model.thumbnailVar) {
    const onek = `plates/${model.id.replace(/[^A-Za-z0-9_-]/g, "_")}.`;
    if (onceki?.plateKey?.startsWith(onek)) {
      plateKey = onceki.plateKey;
    } else {
      const satir = await prisma.productModelFile.findUnique({ where: { id: model.id }, select: { thumbnail: true } });
      const gorsel = veriAdresiniCoz(satir?.thumbnail);
      if (gorsel) {
        plateKey = `${onek}${gorsel.uzanti}`;
        if ((await headObjectSize(plateKey, cfg)) == null) {
          await putObjectBytes(plateKey, new Uint8Array(gorsel.bayt), gorsel.tur, cfg, {
            cacheControl: "private, max-age=31536000, immutable",
          });
        }
      }
    }
  }
  const plateUrl = plateKey ? await presignGetUrl(plateKey, cfg, ADRES_OMRU_SN) : null;

  return { durum: "hazir", viz, plateUrl, plateKey, sonraki: Date.now() + TAZELEME_MS };
}

/** Uzun süredir basılmayan dosyaların paketleri/görselleri — oturumda bir kez. */
async function eskileriSupur(): Promise<void> {
  const cfg = await getR2Config().catch(() => null);
  if (!cfg) return;
  const sinir = Date.now() - SUPURME_YASI_MS;
  const kullanimda = new Set<string>();
  for (const k of kayitlar.values()) if (k.viz) kullanimda.add(k.viz.key);
  for (const onek of ["viz/", "plates/"] as const) {
    const nesneler = await listModelObjects(cfg, onek).catch(() => []);
    for (const n of nesneler) {
      if (kullanimda.has(n.key)) continue;
      if (n.lastModified && n.lastModified.getTime() < sinir) await deleteObject(n.key, cfg).catch(() => {});
    }
  }
}
