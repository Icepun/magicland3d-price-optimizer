import { NextResponse } from "next/server";
import { jsonError } from "@/lib/api-error";
import {
  backupsTotalBytes,
  getLastBackupAt,
  isBackupEnabled,
  listBackups,
  runBackupNow,
} from "@/lib/backup-job";

export const dynamic = "force-dynamic";

/** Yedek listesi + son yedek zamanı. */
export async function GET() {
  try {
    const backups = listBackups();
    return NextResponse.json({
      enabled: isBackupEnabled(),
      lastBackupAt: await getLastBackupAt(),
      keep: 30,
      totalBytes: backupsTotalBytes(),
      backups,
    });
  } catch (e) {
    return jsonError(e);
  }
}

/** Şimdi yedekle (elle tetik). */
export async function POST() {
  try {
    if (!isBackupEnabled()) {
      return NextResponse.json({ error: "Yedekleme bu bilgisayarda kapalı." }, { status: 400 });
    }
    const file = await runBackupNow();
    return NextResponse.json({ ok: true, ...file });
  } catch (e) {
    return jsonError(e);
  }
}
