import { NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { getPublicTursoSettings } from "@/services/turso-settings";
import { jsonError } from "@/lib/api-error";
import fs from "node:fs/promises";
import path from "node:path";

function settingsPath() {
  return (
    process.env.TURSO_SETTINGS_FILE ||
    path.join(process.cwd(), "data", "turso-settings.json")
  );
}

/**
 * Kaydedilmiş Turso bilgileriyle gerçek bir bağlantı testi yapar (SELECT 1).
 * Restart gerektirmeden "doğru mu" görmek için. Mevcut prisma bağlantısını
 * kullanmaz — kaydedilen url/token ile taze bir libSQL client açar.
 */
export async function POST() {
  try {
    let url = "";
    let authToken = "";
    try {
      const raw = await fs.readFile(settingsPath(), "utf8");
      const parsed = JSON.parse(raw);
      url = parsed.url ?? "";
      authToken = parsed.authToken ?? "";
    } catch {
      /* dosya yok */
    }

    if (!url) {
      return NextResponse.json(
        { ok: false, error: "Turso URL kaydedilmemiş. Önce URL + token girip kaydet." },
        { status: 400 }
      );
    }

    const client = createClient({ url, authToken: authToken || undefined });
    const result = await client.execute("SELECT 1 AS ok");
    client.close();

    const ok = result.rows?.[0]?.ok === 1 || result.rows?.length > 0;
    const pub = await getPublicTursoSettings();
    return NextResponse.json({
      ok,
      message: ok
        ? "Turso bağlantısı başarılı. Uygulamayı yeniden başlatınca bulut DB aktif olur."
        : "Bağlantı kuruldu ama beklenmedik cevap.",
      activeMode: pub.activeMode,
    });
  } catch (error) {
    return jsonError(error);
  }
}
