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

/** Telefondan komut gönder → masaüstü relay'i ~10sn içinde uygular. */
export async function sendPrintCommand(printerConfigId: string, action: PrintAction, modelFileId?: string): Promise<void> {
  const id = "cmd_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  await execute(
    `INSERT INTO PrintCommand (id, printerConfigId, action, modelFileId, status, source, createdAt)
     VALUES (?, ?, ?, ?, 'pending', 'mobile', ?)`,
    [id, printerConfigId, action, modelFileId ?? null, new Date().toISOString()]
  );
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
