import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { kargoDesisiSonrasiTazele } from "@/lib/kargo-desileri";
import { siparisKimligi } from "@/core/order-line-cost";
import { kargoDesiOku } from "@/core/kargo-desi";

/**
 * SİPARİŞİN GERÇEKTE ÇIKTIĞI KARGO DESİSİ — Siparişler → kargo satırındaki "Desi" (Shopify).
 *   PUT    { siparisId, desi } → kaydet (kargo bu desiyle yeniden hesaplanır)
 *   DELETE { siparisId }       → kaldır (kargo yine ürün desilerinin toplamından)
 * Telefon aynı tabloya doğrudan yazar (`mobile/src/lib/db/kargo-desi.ts`).
 */

const Anahtar = z.object({
  platform: z.literal("shopify", { message: "Kargo desisi yalnız Shopify siparişinde girilir" }).default("shopify"),
  siparisId: z.string().trim().min(1).max(200),
});

const Kaydet = Anahtar.extend({
  desi: z.union([z.number(), z.string()]),
});

export async function PUT(req: Request) {
  try {
    await ensureRuntimeSchema();
    const govde = Kaydet.parse(await req.json());
    const desi = kargoDesiOku(govde.desi);
    if (desi == null) return NextResponse.json({ error: "0'dan büyük bir desi gir" }, { status: 400 });
    const externalOrderId = siparisKimligi(govde.platform, govde.siparisId);
    await prisma.orderCargoDesi.upsert({
      where: { platform_externalOrderId: { platform: govde.platform, externalOrderId } },
      create: { id: `ocd_${randomUUID().replace(/-/g, "")}`, platform: govde.platform, externalOrderId, desi },
      update: { desi },
    });
    await kargoDesisiSonrasiTazele(govde.platform, govde.siparisId);
    return NextResponse.json({ ok: true, desi });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(req: Request) {
  try {
    await ensureRuntimeSchema();
    const govde = Anahtar.parse(await req.json());
    await prisma.orderCargoDesi.deleteMany({
      where: { platform: govde.platform, externalOrderId: siparisKimligi(govde.platform, govde.siparisId) },
    });
    await kargoDesisiSonrasiTazele(govde.platform, govde.siparisId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
