/**
 * Yazıcıya yazılabilen filament türleri — renk penceresi + yazıcı komutları ORTAK listesi (saf).
 *
 * • U1: ekranın "Generic" markası altındaki türler (gui.log'daki tür listesi); alt tür boş gider.
 * • Bambu: `ams_filament_setting` komutunun istediği genel profil kimliği (`tray_info_idx`) ve
 *   nozul sıcaklık aralığı. Tür DEĞİŞMİYORSA makaranın mevcut profili ve sıcaklıkları korunur —
 *   bu tablo yalnız tür değiştirilince devreye girer.
 */
export const U1_FILAMENT_TIPLERI = ["PLA", "PETG", "ABS", "ASA", "TPU", "PLA-CF", "PETG-CF"] as const;

export const BAMBU_FILAMENT_PROFILI: Record<string, { idx: string; min: number; max: number }> = {
  PLA: { idx: "GFL99", min: 190, max: 230 },
  PETG: { idx: "GFG99", min: 220, max: 260 },
  ABS: { idx: "GFB99", min: 240, max: 270 },
  ASA: { idx: "GFB98", min: 240, max: 270 },
  TPU: { idx: "GFU99", min: 200, max: 240 },
  "PLA-CF": { idx: "GFL98", min: 210, max: 240 },
};
export const BAMBU_FILAMENT_TIPLERI = Object.keys(BAMBU_FILAMENT_PROFILI);

/** "#a1B2c3" / "A1B2C3" → "A1B2C3"; geçersizse null. */
export function renkKodu(renk: string | null | undefined): string | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((renk ?? "").trim());
  return m ? m[1].toUpperCase() : null;
}
