import { prisma } from "@/lib/prisma";
import {
  filamentAyarlariniCoz,
  type FilamentAlertOptions,
  type WatchedGroup,
} from "@/core/filament-groups";

/**
 * Filament envanteri ayarları (AppSetting anahtar/değer tablosunda; YENİ TABLO YOK).
 *
 * Anahtar düzeni bilinçli olarak GRUP BAŞINA AYRI SATIR:
 *   filamentLowSpoolCount        → "2"           genel eşik
 *   filamentThreshold:<grup>     → "3"           o gruba özel eşik (kullanıcı isteği)
 *   filamentWatch:<grup>         → "Siyah PLA"   izlenen grup (etiket değer olarak saklanır)
 *   filamentMute:<grup>          → "1"           susturulmuş grup
 *
 * NEDEN tek bir JSON dizisi değil: JSON'da liste oku-değiştir-yaz gerekir; iki makara aynı anda
 * eklenince biri diğerinin yazdığını EZER ve o grup sessizce izlenmemiş kalır (uyarı hiç çıkmaz).
 * Grup başına upsert ATOMİKTİR → yarış yok.
 *
 * ⚠️ Bu anahtarlar `FINANCIAL_SETTING_KEYS` (pricing-inputs.ts) listesinde YOKTUR ve olmamalıdır —
 * aksi halde eşik her değiştiğinde sipariş kârı önbelleği boşuna düşer.
 */

export const FILAMENT_SETTING_PREFIX = "filament";
export const KEY_LOW_SPOOL_COUNT = "filamentLowSpoolCount";
const PREFIX_THRESHOLD = "filamentThreshold:";
const PREFIX_WATCH = "filamentWatch:";
const PREFIX_MUTE = "filamentMute:";

export interface FilamentSettings extends FilamentAlertOptions {
  threshold: number;
  groupThresholds: Record<string, number>;
  watchedGroups: WatchedGroup[];
  mutedGroups: string[];
}

/** Tek sorguda tüm filament ayarlarını oku (tablo küçük; yalnız "filament" ile başlayanlar). */
export async function loadFilamentSettings(): Promise<FilamentSettings> {
  const rows = await prisma.appSetting
    .findMany({ where: { key: { startsWith: FILAMENT_SETTING_PREFIX } } })
    .catch(() => [] as Array<{ key: string; value: string }>);

  // Okuma kuralı çekirdekte TEK yerde (telefon zili ve Atölye de aynısını kullanır).
  return filamentAyarlariniCoz(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

/**
 * Grubu izlemeye al (makara eklenirken çağrılır).
 *
 * Bu olmadan istenen davranış ÇALIŞMAZ: uyarılar canlı makara satırlarından türetildiği için
 * bir grubun SON makarası silinince grup ortadan kalkar ve "siyah bitti" uyarısı hiç çıkmaz.
 * Kayıt kalıcı olduğu için satır kalmasa da uyarı üretilebilir.
 */
export async function watchFilamentGroup(groupKey: string, label: string): Promise<void> {
  if (!groupKey) return;
  const key = `${PREFIX_WATCH}${groupKey}`;
  const value = (label ?? "").trim() || groupKey;
  await prisma.appSetting
    .upsert({ where: { key }, create: { key, value }, update: { value } })
    .catch(() => {
      /* izleme kaydı yazılamazsa makara ekleme AKIŞI BOZULMASIN — uyarı bir sonraki eklemede kaydolur */
    });
}

/** Grubu izlemeden çıkar ("…" menüsü → artık bu rengi almıyorum). */
export async function unwatchFilamentGroup(groupKey: string): Promise<void> {
  if (!groupKey) return;
  await prisma.appSetting
    .delete({ where: { key: `${PREFIX_WATCH}${groupKey}` } })
    .catch(() => { /* zaten yok */ });
}

/** Grubu sustur / susturmayı kaldır (VERİ SİLMEDEN uyarıyı kapatma). */
export async function setFilamentGroupMuted(groupKey: string, muted: boolean): Promise<void> {
  if (!groupKey) return;
  const key = `${PREFIX_MUTE}${groupKey}`;
  if (muted) {
    await prisma.appSetting
      .upsert({ where: { key }, create: { key, value: "1" }, update: { value: "1" } })
      .catch(() => {});
  } else {
    await prisma.appSetting.delete({ where: { key } }).catch(() => {});
  }
}

/** Gruba özel eşik yaz (null → genel eşiğe dön). */
export async function setFilamentGroupThreshold(
  groupKey: string,
  value: number | null
): Promise<void> {
  if (!groupKey) return;
  const key = `${PREFIX_THRESHOLD}${groupKey}`;
  if (value === null) {
    await prisma.appSetting.delete({ where: { key } }).catch(() => {});
    return;
  }
  const v = String(Math.max(0, Math.floor(value)));
  await prisma.appSetting
    .upsert({ where: { key }, create: { key, value: v }, update: { value: v } })
    .catch(() => {});
}

/** Genel eşiği yaz. */
export async function setFilamentThreshold(value: number): Promise<void> {
  const v = String(Math.max(0, Math.floor(value)));
  await prisma.appSetting.upsert({
    where: { key: KEY_LOW_SPOOL_COUNT },
    create: { key: KEY_LOW_SPOOL_COUNT, value: v },
    update: { value: v },
  });
}
