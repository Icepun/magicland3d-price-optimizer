/**
 * Yazıcı panelinin SAF görünüm mantığı — React yok, ağ yok, yan etki yok.
 *
 * Kart bileşeni büyüdükçe "hangi kare gösterilecek", "bu durum hangi renk", "hazırlanıyor mu"
 * gibi kararlar JSX'in içine gömülüyordu ve test edilemiyordu. Faz 3'te bu kararların üçü de
 * hatalı çıktı (yanlış kare, kırmızı görünen sağlıklı baskı, her renk değişiminde kaybolan
 * bilgi). Kararlar burada, testleriyle birlikte.
 *
 * ⚠️ Buradaki hiçbir şey maliyet/kâr hesabına dokunmaz — yalnız gösterim.
 */

import type { PrinterControlCaps } from "@/core/printers/controls";
import type { EtaSource, ProgressSource } from "@/core/printers/eta";

// ── API sözleşmesinin AYNADAKİ hâli ────────────────────────────────────────
// Bu tipler `src/app/api/printers/route.ts` ile birebir aynı olmak ZORUNDA. Uyum
// `panel-view.test.ts` içinde iki yönlü atanabilirlik kontrolüyle derleme zamanında
// doğrulanır — alan eklenip burada unutulursa tsc patlar (eskiden sessizce kör kalıyordu).

export type PrinterStatus = "printing" | "finished" | "idle" | "paused" | "error";

export interface PrinterJob {
  productName: string;
  productImage: string | null;
  startedAt: string;
  endsAt: string;
  progress: number;
  remainingSec: number;
  layerCurrent: number | null;
  layerTotal: number;
  filamentType: string;
  filamentColor: string;
  remainingKnown: boolean;
  progressSource: ProgressSource;
  etaSource: EtaSource;
  plateThumbnail: string | null;
  storeImage: string | null;
  filamentGrams: number | null;
  activeSlots: number[];
  live: {
    filePosition: number | null;
    fileSize: number | null;
    zHeight: number | null;
    nozzleX: number | null;
    nozzleY: number | null;
  };
}

export interface PanelWarning {
  code: string | null;
  level: "fatal" | "serious" | "common" | "info";
  text: string;
}

export interface PanelSlot {
  slot: number;
  color: string;
  type: string;
  empty: boolean;
}

export interface PanelPrinter {
  id: string;
  name: string;
  brand: string;
  model: string;
  accent: string;
  type: "moonraker" | "bambu" | "sim";
  status: PrinterStatus;
  online: boolean;
  note: string | null;
  connection: "ok" | "offline" | "unconfigured" | "unsupported";
  statusMessage: string | null;
  warnings: PanelWarning[];
  currentFilename: string | null;
  matchedProductId: string | null;
  temps: { nozzle: number; nozzleTarget: number; bed: number; bedTarget: number; nozzles?: { index: number; temp: number; target: number; active: boolean }[] };
  caps: PrinterControlCaps;
  speed: {
    percent: number | null;
    presets: readonly number[];
    levels: readonly { level: number; label: string; pct: number }[] | null;
    level: number | null;
  };
  light: { supported: boolean; readable: boolean; on: boolean | null };
  /** Mantıksal takım → fiziksel kafa (U1 extruder_map_table). Boş = eşleme bilinmiyor. */
  toolMap?: number[];
  parts?: { current: string | null; excluded: string[]; count: number };
  pauseAtLayer: number | null;
  defectWatch: { supported: boolean; enabled: boolean; spaghetti: boolean; cleanBed: boolean } | null;
  slots: PanelSlot[];
  job: PrinterJob | null;
}

export const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

