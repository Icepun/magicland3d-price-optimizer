/**
 * Yazıcı kartının KONTROL kararları — React yok, ağ yok, yan etki yok.
 *
 * Kontroller (duraklat/devam/iptal, hız, ışık, katmanda duraklat, filament) sunucuda ön koşula
 * bağlı. Arayüz aynı kararı burada verir ki kullanıcı REDDEDİLECEK bir düğmeye basmasın:
 * uygun olmayan düğme ETKİSİZ çizilir, hiç desteklenmeyen düğme çizilmez.
 *
 * ⚠️ Buradaki hiçbir şey maliyet/kâr hesabına dokunmaz — yalnız gösterim ve düğme durumu.
 * `filamentGrams` sadece "ne kadar filament harcandı" bilgisidir; hesaba girmez.
 */

import {
  SPEED_MAX_STEP_PCT,
  nearestSpeedStepLabel,
  speedStepLabel,
} from "@/core/printers/controls";
import type { PanelPrinter, PanelSlot, PrinterJob } from "./panel-view";
import { clamp01, formatRemaining } from "./panel-view";

// ── MADDE 6: taşıma düğmeleri (duraklat / devam / iptal / başlat) ──────────
//
// Sunucu `moonrakerControl` içinde ön koşul zorluyor: duraklatılmış yazıcıya "duraklat"
// gönderilirse istek reddediliyor. Arayüz aynı kuralı uygular; ayrıca duraklamışken düğme
// "Devam et" der (eskiden ikisi de "Duraklat" yazıyordu).

export interface TransportControls {
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  canStart: boolean;
}

export function transportControls(p: {
  status: PanelPrinter["status"];
  online: boolean;
  connection?: PanelPrinter["connection"];
  type: PanelPrinter["type"];
  caps?: PanelPrinter["caps"];
}): TransportControls {
  const none: TransportControls = { canPause: false, canResume: false, canCancel: false, canStart: false };
  if (p.type === "sim") return none;
  const connection = p.connection ?? (p.online ? "ok" : "offline");
  if (!p.online || connection !== "ok") return none;
  // caps hiç okunamadıysa (yazıcı o an yanıt vermedi) son bilinen davranışa güven: düğmeyi
  // GİZLEME. Sunucu yine de reddederse kullanıcı sade Türkçe hatayı görür.
  const pauseResume = p.caps?.pauseResume !== false;
  return {
    canPause: pauseResume && p.status === "printing",
    canResume: pauseResume && p.status === "paused",
    canCancel: pauseResume && (p.status === "printing" || p.status === "paused"),
    canStart: p.status === "idle" || p.status === "finished" || p.status === "error",
  };
}

/** Basılan düğmenin ara durum metni — "sadece soluklaşma" yerine ne olduğunu söyler. */
export const PENDING_LABEL: Record<"pause" | "resume" | "cancel" | "start" | "speed" | "light" | "pauseAtLayer" | "changeFilament", string> = {
  pause: "Duraklatılıyor…",
  resume: "Devam ediliyor…",
  cancel: "İptal ediliyor…",
  start: "Başlatılıyor…",
  speed: "Ayarlanıyor…",
  light: "Değiştiriliyor…",
  pauseAtLayer: "Kuruluyor…",
  changeFilament: "Duraklatılıyor…",
};

/** Komut gönderilirken rozet ARA durumda kalsın — kullanıcı "oldu mu?" diye bakmasın. */
export function pendingBadgeLabel(action: "pause" | "resume" | "cancel" | null): string | null {
  if (action === "pause") return "Duraklatılıyor…";
  if (action === "resume") return "Devam ediliyor…";
  if (action === "cancel") return "İptal ediliyor…";
  return null;
}

// ── MADDE 10: hız ──────────────────────────────────────────────────────────
//
// SERBEST SAYI GİRİŞİ YOK. Sunucu tek adımda en fazla ±%25 kabul ediyor; kademeler zaten
// 25'er arayla olduğu için "bir aşağı / bir yukarı" kuralı sınırı doğal olarak sağlar.
// Bambu'da yüzde yok, dört hazır profil var.

