/**
 * YAZICI DOLULUĞU — saf hesap (örnekler `PrinterStatusSample`, 5 dakikalık dilimler).
 *
 * Dilimlerin bir kısmı hiç yazılmamış olabilir (masaüstü kapalı / uykuda): bunlar "bilinmiyor"
 * sayılır, boşta DEĞİL — bilinmeyen ≠ sıfır. Yüzdeler BİLİNEN süreye göre verilir, kapsam ayrıca.
 */
export const DILIM_MS = 5 * 60_000;
export const SAKLAMA_GUN = 30;

export function dilimBasi(ms: number): number {
  return Math.floor(ms / DILIM_MS) * DILIM_MS;
}

export type DolulukSinifi = "basiyor" | "bosta" | "sorun" | "cevrimdisi";

export function durumSinifi(status: string): DolulukSinifi {
  if (status === "printing") return "basiyor";
  if (status === "paused" || status === "error") return "sorun";
  if (status === "offline") return "cevrimdisi";
  return "bosta"; // idle / finished / bilinmeyen-ama-çevrimiçi
}

export interface YaziciDolulugu {
  printerConfigId: string;
  /** Dilim sayıları. */
  basiyor: number;
  bosta: number;
  sorun: number;
  cevrimdisi: number;
  /** Ölçüm penceresinde hiç örnek olmayan dilim (masaüstü kapalıydı). */
  bilinmiyor: number;
  /** Basıyor ÷ bilinen dilimler; hiç bilinen yoksa null. */
  basmaOrani: number | null;
}

export function dolulukOzeti(
  ornekler: readonly { printerConfigId: string; bucketMs: number; status: string }[],
  yaziciIdleri: readonly string[],
  nowMs: number,
  gun: number
): { yazicilar: YaziciDolulugu[]; pencereDilim: number; olcumBaslangici: number | null } {
  const bitis = dilimBasi(nowMs);
  const baslangic = bitis - gun * 86_400_000;
  // Ölçüm henüz pencereden kısaysa pencere, İLK örnekten başlar (sürüm yeni çıktıysa "6 gün
  // bilinmiyor" demek yanıltıcı olurdu).
  const ilk = ornekler.reduce<number | null>((m, o) => (m == null || o.bucketMs < m ? o.bucketMs : m), null);
  const etkinBaslangic = ilk == null ? bitis : Math.max(baslangic, ilk);
  const pencereDilim = Math.max(0, Math.round((bitis - etkinBaslangic) / DILIM_MS) + 1);
  const harita = new Map(
    yaziciIdleri.map((id) => [id, { basiyor: 0, bosta: 0, sorun: 0, cevrimdisi: 0 } as Record<DolulukSinifi, number>])
  );
  for (const o of ornekler) {
    if (o.bucketMs < etkinBaslangic || o.bucketMs > bitis) continue;
    const s = harita.get(o.printerConfigId);
    if (s) s[durumSinifi(o.status)]++;
  }
  const yazicilar = yaziciIdleri.map((id) => {
    const s = harita.get(id)!;
    const bilinen = s.basiyor + s.bosta + s.sorun + s.cevrimdisi;
    return {
      printerConfigId: id,
      ...s,
      bilinmiyor: Math.max(0, pencereDilim - bilinen),
      basmaOrani: bilinen > 0 ? s.basiyor / bilinen : null,
    };
  });
  return { yazicilar, pencereDilim, olcumBaslangici: ilk };
}
