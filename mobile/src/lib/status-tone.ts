import type { StatusTone } from "@/lib/api/orders";
import { color } from "@/theme/tokens";

/**
 * Sipariş durumu tonu → palet rengi (liste, detay ve hazırlık aynı eşlemeyi kullanır).
 * Masaüstü Siparişler'le aynı: bekleyen lavanta, kargoda çivit, teslim zümrüt, iptal gül.
 */
export const STATUS_TONE: Record<StatusTone, string> = {
  green: color.good,
  orange: color.accentBright,
  accent: "#818CF8",
  red: color.bad,
  dim: color.textDim,
};