export interface SpeedView {
  kind: "percent" | "level";
  /** Kartta görünen rozet ("%150" / "Hızlı"). */
  label: string;
  /** Rozetin altındaki kısa açıklama (Bambu profilinin yüzdesi gibi) — yoksa null. */
  hint: string | null;
  /** Bir aşağı kademe — null ise düğme ETKİSİZ. */
  down: number | null;
  /** Bir yukarı kademe — null ise düğme ETKİSİZ. */
  up: number | null;
  /**
   * Yazıcı fabrika ayarında mı. Moonraker hızı boştayken de bildirdiği için rozet aksi hâlde
   * DÖRT kartta da hiç değişmeden duruyor ve gerçekten anlamlı rozetleri bastırıyordu.
   */
  atDefault: boolean;
}

/** Bambu'nun standart profili. */
const DEFAULT_SPEED_LEVEL = 2;
const DEFAULT_SPEED_PCT = 100;

export function resolveSpeedView(p: {
  caps?: PanelPrinter["caps"];
  speed?: PanelPrinter["speed"];
}): SpeedView | null {
  if (!p.caps?.speed || !p.speed) return null;
  const { levels, level, percent, presets } = p.speed;

  // Bambu: profil (1 Sessiz … 4 Çok hızlı)
  if (levels && levels.length > 0) {
    if (level == null) return null;
    const sorted = levels.slice().sort((a, b) => a.level - b.level);
    const cur = sorted.find((l) => l.level === level);
    const idx = sorted.findIndex((l) => l.level === level);
    return {
      kind: "level",
      // Ortak dil: Bambu profilinin yüzdesi en yakın kademe adına eşlenir ("Standart" → "Normal").
      label: cur ? nearestSpeedStepLabel(cur.pct) : `Profil ${level}`,
      hint: cur ? `%${cur.pct}` : null,
      down: idx > 0 ? sorted[idx - 1].level : null,
      up: idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1].level : null,
      atDefault: level === DEFAULT_SPEED_LEVEL,
    };
  }

  // Moonraker: yüzde kademeleri
  if (percent == null || !Number.isFinite(percent)) return null;
  const cur = Math.round(percent);
  const list = (presets ?? []).slice().sort((a, b) => a - b);
  // Yazıcı kademe DIŞI bir değerde olabilir (dilimleyici %137 yazmış): tek adım sınırına uyan
  // en yakın kademeleri sun, kullanıcı yine de kademeye oturur.
  const reachable = list.filter((v) => v !== cur && Math.abs(v - cur) <= SPEED_MAX_STEP_PCT);
  const below = reachable.filter((v) => v < cur);
  const above = reachable.filter((v) => v > cur);
  return {
    kind: "percent",
    // Kademeye oturuyorsa ORTAK ad; yazıcı dışarıdan başka bir hıza çekilmişse ham yüzde.
    label: speedStepLabel(cur) ?? `%${cur}`,
    hint: null,
    down: below.length ? below[below.length - 1] : null,
    up: above.length ? above[0] : null,
    atDefault: cur === DEFAULT_SPEED_PCT,
  };
}

// ── MADDE 17: katmanda duraklat ────────────────────────────────────────────

export interface LayerRange {
  min: number;
  max: number;
  /** Seçicinin açılış değeri — geçilmiş katman ASLA önerilmez. */
  suggested: number;
}

/** Seçilebilir aralık: `layerCurrent + 1 … layerTotal`. Aralık yoksa null (düğme etkisiz). */
export function pauseLayerRange(job: PrinterJob | null | undefined): LayerRange | null {
  if (!job) return null;
  const total = Math.round(job.layerTotal ?? 0);
  if (!(total > 0)) return null;
  const cur = job.layerCurrent != null && job.layerCurrent > 0 ? Math.round(job.layerCurrent) : 0;
  const min = cur + 1;
  if (min > total) return null;
  // Basmakta olan katmanın hemen üstü çoğu zaman "şimdi dur" demek; birkaç katman ileriyi öner.
  const suggested = Math.min(total, min + 4);
  return { min, max: total, suggested };
}

/**
 * Seçili katmanı canlı aralığa oturt. Seçici açıkken baskı ilerlediği için `range.min` her
 * yoklamada büyüyor; kırpılmazsa kullanıcıya sunucunun REDDEDECEĞİ bir değerle etkin "Kur"
 * düğmesi gösteriliyordu ("Bu katman geçildi…").
 */