// ── MADDE 5: durum rengi ANLAM paletinden gelir, yazıcının kimlik renginden DEĞİL ──
//
// Eskiden "Yazdırıyor" rozeti/çerçevesi yazıcının accent rengiyle çiziliyordu: Neptune 4 Plus'ın
// kimlik rengi kırmızı olduğu için sağlıklı baskı "Hata" ile, Snapmaker'ınki turuncu olduğu için
// "Duraklatıldı" ile aynı görünüyordu. Artık durum → sabit ton; kimlik rengi yalnız ikon ve ince
// üst çizgide. Renk tek sinyal değil: her tonun kendi ikonu/biçimi var (ikon adı bileşende).

export type StatusTone =
  | "printing" | "paused" | "finished" | "error" | "idle" | "offline" | "unconfigured" | "unsupported";

export interface StatusVisual {
  tone: StatusTone;
  label: string;
  /** Metin/ikon rengi. */
  color: string;
  /** Rozet zemini. */
  soft: string;
  /** Rozet/kart kenarlığı. */
  line: string;
  /** Kart çerçevesi bu tonla vurgulansın mı (boşta/çevrimdışı sessiz kalır). */
  emphasize: boolean;
}

// Tonların TEK kaynağı `globals.css` içindeki `--status-*` değişkenleridir. Buraya gömülü
// renk YAZILMAZ: iki palet yan yana durduğunda aynı ekranda iki farklı "Yazdırıyor" rengi çıkıyor.
const TONE_VISUALS: Record<StatusTone, StatusVisual> = {
  printing: {
    tone: "printing", label: "Yazdırıyor",
    color: "var(--status-printing)", soft: "var(--status-printing-soft)", line: "var(--status-printing-line)",
    emphasize: true,
  },
  paused: {
    tone: "paused", label: "Duraklatıldı",
    color: "var(--status-paused)", soft: "var(--status-paused-soft)", line: "var(--status-paused-line)",
    emphasize: true,
  },
  finished: {
    tone: "finished", label: "Tamamlandı",
    color: "var(--status-done)", soft: "var(--status-done-soft)", line: "var(--status-done-line)",
    emphasize: true,
  },
  error: {
    tone: "error", label: "Hata",
    color: "var(--status-error)", soft: "var(--status-error-soft)", line: "var(--status-error-line)",
    emphasize: true,
  },
  idle: {
    tone: "idle", label: "Hazır",
    color: "var(--status-idle)", soft: "var(--status-idle-soft)", line: "var(--status-idle-line)",
    emphasize: false,
  },
  offline: {
    tone: "offline", label: "Çevrimdışı",
    color: "var(--status-offline)", soft: "var(--status-offline-soft)", line: "var(--status-offline-line)",
    emphasize: false,
  },
  unconfigured: {
    tone: "unconfigured", label: "Kurulum tamamlanmadı",
    color: "var(--status-setup)", soft: "var(--status-setup-soft)", line: "var(--status-setup-line)",
    emphasize: false,
  },
  unsupported: {
    tone: "unsupported", label: "Desteklenmiyor",
    color: "var(--status-offline)", soft: "var(--status-offline-soft)", line: "var(--status-offline-line)",
    emphasize: false,
  },
};

/** Bağlantı + durum → tek bir görsel ton. "kurulmadı" ile "ulaşılamadı" AYRI tonlardır. */
export function resolveStatusVisual(p: {
  status: PrinterStatus;
  connection?: PanelPrinter["connection"];
  online: boolean;
  type: PanelPrinter["type"];
}): StatusVisual {
  const connection = p.connection ?? (p.online ? "ok" : "offline");
  if (p.type !== "sim") {
    if (connection === "unsupported") return TONE_VISUALS.unsupported;
    if (connection === "unconfigured") return TONE_VISUALS.unconfigured;
    if (connection === "offline" || !p.online) return TONE_VISUALS.offline;
  }
  return TONE_VISUALS[p.status];
}

export function statusVisualOf(tone: StatusTone): StatusVisual {
  return TONE_VISUALS[tone];
}

