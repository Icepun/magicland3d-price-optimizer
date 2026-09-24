/**
 * YAZICI SLOTLARI → 3B İZLEYİCİNİN TAKIM RENKLERİ.
 *
 * Masaüstü paneli (`app/printers/panel-controls` buradan yeniden dışa aktarır) ve telefona 3B
 * paketi taşıyan aktarıcı AYNI hesabı kullanır — telefondaki model masaüstündekiyle aynı
 * renkte görünsün.
 */

/** Hesaba giren slot alanları (panelin `PanelSlot`u ve aktarıcının slot listesi uyar). */
export interface RenkSlotu {
  slot: number;
  color: string;
  empty: boolean;
  /** Hesaba girmez; panel slotu olduğu gibi verilebilsin diye kabul edilir. */
  type?: string;
}

const HEX6 = /^#?[0-9a-fA-F]{6}$/;

/**
 * Yazıcının GERÇEK makara renklerini, gcode'un kullandığı MANTIKSAL takım indeksine göre dizer.
 *
 * NEDEN EŞLEME GEREKİYOR: gcode `T<n>` mantıksal filament indeksi yazar, yazıcının slot renkleri
 * ise fiziksel kafaya aittir. İkisi aynı olmak zorunda değil. `toolMap` (U1
 * `print_task_config.extruder_map_table`) mantıksal→fiziksel çevirir; verilmezse kimliğe düşülür
 * (tek kafalı yazıcılarda ve eşleme okunamadığında doğru davranış budur).
 * Boş slot ve okunamayan renk `null` kalır → izleyici dosyadaki rengi kullanır.
 */
export function slotToolColors(
  slots: readonly RenkSlotu[] | undefined,
  toolMap?: readonly number[] | null,
): (string | null)[] {
  /** Fiziksel kafa → renk. */
  const fiziksel: (string | null)[] = [];
  for (const s of slots ?? []) {
    const idx = Math.round(s.slot);
    if (!Number.isFinite(idx) || idx < 0 || idx > 63) continue;
    const raw = (s.color || "").trim();
    const color = !s.empty && HEX6.test(raw) ? `#${raw.replace("#", "").toUpperCase()}` : null;
    while (fiziksel.length <= idx) fiziksel.push(null);
    fiziksel[idx] = color;
  }
  if (!toolMap || toolMap.length === 0) return fiziksel;

  // Mantıksal indekse göre yeniden diz. Geçersiz girdi (-1 = firmware dolgusu) kimliğe düşer.
  const out: (string | null)[] = [];
  for (let mantiksal = 0; mantiksal < toolMap.length; mantiksal++) {
    const hedef = toolMap[mantiksal];
    const kafa = Number.isInteger(hedef) && hedef >= 0 ? hedef : mantiksal;
    out.push(fiziksel[kafa] ?? null);
  }
  // Eşlemenin dışında kalan mantıksal indeksler için fiziksel diziyle devam et.
  for (let i = toolMap.length; i < fiziksel.length; i++) out.push(fiziksel[i] ?? null);
  return out;
}