export function clampLayerValue(value: number, range: LayerRange): number {
  if (!Number.isFinite(value)) return range.suggested;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/**
 * "+5 / +25 / +100" GERÇEKTEN ekler. Eskiden aralığın başından sabit bir hedefe atıyordu:
 * kaydırıcı 1200'deyken "+100" değeri 382'ye DÜŞÜRÜYOR, baskı 900 katman erken duruyordu.
 */
export function layerStepTarget(value: number, step: number, range: LayerRange): number {
  return clampLayerValue(clampLayerValue(value, range) + Math.round(step), range);
}

// ── MADDE 15: iptal onayı — ne kaybedileceğini SÖYLE ───────────────────────

export interface CancelSummary {
  /** Tamamlanan yüzde — bilinmiyorsa null ("BİLİNMEYEN ≠ SIFIR"). */
  pct: number | null;
  /** "3sa 12dk" — geçen süre bilinmiyorsa null. */
  elapsedText: string | null;
  /** "18dk 20sn kaldı" değeri; kalan süre bilinmiyorsa null. */
  remainingText: string | null;
  /**
   * "~38 g harcandı" — iptalde GERÇEKTEN çöpe gidecek miktar. Dilimleyicinin bildirdiği sayı
   * baskının TOPLAMI; etiketsiz gösterildiğinde kullanıcı onu "şimdiye kadar harcanan" sanıp
   * kaybı üç katı görüyordu. Yüzde bilinmiyorsa toplam olduğu AÇIKÇA yazılır.
   */
  gramsText: string | null;
  /** Baskı bitmeye çok yakın (≥ %85 ya da kalan ≤ 20 dk) → ek uyarı. */
  nearFinish: boolean;
}

export function cancelSummary(p: {
  job: PrinterJob | null | undefined;
  nowMs: number;
  paused: boolean;
}): CancelSummary {
  const empty: CancelSummary = { pct: null, elapsedText: null, remainingText: null, gramsText: null, nearFinish: false };
  const job = p.job;
  if (!job) return empty;

  const pct = Number.isFinite(job.progress) ? Math.round(clamp01(job.progress) * 100) : null;

  const startMs = new Date(job.startedAt).getTime();
  const elapsedSec = Number.isFinite(startMs) && p.nowMs > startMs ? (p.nowMs - startMs) / 1000 : null;

  let remainingSec: number | null = null;
  if (job.remainingKnown) {
    if (p.paused || p.nowMs <= 0) {
      remainingSec = Math.max(0, job.remainingSec);
    } else {
      const endMs = new Date(job.endsAt).getTime();
      remainingSec = Number.isFinite(endMs) ? Math.max(0, (endMs - p.nowMs) / 1000) : Math.max(0, job.remainingSec);
    }
  }

  return {
    pct,
    elapsedText: elapsedSec != null && elapsedSec >= 30 ? formatRemaining(elapsedSec) : null,
    remainingText: remainingSec != null ? formatRemaining(remainingSec) : null,
    gramsText: spentGramsText(job.filamentGrams, pct),
    nearFinish: (pct != null && pct >= 85) || (remainingSec != null && remainingSec <= 20 * 60),
  };
}

/** ⚠️ Yalnız GÖSTERİM — hiçbir maliyet/kâr hesabına girmez. */
export function spentGramsText(totalGrams: number | null | undefined, pct: number | null): string | null {
  if (totalGrams == null || !Number.isFinite(totalGrams) || totalGrams <= 0) return null;
  if (pct == null) return `toplam ${Math.round(totalGrams)} g`;
  const spent = Math.round((totalGrams * Math.min(100, Math.max(0, pct))) / 100);
  return `~${spent} g harcandı`;
}

// ── MADDE 18: üst özet — sıradaki bitiş + sorun çipleri ────────────────────

export interface NextFinish {
  id: string;
  name: string;
  remainingSec: number;
}

/** Önce hangi yazıcı boşalacak? Kalan süresi BİLİNMEYEN baskı yarışa girmez (uydurma sıra yok). */
export function nextFinishing(printers: PanelPrinter[] | undefined, nowMs: number): NextFinish | null {
  let best: NextFinish | null = null;
  for (const p of printers ?? []) {
    if (!p.online || p.status !== "printing" || !p.job || !p.job.remainingKnown) continue;
    const endMs = new Date(p.job.endsAt).getTime();
    const remainingSec =
      nowMs > 0 && Number.isFinite(endMs) ? Math.max(0, (endMs - nowMs) / 1000) : Math.max(0, p.job.remainingSec);
    if (!Number.isFinite(remainingSec)) continue;
    if (!best || remainingSec < best.remainingSec) best = { id: p.id, name: p.name, remainingSec };
  }
  return best;
}

export interface TroubleItem {
  id: string;
  name: string;
  /** Kırmızı mı amber mi. */
  severe: boolean;
  /** Çipte yazacak kısa metin. */
  text: string;
}

/** Kartlara tek tek bakmadan "nerede sorun var" — en ağırdan hafife, en çok `limit` tane. */
export function troubleList(printers: PanelPrinter[] | undefined, limit = 3): TroubleItem[] {
  const out: TroubleItem[] = [];
  for (const p of printers ?? []) {
    if (p.type === "sim") continue;
    if (p.connection === "unsupported") {
      out.push({ id: p.id, name: p.name, severe: false, text: "desteklenmiyor" });
      continue;
    }
    if (p.connection === "unconfigured") {
      out.push({ id: p.id, name: p.name, severe: false, text: "kurulum eksik" });
      continue;
    }
    if (p.connection === "offline" || !p.online) {
      out.push({ id: p.id, name: p.name, severe: true, text: "ulaşılamıyor" });
      continue;
    }
    if (p.status === "error") {
      out.push({ id: p.id, name: p.name, severe: true, text: "baskı durdu" });
      continue;
    }
    if (p.status === "paused") {
      out.push({ id: p.id, name: p.name, severe: false, text: "duraklatıldı" });
      continue;
    }
    const severe = (p.warnings ?? []).find((w) => w.level === "fatal" || w.level === "serious");
    if (severe) out.push({ id: p.id, name: p.name, severe: true, text: "uyarı var" });
  }
  out.sort((a, b) => Number(b.severe) - Number(a.severe));
  return out.slice(0, limit);
}

export const PAUSED_REMINDER_MS = 20 * 60_000;

/**
 * 20 dakikayı geçen duraklatma → kısa hatırlatma ("unutuldu mu?").
 *
 * ⚠️ Damga, duraklamanın GERÇEKLEŞTİĞİ an değil, panelin onu İLK GÖRDÜĞÜ andır (hiçbir uçtan
 * gelmiyor). Bu yüzden süre kesin bir olgu gibi yazılamaz: gece duraklamış bir baskı sabah
 * açılışta "20 dakika" görünürdü. Metin ALT SINIR olduğunu söyler.
 */
export function pausedReminder(
  pausedSinceMs: number | null | undefined,
  nowMs: number,
  thresholdMs = PAUSED_REMINDER_MS,
): string | null {
  if (pausedSinceMs == null || !Number.isFinite(pausedSinceMs) || nowMs <= 0) return null;
  const elapsed = nowMs - pausedSinceMs;
  if (elapsed < thresholdMs) return null;
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes >= 120) return `En az ${Math.floor(minutes / 60)} saattir duraklatılmış`;
  return `En az ${minutes} dakikadır duraklatılmış`;
}

// ── MADDE 11: 3B izleyiciye gerçek filament renkleri ───────────────────────

const HEX6 = /^#?[0-9a-fA-F]{6}$/;

/**
 * Slot dizisini kafa indeksine göre renk dizisine çevirir (dizin = kafa indeksi).
 * Boş slot ve okunamayan renk `null` kalır → izleyici dosyadaki rengi kullanır.
 */
export function slotToolColors(slots: PanelSlot[] | undefined): (string | null)[] {
  const out: (string | null)[] = [];
  for (const s of slots ?? []) {
    const idx = Math.round(s.slot);
    if (!Number.isFinite(idx) || idx < 0 || idx > 63) continue;
    const raw = (s.color || "").trim();
    const color = !s.empty && HEX6.test(raw) ? `#${raw.replace("#", "").toUpperCase()}` : null;
    while (out.length <= idx) out.push(null);
    out[idx] = color;
  }
  return out;
}
