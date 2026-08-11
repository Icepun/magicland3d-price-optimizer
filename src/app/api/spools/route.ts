import { NextRequest, NextResponse } from "next/server";
import { bustInventoryAlertCaches } from "@/lib/cache-busting";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

/**
 * Gram maliyeti karşılaştırma eşikleri. Kur/kargo kaynaklı küçük sapmalar için uyarı
 * çıkmasın diye hem oransal hem mutlak fark aranır.
 */
const MIN_GAP_TL = 0.05;
const MIN_GAP_RATIO = 0.1;

interface FilamentTypeRow {
  name: string;
  costPerGram: number;
}

/** Eşleştirme için malzeme adını sadeleştir: "PLA+ " ile "pla+" aynı şeydir. */
function normalizeMaterial(value: string): string {
  return value.toLocaleLowerCase("tr-TR").replace(/[\s._-]+/g, "");
}

/**
 * Makaranın malzemesini maliyet ayarlarındaki filament satırıyla eşler.
 * NEDEN katı: yanlış satırla eşleşmek "fiyatın yanlış" diye HATALI uyarı doğurur. Önce birebir
 * ad eşleşmesi aranır; olmazsa yalnız TEK bir satır malzeme adıyla başlıyorsa kabul edilir.
 * Birden fazla aday varsa hiçbiri seçilmez → uyarı da çıkmaz.
 */
function matchFilamentType(material: string, types: FilamentTypeRow[]): FilamentTypeRow | null {
  const target = normalizeMaterial(material ?? "");
  if (!target) return null;

  const exact = types.filter((t) => normalizeMaterial(t.name) === target);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const prefixed = types.filter((t) => normalizeMaterial(t.name).startsWith(target));
  return prefixed.length === 1 ? prefixed[0] : null;
}

/**
 * Makaranın alış bedelinden çıkan GERÇEK gram maliyeti ile tablodaki değerin farkı.
 * YALNIZCA GÖSTERİM İÇİN: hiçbir maliyet/kâr hesabı bu alandan beslenmez, hiçbir fiyat
 * otomatik güncellenmez. Belirgin fark yoksa null → arayüzde hiçbir şey görünmez.
 */
function costGapOf(
  spool: { material: string; spoolCost: number | null; totalGrams: number },
  types: FilamentTypeRow[]
): { actualPerGram: number; tablePerGram: number } | null {
  if (spool.spoolCost == null || !(spool.spoolCost > 0) || !(spool.totalGrams > 0)) return null;

  const match = matchFilamentType(spool.material, types);
  if (!match) return null;

  const actualPerGram = spool.spoolCost / spool.totalGrams;
  const tablePerGram = match.costPerGram;
  const diff = Math.abs(actualPerGram - tablePerGram);
  if (diff < MIN_GAP_TL) return null;
  if (diff / tablePerGram < MIN_GAP_RATIO) return null;

  return { actualPerGram, tablePerGram };
}

export async function GET() {
  try {
    await ensureRuntimeSchema();
    const spools = await prisma.filamentSpool.findMany({
      where: { isActive: true },
      orderBy: [{ remainingGrams: "asc" }, { name: "asc" }],
    });

    // Karşılaştırma listesi burada okunuyor (ayrı bir istek yerine): uzak-HTTP modunda
    // maliyet ekranı sorguları da bu süreçte sıraya girdiği için ikinci bir HTTP turu
    // tek bir ek sorgudan daha pahalıya gelirdi.
    const filamentTypes = await prisma.filamentType.findMany({
      where: { isActive: true, costPerGram: { gt: 0 } },
      select: { name: true, costPerGram: true },
    });

    return NextResponse.json(
      spools.map((spool) => ({ ...spool, costGap: costGapOf(spool, filamentTypes) }))
    );
  } catch (error) {
    return jsonError(error);
  }
}

const CreateSchema = z.object({
  name: z.string().min(1),
  material: z.string().default("PLA"),
  colorName: z.string().optional(),
  colorHex: z.string().default("#9ca3af"),
  brand: z.string().optional(),
  totalGrams: z.coerce.number().positive().default(1000),
  remainingGrams: z.coerce.number().min(0).optional(),
  spoolCost: z.coerce.number().min(0).optional(),
  reorderGrams: z.coerce.number().min(0).default(200),
  vendorUrl: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = CreateSchema.parse(await req.json());
    const spool = await prisma.filamentSpool.create({
      data: {
        name: input.name.trim(),
        material: input.material,
        colorName: input.colorName?.trim() || null,
        colorHex: input.colorHex,
        brand: input.brand?.trim() || null,
        totalGrams: input.totalGrams,
        remainingGrams: input.remainingGrams ?? input.totalGrams,
        spoolCost: input.spoolCost ?? null,
        reorderGrams: input.reorderGrams,
        vendorUrl: input.vendorUrl?.trim() || null,
      },
    });
    bustInventoryAlertCaches(); // yeni makara → "filament azaldı" taraması tazelensin
    return NextResponse.json(spool, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
