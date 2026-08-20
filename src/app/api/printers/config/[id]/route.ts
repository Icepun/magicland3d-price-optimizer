import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { dropBambuConns } from "@/core/printers/bambu";
import { invalidatePrinterConfigs } from "@/core/printers/status-cache";
import { clearMoonrakerCaps, clearMoonrakerPort } from "@/core/printers/moonraker";
import { wsHostKapat } from "@/core/printers/moonraker-ws";

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  brand: z.enum(["elegoo", "snapmaker", "bambu"]).optional(),
  model: z.string().nullable().optional(),
  type: z.enum(["moonraker", "bambu"]).optional(),
  host: z.string().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  accent: z.string().nullable().optional(),
  accessCode: z.string().nullable().optional(),
  serial: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const data = UpdateSchema.parse(await req.json());
    const before = await prisma.printerConfig.findUnique({ where: { id } });
    const updated = await prisma.printerConfig.update({ where: { id }, data });
    // Bambu MQTT bağlantısını tazele: access code/host/serial değişikliği eski bağlantıda
    // GEÇERSİZDİ (uygulama yeniden başlatılana dek bayat şifreyle reconnect); disable'da da
    // zombie reconnect kalmasın. Eski VE yeni kimlikler düşürülür; sonraki sorgu taze kurar.
    // Panel 15sn'lik yapılandırma önbelleğinden okuyor: geçersiz kılmazsak IP/port değişikliği
    // 15 saniye boyunca ESKİ adrese sorulur ve kullanıcı "ulaşılamadı" görüp ayarı yanlış
    // yaptığını sanar. Yetenek tablosu da adrese bağlı → o da unutulur.
    invalidatePrinterConfigs();
    // Keşfedilen bağlantı portu da adrese bağlı: eski adresten kalan port yeni adrese
    // uygulanırsa yazıcı "ulaşılamıyor" görünür.
    if (before && (before.host !== updated.host || before.port !== updated.port)) {
      clearMoonrakerCaps(before.host);
      clearMoonrakerCaps(updated.host);
      clearMoonrakerPort(before.host);
      clearMoonrakerPort(updated.host);
      // Kalıcı WebSocket de adrese bağlı: kapatılmazsa eski adrese sonsuza dek yeniden
      // bağlanmaya çalışır ve yeni adres için ikinci bir bağlantı açılır.
      wsHostKapat(before.host);
      wsHostKapat(updated.host);
    }
    // Yazıcı devre dışı bırakıldıysa da bağlantıyı bırak.
    if (data.enabled === false && updated.type !== "bambu") wsHostKapat(updated.host);
    if (before?.serial) dropBambuConns(before.host, before.serial);
    if (updated.type === "bambu" && updated.serial && (data.enabled === false || before?.host !== updated.host || before?.serial !== updated.serial || before?.accessCode !== updated.accessCode)) {
      dropBambuConns(updated.host, updated.serial);
    }
    return NextResponse.json(updated);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const cfg = await prisma.printerConfig.findUnique({ where: { id } });
    // İlişkili ürün eşleştirmelerini + son-bilinen slot snapshot'ını da temizle (yetim satır kalmasın)
    await prisma.printFileProduct.deleteMany({ where: { printerConfigId: id } });
    await prisma.appSetting.deleteMany({ where: { key: `slotSnapshot:${id}` } });
    await prisma.printerConfig.delete({ where: { id } });
    // Panel silinen yazıcıyı 15 saniye daha çizip LAN'da yoklamasın.
    invalidatePrinterConfigs();
    if (cfg?.host) {
      clearMoonrakerCaps(cfg.host);
      clearMoonrakerPort(cfg.host);
      wsHostKapat(cfg.host); // silinen yazıcıya yeniden bağlanma denemesi kalmasın
    }
    // Silinen Bambu'nun MQTT bağlantısı zombie reconnect yapmasın.
    if (cfg?.type === "bambu" && cfg.serial) dropBambuConns(cfg.host, cfg.serial);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
