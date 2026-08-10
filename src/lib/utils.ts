import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Biçimlendirme artık TEK kaynakta: `@/lib/format`.
 * Bu iki dış aktarım geriye dönük uyumluluk için duruyor (yaklaşık 50 içe aktarma yeri var);
 * YENİ kodda doğrudan `@/lib/format` kullan — orada tutar/yüzde/tarih/bağıl zaman hepsi var.
 */
export { formatCurrency, formatPercent } from "./format";