// ── MADDE 2: kafa değişiminde kart bilgileri kaybolmasın ───────────────────
//
// Snapmaker U1 HER renk değişiminde nozulu 70°'den 220°'ye ısıtıyor. "Isınıyor → hazırlanıyor"
// kuralı yüzünden kart, 4 bin küsur kez yüzdeyi/katmanı/kalan süreyi gizleyip baştan
// "Baskıya hazırlanıyor" yazıyordu. Hazırlık YALNIZ baskının gerçek başında olur: ilerleme ya da
// katman göründüyse baskı başlamıştır, ısınma bundan sonra sadece küçük bir çiptir.

export interface StageState {
  /** Baskı henüz gerçekten başlamadı → belirsiz bar + "hazırlanıyor". */
  preparing: boolean;
  /** Isınma çipi (baskı sürerken kafa/tabla ısınıyor) gösterilsin mi. */
  heatingChip: boolean;
}

export function resolveStage(p: {
  status: PrinterStatus;
  heating: boolean;
  progress: number;
  layerCurrent: number | null;
}): StageState {
  const printing = p.status === "printing";
  const started = (p.layerCurrent ?? 0) >= 1 || p.progress > 0.01;
  const preparing = printing && !started;
  return { preparing, heatingChip: p.heating && !preparing };
}

// ── MADDE 4: dolan model DOĞRU kareyi göstersin ────────────────────────────
//
// İnşa kareleri KATMAN oranıyla üretiliyor, kare seçimi ise bayt ilerlemesiyle yapılıyordu.
// Canlı ölçüm (12 Ağu): bayt %90 iken katman %66,5 → 23,5 puan sapma; kart modeli olduğundan
// çok daha dolu gösteriyordu. Kare seçimi artık katman oranından; katman yoksa ilerlemeye düşer.

export interface FramePick {
  index: number;
  source: "layer" | "progress";
}

export function pickBuildFrame(p: {
  frameCount: number;
  layerCurrent: number | null;
  layerTotal: number;
  progress: number;
}): FramePick {
  if (p.frameCount <= 0) return { index: 0, source: "progress" };
  const layerKnown = p.layerCurrent != null && p.layerCurrent > 0 && p.layerTotal > 0;
  const ratio = layerKnown
    ? clamp01(p.layerCurrent! / p.layerTotal)
    : clamp01(p.progress);
  const index = Math.min(p.frameCount - 1, Math.max(0, Math.floor(ratio * p.frameCount)));
  return { index, source: layerKnown ? "layer" : "progress" };
}

// ── MADDE 7: canlı aşama — katman rozeti, katman indeksi, nozul noktası ────

/** "katman 448/1333" — katman bilinmiyorsa null (uydurma sayı yazma). */
export function layerBadgeText(layerCurrent: number | null, layerTotal: number): string | null {
  if (layerCurrent == null || layerCurrent < 1) return null;
  const cur = Math.round(layerCurrent);
  if (!(layerTotal > 0)) return `katman ${cur}`;
  return `katman ${Math.min(cur, Math.round(layerTotal))}/${Math.round(layerTotal)}`;
}

/**
 * Görselleştirme paketindeki 0 TABANLI katman indeksi.
 * `layerCurrent` (1 tabanlı) TERCİH EDİLİR: `file_position` hareket kuyruğu yüzünden gerçekte
 * basılanın birkaç KB önündedir ve katmanı bir ileri gösterebilir. Katman yoksa bayt konumundan
 * çözülen indekse düşülür.
 */
export function resolvePackLayerIndex(p: {
  layerCurrent: number | null;
  byteLayer: number | null;
  layerCount: number;
}): number | null {
  if (p.layerCount <= 0) return null;
  const fromLayer = p.layerCurrent != null && p.layerCurrent > 0 ? Math.round(p.layerCurrent) - 1 : null;
  const idx = fromLayer ?? (p.byteLayer != null && p.byteLayer >= 0 ? p.byteLayer : null);
  if (idx == null) return null;
  return Math.min(p.layerCount - 1, Math.max(0, idx));
}

