import { execute, query } from "@/lib/turso";

/** Masaüstü relay'inin yazdığı canlı yazıcı durumu (telefon bunu okur). */
export interface PrinterSnapshot {
  printerConfigId: string;
  name: string;
  brand: string;
  status: string; // printing | paused | finished | idle | error | offline
  online: number; // 0/1
  productName: string | null;
  productImage: string | null;
  progress: number; // 0..1
  nozzle: number;
  bed: number;
  currentFilename: string | null;
  etaSec: number | null;
  updatedAt: string;
}

export async function getPrinterSnapshots(): Promise<PrinterSnapshot[]> {
  return query<PrinterSnapshot>(
    `SELECT s.printerConfigId, s.name, s.brand, s.status, s.online, s.productName, s.productImage,
            s.progress, s.nozzle, s.bed, s.currentFilename, s.etaSec, s.updatedAt
       FROM PrinterSnapshot s
       JOIN PrinterConfig c ON c.id = s.printerConfigId AND c.enabled = 1
      ORDER BY c.sortOrder ASC, c.createdAt ASC`
  );
}

export interface PrintableModel {
  fileId: string;
  productId: string;
  productName: string;
  imageUrl: string | null;
  label: string | null;
  originalName: string;
  sizeBytes: number;
  gramaj: number | null;
}

export async function getPrintableModels(printerConfigId: string): Promise<PrintableModel[]> {
  return query<PrintableModel>(
    `SELECT m.id AS fileId, m.productId, p.name AS productName, p.imageUrl AS imageUrl,
            m.label, m.originalName, m.sizeBytes, m.gramaj
       FROM ProductModelFile m JOIN Product p ON p.id = m.productId
      WHERE m.printerConfigId = ?
      ORDER BY m.sortOrder ASC`,
    [printerConfigId]
  );
}

export type PrintAction = "start" | "pause" | "resume" | "cancel";

/** Telefondan komut gönder → masaüstü relay'i ~10sn içinde uygular. Komut id'sini döndürür
 *  (getRecentCommands ile durumu — pending/done/error — izlenebilsin). */
export async function sendPrintCommand(
  printerConfigId: string,
  action: PrintAction,
  modelFileId?: string
): Promise<string> {
  const id = "cmd_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  await execute(
    `INSERT INTO PrintCommand (id, printerConfigId, action, modelFileId, status, source, createdAt)
     VALUES (?, ?, ?, ?, 'pending', 'mobile', ?)`,
    [id, printerConfigId, action, modelFileId ?? null, new Date().toISOString()]
  );
  return id;
}

export interface RecentCommand {
  id: string;
  printerConfigId: string;
  action: string;
  status: string; // pending | done | error
  error: string | null;
  createdAt: string;
}

export async function getRecentCommands(): Promise<RecentCommand[]> {
  return query<RecentCommand>(
    `SELECT id, printerConfigId, action, status, error, createdAt
       FROM PrintCommand ORDER BY createdAt DESC LIMIT 20`
  );
}

/** Özel baskı arşivi — ürüne bağlı OLMAYAN yüklenmiş baskı dosyaları (sentinel productId='__custom__').
 *  Masaüstü /api/custom-print ile birebir; ait olduğu yazıcı bilgisi + bulut/yerel (r2Key) işareti. */
export interface CustomPrint {
  id: string;
  printerConfigId: string;
  originalName: string;
  fileType: string;
  sizeBytes: number;
  gramaj: number | null;
  estPrintMin: number | null;
  isCloud: number; // 0/1 — r2Key doluysa bulut (her cihazdan), değilse yerel
  createdAt: string;
  printerName: string | null;
  printerBrand: string | null;
  printerType: string | null; // moonraker | bambu (telefondan başlatma moonraker-only)
  printerAccent: string | null;
  printerEnabled: number | null; // 0/1
}

export async function getCustomPrints(): Promise<CustomPrint[]> {
  return query<CustomPrint>(
    `SELECT m.id, m.printerConfigId, m.originalName, m.fileType, m.sizeBytes, m.gramaj, m.estPrintMin,
            (m.r2Key IS NOT NULL) AS isCloud, m.createdAt,
            c.name AS printerName, c.brand AS printerBrand, c.type AS printerType,
            c.accent AS printerAccent, c.enabled AS printerEnabled
       FROM ProductModelFile m
       LEFT JOIN PrinterConfig c ON c.id = m.printerConfigId
      WHERE m.productId = '__custom__'
      ORDER BY m.createdAt DESC`
  );
}
