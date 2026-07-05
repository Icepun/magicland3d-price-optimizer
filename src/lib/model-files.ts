import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "./prisma";
import { getR2Config, getObjectBytes } from "./r2";

export interface LocalModelFile {
  /** Okunabilir yerel yol (R2 ise geçici dosya, değilse storedPath). */
  path: string;
  /** Geçici dosyayı siler (yerel dosyaya dokunmaz). İşin bitince çağır. */
  cleanup: () => void;
}

/**
 * Bir model dosyasını YEREL bir yola çözer: R2'deyse buluttan çekip geçici dosyaya yazar; değilse
 * yerel storedPath'i döner. Yol bekleyen okuyuculara (readModelColors / readModelMeta / is3mfSliced)
 * verilir. cleanup() yalnız geçici dosyayı siler. Bulunamazsa/erişilemezse hata fırlatır.
 */
export async function resolveModelFileLocal(mf: {
  r2Key: string | null;
  storedPath: string;
  fileType: string;
}): Promise<LocalModelFile> {
  if (mf.r2Key) {
    const cfg = await getR2Config();
    if (!cfg) throw new Error("Bulut depolama (R2) ayarlı değil — Ayarlar → Cloud Depolama'dan gir.");
    const buf = await getObjectBytes(mf.r2Key, cfg);
    const safeExt = (mf.fileType || "gcode").replace(/[^a-z0-9]/gi, "") || "gcode";
    const tmp = path.join(os.tmpdir(), `mlfile-${crypto.randomUUID()}.${safeExt}`);
    await fs.promises.writeFile(tmp, buf);
    return { path: tmp, cleanup: () => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } } };
  }
  if (!fs.existsSync(mf.storedPath)) {
    throw new Error("Dosya bu cihazda yok (başka bilgisayarda yüklenmiş olabilir)");
  }
  return { path: mf.storedPath, cleanup: () => {} };
}

export interface CreateModelRowsInput {
  productId: string;
  applyToVariants: boolean;
  printerConfigId: string;
  originalName: string;
  fileType: string;
  sizeBytes: number;
  label?: string | null;
  gramaj?: number | null;
  estPrintMin?: number | null;
  /** Yerel disk yolu (R2'ye yüklenenlerde boş ""). */
  storedPath?: string;
  /** Cloudflare R2 anahtarı (yerel dosyalarda null). */
  r2Key?: string | null;
  /** Yükleme anında BİR KEZ parse edilen dosya metası (renkler + dilimlenmişlik) — baskı/renk-eşleme
      dosyayı yeniden açmasın (R2 indirmesi + senkron unzip donması biter). */
  colorsJson?: string | null;
  sliced?: boolean | null;
}

/**
 * Hedef ürünleri (kendisi veya "tüm varyantlara uygula" ise tüm grup üyeleri) çözer ve her birine
 * BİR ProductModelFile satırı oluşturur. Dosya bayt'ları tek kez yazıldı/R2'ye yüklendi
 * (storedPath / r2Key ORTAK) → her üyeye yalnız bir metadata satırı (duplicate yok). Silme rotası
 * ortak referans (r2Key veya storedPath) son satıra kadar dosyayı tutar.
 *
 * Yerel upload, R2 confirm ve custom-print aynı bu yardımcıyı kullanır → fan-out mantığı tek yerde.
 */
export async function createModelRows(input: CreateModelRowsInput) {
  const { productId, applyToVariants, printerConfigId, originalName, fileType, sizeBytes } = input;
  const label = input.label ?? null;
  const gramaj = input.gramaj ?? null;
  const estPrintMin = input.estPrintMin ?? null;
  const storedPath = input.storedPath ?? "";
  const r2Key = input.r2Key ?? null;
  const colorsJson = input.colorsJson ?? null;
  const sliced = input.sliced ?? null;

  // Hedef ürünler (kendisi / "tüm varyantlara uygula" ise grup üyeleri) — TÜM okumalar yazmadan ÖNCE.
  let targetIds: string[] = [productId];
  if (applyToVariants) {
    const self = await prisma.product.findUnique({
      where: { id: productId },
      select: { variantGroupId: true },
    });
    if (self?.variantGroupId) {
      const members = await prisma.product.findMany({
        where: { variantGroupId: self.variantGroupId },
        select: { id: true },
      });
      if (members.length) targetIds = members.map((m) => m.id);
    }
  }

  // sortOrder için her hedefin mevcut parça sayısı — TEK sorgu. (Eski döngü-içi count her yinelemede
  // bir önceki create'ten SONRA okuma yapıyordu → bulut replica senkron beklemesi → donma.)
  const counts = await prisma.productModelFile.groupBy({
    by: ["productId"],
    where: { productId: { in: targetIds }, printerConfigId },
    _count: { _all: true },
  });
  const countMap = new Map(counts.map((c) => [c.productId, c._count._all]));
  const common = { printerConfigId, label, originalName, storedPath, r2Key, fileType, sizeBytes, gramaj, estPrintMin, colorsJson, sliced };

  // ANA ürün: create → id'li satırı döndürür. İstemci bunu cache'e ekler → yükleme sonrası refetch
  // GEREKMEZ (yazma-sonrası-okuma blokajı/donma yok).
  const mine = await prisma.productModelFile.create({
    data: { ...common, productId, sortOrder: countMap.get(productId) ?? 0 },
  });

  // VARYANTLAR: tek createMany (eskiden N ayrı bulut yazması, her biri ~1sn → artık tek yazma).
  const siblings = targetIds.filter((t) => t !== productId);
  if (siblings.length) {
    await prisma.productModelFile.createMany({
      data: siblings.map((t) => ({ ...common, productId: t, sortOrder: countMap.get(t) ?? 0 })),
    });
  }
  return mine;
}
