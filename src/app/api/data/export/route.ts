import { NextResponse } from "next/server";
import { buildBackupPayload } from "@/lib/backup-payload";

/**
 * Yedeği tek bir JSON dosyası olarak indirir.
 * Gövdeyi üreten mantık backup-payload.ts'te; günlük otomatik yedek de aynı gövdeyi
 * kullanıyor ki iki yoldan alınan yedek birbirinden sapmasın.
 */
export async function GET() {
  const dump = await buildBackupPayload();

  return new NextResponse(JSON.stringify(dump, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="magicland-backup-${new Date()
        .toISOString()
        .slice(0, 10)}.json"`,
    },
  });
}
