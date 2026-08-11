"use client";

import { cn } from "@/lib/utils";

/**
 * Filament envanterinin görsel dili — saf CSS (yeni kütüphane YOK).
 *
 * Tasarım kararı: "kaç makaram var" sorusunu METİN değil ŞEKİL cevaplasın. Kartın solundaki
 * makara silüeti rengi taşır, yanındaki noktalar tek tek makaraları gösterir (dolu = kapalı,
 * kesikli = açık, soluk = bitmiş). Böyleceniceliği okumadan görürsün.
 */

/**
 * Renk yuvarlakları HER ZAMAN ince bir çerçeve alır.
 *
 * Neden koşulsuz: yalnız "çok açık renkler" için çerçeve eklemek yetmiyordu — koyu temada SİYAH
 * makara noktaları zeminle aynı tona düşüp görünmez oluyordu (sahada yakalandı: 4 kapalı siyah
 * makara kartında hiç nokta görünmüyordu). Çerçeve iki uçta da (siyah ve beyaz) sınırı korur.
 */
const OUTLINE = "inset 0 0 0 1px var(--border)";

/**
 * Makara silüeti: dış halka filament rengi, ortası kart zemini (gerçek makara gibi delikli).
 * Ortasında kapalı makara sayısı.
 */
export function SpoolDisk({
  colorHex,
  count,
  size = 56,
  className,
}: {
  colorHex: string;
  count: number;
  size?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("relative shrink-0 rounded-full grid place-items-center", className)}
      style={{
        width: size,
        height: size,
        // Halka kalınlığı makaranın "dolu" hissini verir; iç daire kart zeminiyle aynı.
        background: `conic-gradient(${colorHex} 0turn, ${colorHex} 1turn)`,
        boxShadow: OUTLINE,
      }}
      aria-hidden
    >
      <div
        className="rounded-full bg-card grid place-items-center"
        style={{ width: size * 0.56, height: size * 0.56 }}
      >
        <span className="text-sm font-bold tabular-nums text-foreground">{count}</span>
      </div>
    </div>
  );
}

export type PipKind = "sealed" | "open" | "empty";

/**
 * Makara noktaları — her nokta BİR makara.
 *  dolu daire      = kapalı (açılmamış)  → asıl saydığımız şey
 *  kesikli daire   = açık (kullanımda)
 *  soluk daire     = bitmiş
 * 8'den fazlasında "+N" ile kısaltılır (kart yüksekliği sabit kalsın).
 */
export function SpoolPips({
  sealed,
  open,
  empty,
  colorHex,
  max = 8,
}: {
  sealed: number;
  open: number;
  empty: number;
  colorHex: string;
  max?: number;
}) {
  const pips: PipKind[] = [
    ...Array<PipKind>(sealed).fill("sealed"),
    ...Array<PipKind>(open).fill("open"),
    ...Array<PipKind>(empty).fill("empty"),
  ];
  const shown = pips.slice(0, max);
  const rest = pips.length - shown.length;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {shown.map((kind, i) => (
        <span
          key={i}
          // Kademeli giriş: noktalar sırayla belirir (en fazla 8 → gecikme tavanı düşük).
          className="inline-block h-2.5 w-2.5 rounded-full animate-in zoom-in duration-200 fill-mode-both"
          style={{
            animationDelay: `${i * 40}ms`,
            background: kind === "sealed" ? colorHex : "transparent",
            // Kapalı noktada çerçeve HER ZAMAN var: siyah koyu temada, beyaz açık temada kaybolmasın.
            border:
              kind === "sealed"
                ? "1px solid var(--border)"
                : kind === "open"
                  ? `1.5px dashed ${colorHex}`
                  : "1.5px solid var(--border)",
            boxShadow: kind === "open" ? OUTLINE : undefined,
            opacity: kind === "empty" ? 0.4 : 1,
          }}
          title={kind === "sealed" ? "Kapalı makara" : kind === "open" ? "Açık makara" : "Bitmiş makara"}
        />
      ))}
      {rest > 0 && <span className="text-[11px] text-muted-foreground ml-0.5">+{rest}</span>}
    </div>
  );
}

/** Renk yuvarlağı — palet ve listelerde. */
export function ColorDot({ hex, size = 16, className }: { hex: string; size?: number; className?: string }) {
  return (
    <span
      className={cn("inline-block rounded-full shrink-0", className)}
      style={{
        width: size,
        height: size,
        background: hex,
        boxShadow: OUTLINE,
      }}
      aria-hidden
    />
  );
}