/** Katman İÇİ ince oran (0..1) — yalnız bayt konumundan; katman kararı buna bağlanmaz. */
export function intraLayerFraction(
  layerStartByte: number | null,
  layerEndByte: number | null,
  filePosition: number | null,
): number | null {
  if (layerStartByte == null || layerEndByte == null || filePosition == null) return null;
  if (!Number.isFinite(layerStartByte) || !Number.isFinite(layerEndByte) || !Number.isFinite(filePosition)) return null;
  const span = layerEndByte - layerStartByte;
  if (span <= 0) return null;
  return clamp01((filePosition - layerStartByte) / span);
}

/** Nozul noktasının çizim çerçevesi (mm cinsinden gcode koordinatları). */
export interface StageFrame {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Tabla ölçüleri — kart üstündeki mini görünümün ölçeği. Bilinmeyen modelde çizim YAPILMAZ. */
export function bedFrameFor(brand: string, model: string): StageFrame | null {
  const key = `${brand} ${model}`.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
  const size = (w: number, d: number): StageFrame => ({ minX: 0, maxX: w, minY: 0, maxY: d });
  if (key.includes("neptune 4 max") || key.includes("n4 max")) return size(420, 420);
  if (key.includes("neptune 4 plus") || key.includes("n4 plus")) return size(320, 320);
  if (key.includes("neptune 4 pro") || key.includes("n4 pro")) return size(225, 225);
  if (key.includes("neptune 4") || key.includes("neptune4")) return size(225, 225);
  // U1: 270×270. Eskiden 200 yazıyordu ve kafa konumunun %31'i çerçevenin DIŞINA düşüyordu →
  // nokta gri ve kenara yapışık çiziliyor, katman karosu 1,35× şişip Y>200 kısmı kırpılıyordu.
  // Yazıcıdan doğrulandı (14 Ağu 2026): bed_mesh 3..267 (3 mm pay) ve dosyanın dilimleyici
  // altbilgisi `printable_area = 0.5x1,270.5x1,270.5x271,0.5x271`.
  // ⚠️ `toolhead.axis_maximum` (U1'de 271×335) TABLA DEĞİL — kafa doklarını içeren hareket alanı.
  if (key.includes("snapmaker") && key.includes("u1")) return size(270, 270);
  if (key.includes("a1 mini")) return size(180, 180);
  if (key.includes("bambu") || key.includes("a1") || key.includes("p1") || key.includes("x1")) return size(256, 256);
  return null;
}

export interface NozzleDot {
  /** Çerçeve içindeki oran — 0 sol/üst, 1 sağ/alt (ekran koordinatı: Y ters çevrilmiş). */
  left: number;
  top: number;
  /** Nozul çerçevenin dışındaydı (park/temizleme) → nokta soluk çizilir. */
  clamped: boolean;
}

/** Gcode mm koordinatını çizim çerçevesindeki orana çevir. Y ekranda TERS (yukarısı maxY). */
export function nozzleDot(
  x: number | null,
  y: number | null,
  frame: StageFrame | null,
): NozzleDot | null {
  if (x == null || y == null || !frame) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const w = frame.maxX - frame.minX;
  const h = frame.maxY - frame.minY;
  if (!(w > 0) || !(h > 0)) return null;
  const rawLeft = (x - frame.minX) / w;
  const rawTop = (frame.maxY - y) / h;
  const left = clamp01(rawLeft);
  const top = clamp01(rawTop);
  return { left, top, clamped: left !== rawLeft || top !== rawTop };
}

// ── MADDE 1: kalan süre — BİLİNMEYEN ≠ SIFIR ───────────────────────────────

export const UNKNOWN = "—";

export function formatRemaining(sec: number): string {
  const s0 = Math.max(0, Math.round(sec));
  const h = Math.floor(s0 / 3600);
  const m = Math.floor((s0 % 3600) / 60);
  const s = s0 % 60;
  if (h > 0) return `${h}sa ${m}dk`;
  if (m > 0) return `${m}dk ${s.toString().padStart(2, "0")}sn`;
  return `${s}sn`;
}

/** Bitiş saati — bugünse "HH:MM", yarınsa "yarın HH:MM", sonraysa "5 Tem 14:30". */
export function formatClock(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const dayStart = new Date(ms).setHours(0, 0, 0, 0);
  const curStart = new Date(nowMs).setHours(0, 0, 0, 0);
  const dayDiff = Math.round((dayStart - curStart) / 86400000);
  if (dayDiff <= 0) return `${hh}:${mm}`;
  if (dayDiff === 1) return `yarın ${hh}:${mm}`;
  return `${d.toLocaleDateString("tr-TR", { day: "numeric", month: "short" })} ${hh}:${mm}`;
}

export interface RemainingView {
  /** Ekranda yazacak metin ("2sa 14dk" ya da "—"). */
  text: string;
  /** Bitiş saati metni — kalan süre bilinmiyorsa null (çelişki yazmayalım). */
  clock: string | null;
  known: boolean;
}

/**
 * Kalan süre + bitiş saati TEK kaynaktan üretilir; ikisi asla çelişmez.
 * Bitiş saati gösterilen kalan süreden hesaplanır (yazıcının `endsAt` damgası duraklatmada
 * her yoklamada ileri kaydığı için ikisi ayrı hesaplanınca birbirini tutmuyordu).
 */
export function resolveRemaining(p: {
  remainingSec: number;
  remainingKnown: boolean;
  nowMs: number;
  finished: boolean;
  showClock: boolean;
}): RemainingView {
  if (p.finished) return { text: formatRemaining(0), clock: null, known: true };
  if (!p.remainingKnown || !Number.isFinite(p.remainingSec)) {
    return { text: UNKNOWN, clock: null, known: false };
  }
  const sec = Math.max(0, p.remainingSec);
  return {
    text: formatRemaining(sec),
    clock: p.showClock && p.nowMs > 0 ? formatClock(p.nowMs + sec * 1000, p.nowMs) : null,
    known: true,
  };
}

// ── MADDE 12: gerçek filament renkleri ─────────────────────────────────────

export interface SlotChip {
  slot: number;
  color: string;
  type: string;
  empty: boolean;
  /** Bu baskıda kullanılıyor → vurgulu; kullanılmıyor → soluk. */
  active: boolean;
}

/** Slot şeridi. Slot bildirmeyen yazıcıda dilimleyicinin rengiyle tek çip üretilir. */
export function buildSlotChips(
  slots: PanelSlot[] | undefined,
  activeSlots: number[] | undefined,
  fallback?: { color: string; type: string },
): SlotChip[] {
  const active = new Set((activeSlots ?? []).filter((n) => Number.isFinite(n)));
  const list = (slots ?? []).slice().sort((a, b) => a.slot - b.slot);
  if (list.length > 0) {
    return list.map((s) => ({
      slot: s.slot,
      color: s.empty ? "" : s.color || "",
      type: s.type || "",
      empty: s.empty,
      // Hiç aktif slot bildirilmediyse hepsi eşit görünsün (yanlışlıkla hepsini soluklaştırma).
      active: active.size === 0 ? true : active.has(s.slot),
    }));
  }
  // Slot bildirmeyen yazıcıda da numaralandırma tabanı AYNI kalmalı (0) — yoksa aynı panelde
  // iki farklı şema görünüyor. Ekrandaki numara `slotLabel` ile üretilir.
  if (fallback && (fallback.color || fallback.type)) {
    return [{ slot: 0, color: fallback.color, type: fallback.type, empty: false, active: true }];
  }
  return [];
}

/**
 * Ekranda görünen yuva numarası. İç veri (renk dizisi, `activeSlots`, kafa indeksi) 0 TABANLI
 * kalır; yazıcının kendi ekranı ve AMS etiketleri 1'den başladığı için YALNIZ gösterim kayar.
 */
export function slotLabel(slot: number): string {
  const n = Math.round(slot);
  return String(Number.isFinite(n) ? n + 1 : 1);
}

// ── MADDE 3: görsel zinciri — biri düşerse SIRADAKİNE geç ──────────────────
//
// Plaka görüntüsü yazıcının LAN adresinden, mağaza fotoğrafı buluttan gelir. Tek bir dize
// hesaplanıp yalnız o denendiğinde, yazıcı meşgulken kart bomboş kalıyordu.

/** Öncelik sırası: basılan plaka → model küçük resmi → ürün görseli → mağaza fotoğrafı. */
export function jobImageCandidates(
  job: { plateThumbnail?: string | null; productImage?: string | null; storeImage?: string | null } | null | undefined,
  liveThumbnail?: string | null,
): string[] {
  const out: string[] = [];
  for (const c of [job?.plateThumbnail, liveThumbnail, job?.productImage, job?.storeImage]) {
    const v = (c || "").trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Yüklenemeyenleri atlayıp sıradaki adayı ver; hepsi düştüyse null (yer tutucu çizilir). */
export function pickImage(candidates: readonly string[], failed: readonly string[]): string | null {
  for (const c of candidates) if (!failed.includes(c)) return c;
  return null;
}

// ── MADDE 14: uyarılar ─────────────────────────────────────────────────────

export interface WarningView extends PanelWarning {
  /** Kırmızı mı amber mi (fatal/serious kırmızı). */
  severe: boolean;
}

const LEVEL_RANK: Record<PanelWarning["level"], number> = { fatal: 0, serious: 1, common: 2, info: 3 };

/** En ağırdan hafife sırala, aynı metni tekrarlama, kartı boğmamak için en çok `limit` tane. */
export function orderWarnings(warnings: PanelWarning[] | undefined, limit = 3): WarningView[] {
  const seen = new Set<string>();
  const out: WarningView[] = [];
  for (const w of (warnings ?? []).slice().sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level])) {
    const text = (w.text || "").trim();
    if (!text) continue;
    const key = text.toLocaleLowerCase("tr-TR");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...w, text, severe: w.level === "fatal" || w.level === "serious" });
    if (out.length >= limit) break;
  }
  return out;
}

