import { NextResponse } from "next/server";
import { remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { kapaliListesi, kapaliMetni, TELEFON_BILDIRIM_TURLERI } from "@/core/bildirim-turleri";

/**
 * Kayıtlı telefonlar ve her birinin bildirim tercihi (PushToken satırları).
 *   GET                              → telefon listesi (en son açılan önce)
 *   PATCH { id, cihazAdi?, kapali? } → ad / kapalı türler
 *   DELETE { id }                    → kaydı sil (telefon uygulamayı açınca yeniden kaydolur)
 *
 * `id` telefonun push kimliğidir. Güncellemeler ham SQL: Prisma `@updatedAt` damgasını
 * yenilerdi, oysa o kolon "telefon en son ne zaman açıldı" bilgisini taşıyor.
 */

const TELEFON_TURLERI = new Set<string>(TELEFON_BILDIRIM_TURLERI.map((t) => t.anahtar));
const AD_AZAMI = 40;

interface KayitliTelefon {
  id: string;
  platform: string;
  cihazAdi: string | null;
  kapali: string[];
  sonAcilis: string | null;
  ilkKayit: string | null;
}

function isoVeyaNull(d: unknown): string | null {
  if (d instanceof Date && Number.isFinite(d.getTime())) return d.toISOString();
  return null;
}

export async function GET() {
  try {
    await ensureRuntimeSchema();
    const satirlar = await remotePrisma.pushToken.findMany({
      select: { token: true, platform: true, cihazAdi: true, kapali: true, createdAt: true, updatedAt: true },
    });
    const telefonlar: KayitliTelefon[] = satirlar
      .filter((s) => typeof s.token === "string" && s.token.startsWith("ExponentPushToken"))
      .map((s) => ({
        id: s.token,
        platform: s.platform || "",
        cihazAdi: s.cihazAdi?.trim() || null,
        kapali: kapaliListesi(s.kapali).filter((t) => TELEFON_TURLERI.has(t)),
        sonAcilis: isoVeyaNull(s.updatedAt),
        ilkKayit: isoVeyaNull(s.createdAt),
      }))
      .sort((a, b) => (b.sonAcilis ?? "").localeCompare(a.sonAcilis ?? ""));
    return NextResponse.json({ telefonlar }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(req: Request) {
  try {
    await ensureRuntimeSchema();
    const govde = (await req.json().catch(() => null)) as
      | { id?: unknown; cihazAdi?: unknown; kapali?: unknown }
      | null;
    const id = typeof govde?.id === "string" ? govde.id : "";
    if (!id) return NextResponse.json({ error: "Telefon bulunamadı" }, { status: 400 });

    const atamalar: string[] = [];
    const degerler: (string | null)[] = [];
    if (govde && "cihazAdi" in govde) {
      const ad = typeof govde.cihazAdi === "string" ? govde.cihazAdi.trim().slice(0, AD_AZAMI) : "";
      atamalar.push(`"cihazAdi" = ?`);
      degerler.push(ad || null);
    }
    if (govde && Array.isArray(govde.kapali)) {
      const liste = govde.kapali.filter((x): x is string => typeof x === "string" && TELEFON_TURLERI.has(x));
      atamalar.push(`"kapali" = ?`);
      degerler.push(kapaliMetni(liste));
    }
    if (atamalar.length === 0) return NextResponse.json({ error: "Değişiklik yok" }, { status: 400 });

    const etkilenen = await remotePrisma.$executeRawUnsafe(
      `UPDATE "PushToken" SET ${atamalar.join(", ")} WHERE "token" = ?`,
      ...degerler,
      id
    );
    if (!etkilenen) return NextResponse.json({ error: "Telefon bulunamadı" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(req: Request) {
  try {
    await ensureRuntimeSchema();
    const govde = (await req.json().catch(() => null)) as { id?: unknown } | null;
    const id = typeof govde?.id === "string" ? govde.id : "";
    if (!id) return NextResponse.json({ error: "Telefon bulunamadı" }, { status: 400 });
    await remotePrisma.pushToken.deleteMany({ where: { token: id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
