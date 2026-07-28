import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { bambuStreamTimelapse } from "@/core/printers/bambu";

export const dynamic = "force-dynamic";

/**
 * Bambu timelapse videosunu indir (FTPS RETR → tarayıcıya).
 *
 * Yalnız Bambu için gerekli: Moonraker videoları yazıcının kendi HTTP'sinden DOĞRUDAN
 * indirilir (Range destekli), proxy'e gerek yok. Bambu FTPS konuştuğu için tarayıcı
 * doğrudan erişemez → uygulama üzerinden geçer.
 *
 * AKIŞ: yazıcıdan gelen byte'lar tarayıcıya ANINDA aktarılır (belleğe toplanmaz). Bambu'nun
 * FTP'si yavaş olduğu için (ölçüldü: 4.5MB ≈ 34sn) bu şart — aksi halde indirme bitene kadar
 * tarayıcı hiçbir ilerleme görmezdi. Content-Length verildiğinden yüzde GERÇEKTİR.
 * NOT: FTPS'te Range yok → seek/kısmi indirme desteklenmez; .avi zaten tarayıcıda oynamaz.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const name = req.nextUrl.searchParams.get("name") ?? "";
    // Yol kaçışı koruması (core'da da var; burada erken reddet).
    if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
      return NextResponse.json({ error: "Geçersiz dosya adı" }, { status: 400 });
    }

    const cfg = await prisma.printerConfig.findUnique({ where: { id } });
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });
    if (cfg.type !== "bambu" || !cfg.accessCode) {
      return NextResponse.json(
        { error: "Bu yazıcının videoları doğrudan indirilir" },
        { status: 400 }
      );
    }

    const { stream, size } = await bambuStreamTimelapse(cfg.host, cfg.accessCode, name);
    const headers: Record<string, string> = {
      "Content-Type": "video/x-msvideo",
      "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
    };
    // Boyut biliniyorsa ver → tarayıcı/arayüz GERÇEK yüzde gösterir (yoksa belirsiz ilerleme).
    if (size != null) headers["Content-Length"] = String(size);
    return new NextResponse(stream, { headers });
  } catch (error) {
    return jsonError(error);
  }
}
