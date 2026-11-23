import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { remotePrisma } from "./prisma";
import { getR2Config, listModelObjects, deleteObject } from "./r2";
import { perfYaz } from "./server-perf-log";

/**
 * EMNİYET FRENİ — bir turda bundan fazlası "sahipsiz" görünürse HİÇBİRİ silinmez, günlüğe yazılır.
 * Normalde sahipsiz nesne yarım kalmış bir-iki yüklemedir; yüzlercesi yanlış veritabanına bağlı
 * olunduğunu gösterir (denetim, 23 Kas 2026).
 */
const FREN_ADET = 20;
const FREN_ORAN = 0.05;

/**
 * Depo hademesi — oturum başına BİR KEZ, arka planda:
 *  1) Yarım kalan geçici dosyaları süpürür ("mlprint-" ve "mlfile-" önekli temp'ler —
 *     baskı/okuma sırasında çöken akışların artıkları temp'te birikiyordu).
 *  2) R2'de "orphan" kalan model nesnelerini siler: tarayıcı PUT'u başarılı olup confirm
 *     (DB kaydı) başarısız kalırsa nesne bucket'ta sonsuza dek referanssız kalıyordu.
 *     GÜVENLİ: yalnız "models/" öneki + hiçbir ProductModelFile.r2Key'in referans vermediği +
 *     24 saatten eski nesneler (taze yüklemenin confirm'i hâlâ gelebilir → dokunma).
 */
let ran = false;

export async function runStorageJanitor(): Promise<void> {
  if (ran) return;
  ran = true;

  // 1) Temp süpürme (>1 saat eski ml* geçicileri)
  try {
    const tmp = os.tmpdir();
    const names = await fs.promises.readdir(tmp);
    const cutoff = Date.now() - 60 * 60_000;
    for (const n of names) {
      if (!/^ml(print|file)-/.test(n)) continue;
      const p = path.join(tmp, n);
      try {
        const st = await fs.promises.stat(p);
        if (st.isFile() && st.mtimeMs < cutoff) await fs.promises.unlink(p);
      } catch { /* eşzamanlı kullanım/yarış — boşver */ }
    }
  } catch { /* temp okunamadı — kritik değil */ }

  // 2) R2 orphan süpürme — YALNIZ bulut veritabanına bağlıyken. Ayar dosyası bozulup uygulama yerel
  // veritabanıyla açılırsa o veritabanında kaydı olmayan HER baskı dosyası "sahipsiz" görünür ve
  // silinirdi (kalıcı veri kaybı).
  if (!process.env.TURSO_DATABASE_URL?.trim()) return;
  try {
    const cfg = await getR2Config();
    if (!cfg) return;
    const cutoff = Date.now() - 24 * 60 * 60_000;

    /**
     * İKİ ÖNEK, İKİ AYRI KOLON — karıştırılırsa VERİ SİLİNİR.
     * Baskı dosyaları "models/" altında ve `r2Key`'den, kaynak modeller "meshes/" altında ve
     * `meshR2Key`'den referans alıyor. Bir önek yanlış kolonla taranırsa tüm nesneleri
     * sahipsiz sanılır ve silinir.
     */
    const supur = async (
      prefix: "models/" | "meshes/",
      referanslar: Set<string>,
    ): Promise<void> => {
      const objects = await listModelObjects(cfg, prefix);
      const adaylar = objects.filter(
        (o) => !referanslar.has(o.key) && !!o.lastModified && o.lastModified.getTime() <= cutoff, // taze — confirm gelebilir
      );
      if (adaylar.length > FREN_ADET || (objects.length > 0 && adaylar.length / objects.length > FREN_ORAN && adaylar.length > 3)) {
        perfYaz(`DEPO-HADEMESI durdu: ${prefix} ${adaylar.length}/${objects.length} nesne sahipsiz göründü — silinmedi`);
        return;
      }
      for (const o of adaylar) await deleteObject(o.key, cfg).catch(() => {});
    };

    const rows = await remotePrisma.productModelFile.findMany({
      where: { OR: [{ r2Key: { not: null } }, { meshR2Key: { not: null } }] },
      select: { r2Key: true, meshR2Key: true },
    });
    await supur("models/", new Set(rows.map((r) => r.r2Key).filter((k): k is string => !!k)));
    await supur("meshes/", new Set(rows.map((r) => r.meshR2Key).filter((k): k is string => !!k)));
  } catch { /* ağ/kimlik hatası — bir sonraki açılışta yeniden denenir */ }
}
