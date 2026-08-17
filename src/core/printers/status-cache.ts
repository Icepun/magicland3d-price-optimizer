/**
 * Yazıcı durumu için PAYLAŞILAN süreç-içi önbellek.
 *
 * Neden: panel API (5sn) ve relay (10sn) aynı yazıcıları BAĞIMSIZ canlı yokluyordu → çift LAN
 * trafiği; üstelik çevrimdışı bir yazıcı her panel çağrısını 1.5–2.2sn geciktiriyordu (yanıt =
 * en yavaş yazıcı). Bu modül:
 *   1) Taze sonucu (≤4sn) iki tüketiciye de tek yoklamadan verir (eşzamanlı istekler tek uçuşta birleşir).
 *   2) ÇEVRİMDIŞI yazıcıyı ÜSTEL GERİ ÇEKİLMEYLE dener (8sn → 16 → 32 → … → en fazla 2dk) ve
 *      bu denemeyi ARKA PLANDA yapar: çağıran son bilinen durumu ANINDA alır. Kapalı bir yazıcı
 *      artık diğer üçünü bekletmez (eski hâlinde 30sn'de bir 3sn'lik gecikme paneli kilitliyordu).
 *   3) Tek seferlik yoklama kaçağında (paket düşmesi/nginx meşgul) hemen "çevrimdışı" göstermez:
 *      son 25sn içinde çevrimiçi görülen yazıcı için İLK başarısız yoklamada son-iyi durum verilir
 *      (şüpheli işaretlenir); ikinci ardışık başarısızlık gerçek çevrimdışı sayılır (kart titremez).
 *   4) KONTROL KOMUTU SONRASI (MADDE 6): ilgili yazıcının önbelleği geçersiz kılınır ve kısa süre
 *      (10sn) daha sık yoklanır — kart eski duruma geri zıplamaz.
 */
import { processSingleton } from "./process-singleton";
import {
  fetchMoonrakerStatus, fetchMoonrakerMeta, moonrakerThumbUrl,
  fetchMoonrakerExtras, emptyMoonrakerExtras,
  type MoonrakerStatus, type MoonrakerMeta, type MoonrakerExtras,
} from "./moonraker";
import { mergeMoonrakerExtras } from "./extras-merge";
import { fileMatchKey, deepFileMatchKey } from "./file-match";
import { getBambuStatus, getBambuAmsSlots, type BambuStatus, type BambuSlot } from "./bambu";
import { prisma } from "@/lib/prisma";

const FRESH_MS = 4_000;          // çevrimiçi sonuç bu kadar süre taze sayılır (panel 5sn + relay 10sn paylaşır)
const GRACE_MS = 25_000;         // son-iyi durumun "tek kaçak" için geçerli kalma penceresi
/** Çevrimdışı yeniden deneme: ilk aralık, sonra her başarısızlıkta iki katı. */
const OFFLINE_BASE_MS = 8_000;
const OFFLINE_MAX_MS = 120_000;
/** Kontrol komutundan sonra hızlı yoklama penceresi ve o penceredeki tazelik eşiği. */
const BOOST_WINDOW_MS = 10_000;
const BOOST_FRESH_MS = 700;

interface Entry<T> { at: number; value: T; offline: boolean; suspect: boolean; fails: number }
const statusCache = processSingleton("sc_statusCache", () => new Map<string, Entry<unknown>>());
const inflight = processSingleton("sc_inflight", () => new Map<string, Promise<unknown>>());
/** Anahtar → hızlı-yoklama penceresinin bitiş zamanı. */
const boostUntil = processSingleton("sc_boostUntil", () => new Map<string, number>());

function moonrakerKey(host: string, port: number): string {
  return `m|${host}:${port}`;
}
function bambuKey(host: string, serial: string): string {
  return `b|${host}|${serial}`;
}

/** Üstel geri çekilme: 8s, 16s, 32s, 64s, 120s (tavan). */
function offlineRetryMs(fails: number): number {
  const n = Math.max(1, fails);
  return Math.min(OFFLINE_MAX_MS, OFFLINE_BASE_MS * 2 ** (n - 1));
}

