import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "./prisma";
import { getR2Config, listModelObjects, deleteObject } from "./r2";

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

  // 2) R2 orphan süpürme
  try {
    const cfg = await getR2Config();
    if (!cfg) return;
    const objects = await listModelObjects(cfg);
    if (!objects.length) return;
    const rows = await prisma.productModelFile.findMany({
      where: { r2Key: { not: null } },
      select: { r2Key: true },
    });
    const referenced = new Set(rows.map((r) => r.r2Key));
    const cutoff = Date.now() - 24 * 60 * 60_000;
    for (const o of objects) {
      if (referenced.has(o.key)) continue;
      if (!o.lastModified || o.lastModified.getTime() > cutoff) continue; // taze — confirm gelebilir
      await deleteObject(o.key, cfg).catch(() => {});
    }
  } catch { /* ağ/kimlik hatası — bir sonraki açılışta yeniden denenir */ }
}
