import { z } from "zod";
import {
  FILAMENT_COLORS,
  materialFamily,
  slugifyTr,
  spoolGroupKey,
  titleFromKey,
  nearestColor,
} from "@/core/filament-groups";

/**
 * Makara ekleme girdisi — tekil ve toplu (batch) rotaların ORTAK şeması.
 *
 * Envanter tasarımının iki kuralı burada uygulanır:
 *  1. `name` (ürün adı / seri: "XPLA", "Silk") ARTIK ZORUNLU DEĞİL. Kart başlığı renk+tür olduğu
 *     için ada gerek kalmadı; boş gelirse "{Renk} {Tür}" olarak türetilir. Kolon NOT NULL olduğu
 *     ve telefon/bildirim metinleri bu alanı okuduğu için asla boş dize yazılmaz.
 *  2. `remainingGrams` EKLEMEDE SORULMAZ. Yeni makara kapalıdır → kalan = toplam. (Kullanıcı
 *     "sonra düzenlerim" dedi; gram alanı yalnız düzenleme ekranında.)
 */
export const SpoolInputSchema = z.object({
  name: z.string().optional(),
  material: z.string().default("PLA"),
  colorName: z.string().optional(),
  colorHex: z.string().default("#9ca3af"),
  colorKey: z.string().optional(),
  brand: z.string().optional(),
  totalGrams: z.coerce.number().positive().default(1000),
  remainingGrams: z.coerce.number().min(0).optional(),
  spoolCost: z.coerce.number().min(0).optional(),
  vendorUrl: z.string().optional(),
});

export type SpoolInput = z.infer<typeof SpoolInputSchema>;

export interface BuiltSpoolFields {
  name: string;
  material: string;
  colorName: string | null;
  colorHex: string;
  colorKey: string;
  brand: string | null;
  totalGrams: number;
  remainingGrams: number;
  spoolCost: number | null;
  vendorUrl: string | null;
  /** Yeni makara KAPALI doğar — açıldığında (tüketim/elle) doldurulur. */
  openedAt: null;
}

/** Girdiden DB alanlarını üret: renk anahtarı normalize, ad türetilir, makara kapalı doğar. */
export function buildSpoolFields(input: SpoolInput): { fields: BuiltSpoolFields; groupKey: string; label: string } {
  const material = materialFamily(input.material);

  // Renk anahtarı: açıkça verildiyse o, yoksa renk adından, o da yoksa renk koduna en yakın palet.
  const colorKey =
    slugifyTr(input.colorKey ?? "") ||
    slugifyTr(input.colorName ?? "") ||
    nearestColor(input.colorHex).key;

  const known = FILAMENT_COLORS.find((c) => c.key === colorKey);
  const colorName = (input.colorName ?? "").trim() || known?.name || titleFromKey(colorKey);
  const colorHex = (input.colorHex ?? "").trim() || known?.hex || "#9ca3af";

  const totalGrams = input.totalGrams;
  const fields: BuiltSpoolFields = {
    // Ad boşsa türet — kolon NOT NULL; boş dize telefonda "adsız makara" gösterirdi.
    name: (input.name ?? "").trim() || `${colorName} ${material}`,
    material,
    colorName: colorName || null,
    colorHex,
    colorKey,
    brand: (input.brand ?? "").trim() || null,
    totalGrams,
    // Ekleme formunda gram sorulmuyor → kapalı makara: kalan = toplam.
    remainingGrams: input.remainingGrams ?? totalGrams,
    spoolCost: input.spoolCost ?? null,
    vendorUrl: (input.vendorUrl ?? "").trim() || null,
    openedAt: null,
  };

  const groupKey = spoolGroupKey({
    id: "",
    material: fields.material,
    colorName: fields.colorName,
    colorHex: fields.colorHex,
    colorKey: fields.colorKey,
    totalGrams: fields.totalGrams,
    remainingGrams: fields.remainingGrams,
  });

  return { fields, groupKey, label: `${colorName} ${material}` };
}