function freshWindow(key: string, e: Entry<unknown>): number {
  if ((boostUntil.get(key) ?? 0) > Date.now()) return BOOST_FRESH_MS;
  return e.offline ? offlineRetryMs(e.fails) : FRESH_MS;
}

function probeOnce<T>(
  key: string,
  probe: () => Promise<T>,
  isOffline: (v: T) => boolean,
  prev: Entry<T> | undefined,
): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const startedAt = Date.now();
  const p = (async () => {
    try {
      const v = await probe();
      const off = isOffline(v);
      // HİSTEREZİS: az önce çevrimiçiydi + ilk başarısız yoklama → son-iyi durumu bir kez daha
      // ver (kart "çevrimdışı" diye titremesin); bir SONRAKİ başarısızlık gerçek çevrimdışı.
      if (off && prev && !prev.offline && !prev.suspect && startedAt - prev.at < GRACE_MS) {
        statusCache.set(key, { ...prev, at: Date.now(), suspect: true });
        return prev.value;
      }
      statusCache.set(key, {
        at: Date.now(),
        value: v,
        offline: off,
        suspect: false,
        fails: off ? (prev?.offline ? prev.fails + 1 : 1) : 0,
      });
      return v;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

async function withCache<T>(
  key: string,
  probe: () => Promise<T>,
  isOffline: (v: T) => boolean,
): Promise<T> {
  const e = statusCache.get(key) as Entry<T> | undefined;
  const now = Date.now();
  if (e && now - e.at < freshWindow(key, e)) return e.value;

  // ÇEVRİMDIŞI + elde son bilinen durum var → ARKA PLANDA tazele, çağıranı BEKLETME.
  // (Kapalı yazıcının 1.5–3sn'lik zaman aşımı paneli bekletmesin.)
  if (e && e.offline) {
    void probeOnce(key, probe, isOffline, e).catch(() => {});
    return e.value;
  }
  return probeOnce(key, probe, isOffline, e);
}

export function getMoonrakerStatusCached(host: string, port: number): Promise<MoonrakerStatus> {
  return withCache(moonrakerKey(host, port), () => fetchMoonrakerStatus(host, port), (v) => !v.online);
}

export function getBambuStatusCached(host: string, accessCode: string, serial: string): Promise<BambuStatus> {
  return withCache(bambuKey(host, serial), () => getBambuStatus(host, accessCode, serial), (v) => !v.online);
}

/**
 * MADDE 6 — kontrol komutu gönderildi: bu yazıcının önbelleğini AT ve kısa süre daha sık yokla.
 * Aksi halde komuttan hemen önce alınmış durum 4sn daha "taze" sayılıyor, kart eski duruma geri
 * zıplıyordu ("duraklattım, kart yine 'Basıyor' dedi").
 */
export function bumpPrinterStatus(key: string): void {
  statusCache.delete(key);
  extrasCache.delete(key);
  bambuSlotsCache.delete(key);
  boostUntil.set(key, Date.now() + BOOST_WINDOW_MS);
}

export function bumpMoonrakerStatus(host: string, port: number): void {
  bumpPrinterStatus(moonrakerKey(host, port));
}

export function bumpBambuStatus(host: string, serial: string): void {
  bumpPrinterStatus(bambuKey(host, serial));
}

/** Testler için: tüm durum önbelleğini sıfırla. */
export function resetPrinterStatusCache(): void {
  statusCache.clear();
  inflight.clear();
  boostUntil.clear();
  extrasCache.clear();
  extrasInflight.clear();
  bambuSlotsCache.clear();
  bambuSlotsInflight.clear();
}

// ── Yan bilgiler (ışık, slot renkleri, katman duraklatması, gözetim) ────────────────────────
// Saniyede değişmeyen değerler; panel 5sn'de bir sorsa bile LAN'a 15sn'de bir gider.
// Kontrol komutu sonrası (bumpPrinterStatus) sıfırlanır → ışık düğmesi anında doğru görünür.
const EXTRAS_TTL_MS = 15_000;
const extrasCache = processSingleton("sc_extrasCache", () => new Map<string, { at: number; value: MoonrakerExtras }>());
const extrasInflight = processSingleton("sc_extrasInflight", () => new Map<string, Promise<MoonrakerExtras>>());

export async function getMoonrakerExtrasCached(host: string, port: number): Promise<MoonrakerExtras> {
  const k = moonrakerKey(host, port);
  const hit = extrasCache.get(k);
  if (hit && Date.now() - hit.at < EXTRAS_TTL_MS) return hit.value;
  const running = extrasInflight.get(k);
  const p = running ?? (async () => {
    try {
      // Tek kaçan sorgu BİLİNEN değerleri silmesin: rozetler/çipler/düğmeler 15sn kaybolup
      // geri gelmemeli, kart yerleşimi zıplamamalı.
      const merged = mergeMoonrakerExtras(hit?.value, await fetchMoonrakerExtras(host, port));
      extrasCache.set(k, { at: Date.now(), value: merged });
      return merged;
    } catch {
      return hit?.value ?? emptyMoonrakerExtras();
    } finally {
      extrasInflight.delete(k);
    }
  })();
  if (!running) extrasInflight.set(k, p);
  // Elde önceki değer varsa BEKLEME: yan bilgiler 15 saniyede bir tazelenir, panelin yanıt
  // süresi bunlara takılmamalı (MADDE 20).
  if (hit) { void p.catch(() => {}); return hit.value; }
  return p;
}

/** Bambu AMS slotları — renk sık değişmez, dakikada bir yeter (MADDE 12). */
const BAMBU_SLOTS_TTL_MS = 60_000;
const bambuSlotsCache = processSingleton("sc_bambuSlotsCache", () => new Map<string, { at: number; value: BambuSlot[] }>());
const bambuSlotsInflight = processSingleton("sc_bambuSlotsInflight", () => new Map<string, Promise<BambuSlot[]>>());

export async function getBambuSlotsCached(host: string, accessCode: string, serial: string): Promise<BambuSlot[]> {
  const k = bambuKey(host, serial);
  const hit = bambuSlotsCache.get(k);
  if (hit && Date.now() - hit.at < BAMBU_SLOTS_TTL_MS) return hit.value;
  const running = bambuSlotsInflight.get(k);
  const p = running ?? (async () => {
    try {
      const v = await getBambuAmsSlots(host, accessCode, serial);
      bambuSlotsCache.set(k, { at: Date.now(), value: v });
      return v;
    } catch {
      return hit?.value ?? [];
    } finally {
      bambuSlotsInflight.delete(k);
    }
  })();
  if (!running) bambuSlotsInflight.set(k, p);
  // AMS okuması taze rapor beklerken saniyeler sürebiliyor — elde değer varsa paneli bekletme.
  if (hit) { void p.catch(() => {}); return hit.value; }
  return p;
}

// ── Moonraker dosya metası — dosya başına DEĞİŞMEZ, süresiz önbellek ─────────────────────────
// Panel (5sn) + relay (10sn) baskı boyunca aynı filename için aynı HTTP çağrısını tekrarlıyordu.
const metaCache = processSingleton("sc_metaCache", () => new Map<string, MoonrakerMeta>());
const metaInflight = processSingleton("sc_metaInflight", () => new Map<string, Promise<MoonrakerMeta | null>>());

export async function getMoonrakerMetaCached(host: string, port: number, filename: string): Promise<MoonrakerMeta | null> {
  const k = `${host}|${filename}`;
  const hit = metaCache.get(k);
  if (hit) return hit;
  // Meta taraması artık gcode'un ilk 256 KB'ını da çekiyor (küçük resim). Aynı dosya için
  // eşzamanlı iki istek bu indirmeyi İKİ KEZ yapmasın.
  const running = metaInflight.get(k);
  if (running) return running;
  const p = (async () => {
    try {
      const m = await fetchMoonrakerMeta(host, port, filename);
      if (m) {
        if (metaCache.size > 300) metaCache.clear(); // basit üst sınır — pratikte dolmaz
        metaCache.set(k, m);
      }
      return m; // null önbelleklenmez (metadata taraması gecikmiş olabilir → sonra tekrar dene)
    } finally {
      metaInflight.delete(k);
    }
  })();
  metaInflight.set(k, p);
  return p;
}

// ── Moonraker thumbnail → data-URL (mobil snapshot için) ────────────────────────────────────
// Snapshot'a yazıcının LAN IP'sine işaret eden URL yazılıyordu → telefon LAN dışındayken görsel
// KIRIK. Küçük thumbnail bir kez indirilip data-URL olarak gömülür (dosya başına önbellekli).
const thumbCache = processSingleton("sc_thumbCache", () => new Map<string, string>());

/**
 * Snapshot satırına gömülecek görselin ÜST SINIRI (bayt).
 * Uzak-HTTP libSQL'de her sorgu süreç genelinde sıralı; snapshot satırı baskı boyunca defalarca
 * yazılıyor. 300 KB'lık bir görseli her yazmada buluta göndermek saatte onlarca MB gereksiz
 * trafik ve gözle görülür kilit süresi demekti.
 */
export const SNAPSHOT_IMAGE_MAX_BYTES = 30_000;

export async function getMoonrakerThumbDataUrl(
  host: string, port: number, filename: string, relPath: string,
  maxBytes = SNAPSHOT_IMAGE_MAX_BYTES,
): Promise<string | null> {
  const k = `${host}|${filename}|${maxBytes}`;
  const hit = thumbCache.get(k);
  if (hit) return hit;
  try {
    const url = moonrakerThumbUrl(host, port, filename, relPath);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) return null; // büyük görseli Turso satırına gömme
      const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
      if (thumbCache.size > 100) thumbCache.clear();
      thumbCache.set(k, dataUrl);
      return dataUrl;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

// ── PrintFileProduct eşleştirmeleri — 30sn TTL (panelde her 5sn sınırsız findMany yerine) ─────
type MatchRow = { printerConfigId: string; filename: string; productId: string };
let matchesCache: { at: number; rows: MatchRow[] } | null = null;
const MATCHES_TTL_MS = 30_000;

export async function getPrintFileMatches(): Promise<MatchRow[]> {
  if (matchesCache && Date.now() - matchesCache.at < MATCHES_TTL_MS) return matchesCache.rows;
  const rows = await prisma.printFileProduct.findMany({
    select: { printerConfigId: true, filename: true, productId: true },
  });
  matchesCache = { at: Date.now(), rows };
  return rows;
}

/** Eşleştirme yazan herkes çağırır (match modalı / baskı başlatma) → panel yeni eşleşmeyi ANINDA görür. */
export function invalidatePrintFileMatches(): void {
  matchesCache = null;
  matchedProductsCache = null;
}

// ── Eşleşen ürünler (ad + görsel) — panelin İKİNCİ bulut sorgusu ────────────────────────────
// MADDE 20: panel 5sn'de bir hem eşleştirmeleri hem ürünleri sorguluyordu. Uzak-HTTP libSQL'de
// her sorgu ~96ms ve SIRALI → boşta duran panel bile dakikada 24 gereksiz bulut sorgusu üretiyordu.
type MatchedProduct = { id: string; name: string; imageUrl: string | null };
let matchedProductsCache: { at: number; rows: MatchedProduct[] } | null = null;

export async function getMatchedProducts(): Promise<Map<string, MatchedProduct>> {
  if (matchedProductsCache && Date.now() - matchedProductsCache.at < MATCHES_TTL_MS) {
    return new Map(matchedProductsCache.rows.map((p) => [p.id, p]));
  }
  const matches = await getPrintFileMatches();
  const pids = [...new Set(matches.map((m) => m.productId))];
  const rows = pids.length
    ? await prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, name: true, imageUrl: true } })
    : [];
  matchedProductsCache = { at: Date.now(), rows };
  return new Map(rows.map((p) => [p.id, p]));
}

// ── Yazıcı yapılandırmaları — 15sn TTL ───────────────────────────────────────────────────────
// Panel her 5sn'de PrinterConfig tablosunu buluttan çekiyordu; bu satırlar neredeyse hiç değişmez.
export type CachedPrinterConfig = {
  id: string; name: string; brand: string; model: string | null; type: string;
  host: string; port: number; accessCode: string | null; serial: string | null;
  accent: string | null; enabled: boolean; sortOrder: number; createdAt: Date;
};
let configsCache: { at: number; rows: CachedPrinterConfig[] } | null = null;
const CONFIGS_TTL_MS = 15_000;

export async function getEnabledPrinterConfigs(): Promise<CachedPrinterConfig[]> {
  if (configsCache && Date.now() - configsCache.at < CONFIGS_TTL_MS) return configsCache.rows;
  const rows = (await prisma.printerConfig.findMany({
    where: { enabled: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  })) as unknown as CachedPrinterConfig[];
  configsCache = { at: Date.now(), rows };
  return rows;
}

/** Yazıcı ekleme/düzenleme/silme sonrası çağrılmalı — panel yeni yapılandırmayı ANINDA görür. */
export function invalidatePrinterConfigs(): void {
  configsCache = null;
}

// ── Ürün+yazıcı → model dosyası (slicer önizlemesi için) ────────────────────────────────────
/**
 * Kartta gösterilecek model görseli, slicer'ın dosyaya GÖMDÜĞÜ render'dan geliyor
 * (bkz. `lib/slicer-preview.ts`). Moonraker yazıcılarda görsel doğrudan yazıcıdan alınabiliyor
 * ama Bambu'da ve bazı Moonraker kurulumlarında alınamıyor; o zaman KENDİ kütüphanemizdeki
 * dosyadan çıkarılır. Bu harita "hangi ürünün hangi yazıcıya ait dosyası" sorusunu cevaplar.
 *
 * Önbellekli: panel 5 saniyede bir yenileniyor ve uzak-HTTP libSQL'de her sorgu ~96ms + SIRALI.
 */
type ModelFileRow = { id: string; productId: string; printerConfigId: string | null; originalName: string };
let modelFilesCache: { at: number; rows: ModelFileRow[] } | null = null;

/**
 * ⚠️ ÜRÜNE GÖRE SEÇMEK YETMEZ. Bir ürünün aynı yazıcıda birden çok parçası olabiliyor
 * ("gövde", "kapak", …). Önceki sürüm ürünün İLK dosyasını alıyordu; çok parçalı üründe
 * hangi parça basılırsa basılsın kartta hep aynı resim görünüyordu (sahada görüldü:
 * Bambu / "All versions ams Mercedes"). Doğru eşleşme BASILAN DOSYA ADIYLA kurulur.
 */
export interface OnizlemeDosyalari {
  /** `yazıcıId::dosyaAnahtarı` → model dosyası kimliği. Doğru parçayı bu verir. */
  dosyaya: Map<string, string>;
  /**
   * `ürünId|yazıcıId` → tek dosya kimliği. YALNIZ o ürün+yazıcı için TEK dosya varsa dolu;
   * çok parçalıysa boş bırakılır — yanlış parçayı göstermektense hiç göstermemek doğru.
   */
  urune: Map<string, string>;
}

export async function getModelFilesForPreview(): Promise<OnizlemeDosyalari> {
  if (!modelFilesCache || Date.now() - modelFilesCache.at >= MATCHES_TTL_MS) {
    const rows = await prisma.productModelFile.findMany({
      select: { id: true, productId: true, printerConfigId: true, originalName: true },
    });
    modelFilesCache = { at: Date.now(), rows };
  }

  const dosyaya = new Map<string, string>();
  const sayac = new Map<string, { id: string; adet: number }>();
  for (const r of modelFilesCache.rows) {
    if (!r.printerConfigId) continue;
    if (r.originalName) {
      // İki anahtar da yazılır: Bambu dosyaları `Parça.gcode.3mf` adlanıyor ve yazıcı bazen
      // tek bazen çift uzantıyla bildiriyor.
      for (const k of [fileMatchKey(r.originalName), deepFileMatchKey(r.originalName)]) {
        const anahtar = `${r.printerConfigId}::${k}`;
        if (!dosyaya.has(anahtar)) dosyaya.set(anahtar, r.id);
      }
    }
    const urunAnahtar = `${r.productId}|${r.printerConfigId}`;
    const mevcut = sayac.get(urunAnahtar);
    if (mevcut) mevcut.adet++;
    else sayac.set(urunAnahtar, { id: r.id, adet: 1 });
  }

  const urune = new Map<string, string>();
  for (const [anahtar, v] of sayac) if (v.adet === 1) urune.set(anahtar, v.id);
  return { dosyaya, urune };
}
