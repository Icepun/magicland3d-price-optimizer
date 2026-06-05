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

  let mine: Awaited<ReturnType<typeof prisma.productModelFile.create>> | null = null;
  for (const targetId of targetIds) {
    const sortOrder = await prisma.productModelFile.count({
      where: { productId: targetId, printerConfigId },
    });
    const row = await prisma.productModelFile.create({
      data: {
        productId: targetId,
        printerConfigId,
        label,
        originalName,
        storedPath,
        r2Key,
        fileType,
        sizeBytes,
        gramaj,
        estPrintMin,
        sortOrder,
      },
    });
    if (targetId === productId) mine = row;
  }
  return mine;
}
