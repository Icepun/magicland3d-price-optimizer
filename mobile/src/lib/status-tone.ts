import type { StatusTone } from "@/lib/api/orders";
import { color } from "@/theme/tokens";

/** Sipariş durumu tonu → palet rengi (liste, detay ve hazırlık aynı eşlemeyi kullanır). */
export const STATUS_TONE: Record<StatusTone, string> = {
  green: color.good,
  orange: color.warn,
  accent: color.accentBright,
  red: color.bad,
  dim: color.textDim,
};