export interface ConnectionNotice {
  title: string;
  /** İkinci satır — NEYİN eksik olduğunu söyler ("Yazıcı bilgileri eksik." yerine). */
  detail: string;
  action: "manage" | "retry" | "none";
}

/**
 * Sunucunun kısa açıklaması (`note`) "Başlık — ayrıntı" biçiminde geliyor; başlığı rozet zaten
 * yazdığı için yalnız AYRINTI kısmı ikinci satıra düşer. Ayrıntı yoksa jenerik satır kullanılır.
 */
function noteDetail(note: string | null | undefined): string | null {
  const raw = (note ?? "").trim();
  if (!raw) return null;
  const dash = raw.indexOf("—");
  const tail = (dash >= 0 ? raw.slice(dash + 1) : raw).trim();
  if (!tail) return null;
  return tail.charAt(0).toLocaleUpperCase("tr-TR") + tail.slice(1);
}

/** Bağlantı sorununun kullanıcıya dönük iki satırı + eylem etiketi. */
export function connectionNotice(
  connection: PanelPrinter["connection"] | undefined,
  online: boolean,
  note?: string | null,
): ConnectionNotice | null {
  const c = connection ?? (online ? "ok" : "offline");
  if (c === "unsupported") {
    return { title: "Desteklenmiyor", detail: "Bu yazıcı uygulamadan yönetilemiyor.", action: "none" };
  }
  if (c === "unconfigured") {
    return { title: "Kurulum tamamlanmadı", detail: noteDetail(note) ?? "Yazıcı bilgileri eksik.", action: "manage" };
  }
  if (c === "offline" || !online) {
    return { title: "Yazıcıya ulaşılamadı", detail: "Yazıcı açık ve aynı ağda mı?", action: "retry" };
  }
  return null;
}
