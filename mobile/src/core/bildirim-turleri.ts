/**
 * BİLDİRİM TÜRLERİ — cihaz başına açılıp kapatılabilen bildirim grupları.
 *
 * Telefon (push) ve masaüstü (işletim sistemi bildirimi) AYNI anahtarları kullanır. Tercih
 * KAPATILAN türlerin listesi olarak saklanır: ileride yeni bir tür eklenirse her cihazda
 * varsayılanı AÇIK olur, kimse haberi olmadan bir bildirimi kaçırmaz.
 *
 * Bu dosya telefona da kopyalanır (`mobile` → `npm run sync-core`): telefonun kendi ayar ekranı
 * ve bildirim listesi aynı eşlemeyi kullanır.
 */

export type BildirimTuru = "siparis" | "baski-bitti" | "baski-sorun" | "stok" | "filament";

export interface BildirimTuruBilgisi {
  anahtar: BildirimTuru;
  ad: string;
  aciklama: string;
}

/** Telefona push olarak giden türler (stok/filament telefona hiç gitmiyor — ürün kararı). */
export const TELEFON_BILDIRIM_TURLERI: readonly BildirimTuruBilgisi[] = [
  { anahtar: "siparis", ad: "Siparişler", aciklama: "Yeni sipariş gelince" },
  { anahtar: "baski-bitti", ad: "Baskı bitti", aciklama: "Yazıcı bir baskıyı bitirince" },
  { anahtar: "baski-sorun", ad: "Baskı durdu", aciklama: "Baskı hatayla durunca ya da duraklatılınca" },
];

/** Masaüstünde işletim sistemi bildirimi olarak çıkan türler. */
export const MASAUSTU_BILDIRIM_TURLERI: readonly BildirimTuruBilgisi[] = [
  ...TELEFON_BILDIRIM_TURLERI,
  { anahtar: "stok", ad: "Stok", aciklama: "Bir ürünün stoğu bitince" },
  { anahtar: "filament", ad: "Filament", aciklama: "Bir filament bitince" },
];

const GECERLI = new Set<string>(MASAUSTU_BILDIRIM_TURLERI.map((t) => t.anahtar));

/** Saklanan metin ("baski-bitti,stok") → geçerli türler. Bozuk/bilinmeyen parçalar atlanır. */
export function kapaliListesi(metin: string | null | undefined): BildirimTuru[] {
  if (!metin) return [];
  const out: BildirimTuru[] = [];
  for (const p of metin.split(",")) {
    const t = p.trim();
    if (GECERLI.has(t) && !out.includes(t as BildirimTuru)) out.push(t as BildirimTuru);
  }
  return out;
}

/** Türler → saklanacak metin (sıralı, tekrarsız). */
export function kapaliMetni(liste: readonly string[]): string {
  return [...new Set(liste.filter((t) => GECERLI.has(t)))].sort().join(",");
}

/** Bu tür bu cihazda açık mı? Türü bilinmeyen bildirim her zaman açıktır. */
export function bildirimAcik(kapali: string | null | undefined, tur: BildirimTuru | null): boolean {
  if (!tur) return true;
  return !kapaliListesi(kapali).includes(tur);
}

/**
 * Bildirim kaydının türü — kimliğinden ve tipinden. Kalıcı satırlar (`order-new:…`,
 * `printer-done:…`, `printer-fault:…`, `stock-…`) ve anlık uyarılar (`printer-<id>-error`,
 * telefonda `print-<id>`) aynı eşlemeden geçer. Bilinmeyen → null (her zaman gösterilir).
 */
export function bildirimTuruBul(b: { id: string; type?: string | null }): BildirimTuru | null {
  const id = b.id ?? "";
  const tip = b.type ?? "";
  if (id.startsWith("order-new:") || tip === "order-new") return "siparis";
  if (id.startsWith("printer-done:") || tip === "printer-done") return "baski-bitti";
  if (
    id.startsWith("printer-fault:") ||
    tip === "printer-error" ||
    tip === "printer-paused" ||
    /^printer-.+-(error|paused)$/.test(id) ||
    id.startsWith("print-") ||
    tip === "printer" ||
    tip === "print"
  ) {
    return "baski-sorun";
  }
  if (tip === "stock" || tip === "site-stock" || id.startsWith("stock-") || id.startsWith("site-stock-")) return "stok";
  if (tip === "filament" || tip === "spool" || id.startsWith("filament-") || id.startsWith("spool-")) {
    return "filament";
  }
  if (tip === "order") return "siparis";
  return null;
}
