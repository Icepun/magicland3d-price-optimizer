/**
 * YAZICI AYRINTISI — masaüstü aktarıcısının `PrinterSnapshot.detail` kolonuna yazdığı, telefonun
 * yazıcı ekranında okuduğu JSON.
 *
 * NEDEN VAR: telefon yazıcıya doğrudan ulaşamıyor (LAN), gördüğü her şey aktarıcının yazdığı
 * satır. Satırda yalnız durum/yüzde/sıcaklık vardı; masaüstü kartındaki katman, başlangıç saati,
 * kafalar, yüklü filamentler ve uyarılar telefona hiç gitmiyordu.
 *
 * NEDEN TEK KOLON JSON: telefon bu alanları yalnız GÖSTERİYOR (sıralama/filtre yok). Her alan
 * için ayrı kolon, her eklemede şema sürümü + iki cihazda göç demek. JSON'a alan eklemek eski
 * telefonu bozmaz (tanımadığını yok sayar); eski masaüstü alanı hiç yazmaz (telefon "—" gösterir).
 *
 * ⚠️ PAYLAŞILIYOR: `npm run sync-core` ile telefona kopyalanır — yalnız saf TS, node API yok.
 */

export interface YaziciKafasi {
  /** 0 tabanlı kafa indeksi (T0 = 0). */
  index: number;
  temp: number;
  target: number;
  /** Baskıyı şu an bu kafa mı yapıyor. */
  active: boolean;
}

export interface YaziciSlotu {
  slot: number;
  /** "#RRGGBB" — bilinmiyorsa boş. */
  color: string;
  type: string;
  empty: boolean;
  /** Bu baskıda kullanılan slot mu. */
  active: boolean;
}

export type UyariSeviyesi = "fatal" | "serious" | "common" | "info";

export interface YaziciUyarisi {
  /** Üreticinin kodu (Bambu HMS "0700-8001-…") — destek aramasında işe yarar. */
  code: string | null;
  level: UyariSeviyesi;
  text: string;
}

export interface YaziciDetay {
  /** Biçim sürümü. Alanların ANLAMI değişirse artır; telefon tanımadığı sürümü okumaz. */
  v: 1;
  /** Yazıcı modeli ("A1 Combo", "U1") — ayarlardan. */
  model: string | null;
  layer: number | null;
  totalLayers: number | null;
  /** Baskının başladığı an (ms). DAKİKAYA yuvarlı — her turda kayıp yeni yazma üretmesin. */
  startedAt: number | null;
  nozzleTarget: number | null;
  bedTarget: number | null;
  /** YALNIZ çok kafalı yazıcıda (U1) dolu; tek kafalıda boş dizi. */
  heads: YaziciKafasi[];
  /** Okunur hız: "Standart", "%120". Bilinmiyorsa null. */
  speed: string | null;
  filamentType: string | null;
  /** Dilimleyicinin bildirdiği toplam filament (gram) — yalnız gösterim. */
  filamentGrams: number | null;
  slots: YaziciSlotu[];
  warnings: YaziciUyarisi[];
  /** Şu an basılan nesne (dilimleyici nesneleri işaretlediyse). */
  currentObject: string | null;
}

export const BOS_DETAY: YaziciDetay = {
  v: 1,
  model: null,
  layer: null,
  totalLayers: null,
  startedAt: null,
  nozzleTarget: null,
  bedTarget: null,
  heads: [],
  speed: null,
  filamentType: null,
  filamentGrams: null,
  slots: [],
  warnings: [],
  currentObject: null,
};

const DAKIKA_MS = 60_000;

/** Başlangıç anını dakikaya yuvarla — saniyelik oynama satırı her turda "değişti" saydırmasın. */
export function dakikayaYuvarla(ms: number | null | undefined): number | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.round(ms / DAKIKA_MS) * DAKIKA_MS;
}

/**
 * Güncel katman — yazıcı söylüyorsa o; söylemiyorsa Z yüksekliğinden tahmin (Fluidd ile aynı:
 * floor((z − ilk katman) / katman yüksekliği) + 1). Masaüstü paneli ve telefon aynı sayıyı
 * göstersin diye tek yerde.
 */
export function katmanTahmini(g: {
  current: number | null | undefined;
  zHeight: number | null | undefined;
  layerHeight: number | null | undefined;
  firstLayerHeight: number | null | undefined;
  total: number | null | undefined;
}): number | null {
  if (g.current != null && g.current > 0) return g.current;
  if (g.zHeight == null || !g.layerHeight || g.layerHeight <= 0) return g.current ?? null;
  const ilk = g.firstLayerHeight ?? g.layerHeight;
  const tahmin = Math.floor((g.zHeight - ilk) / g.layerHeight + 1e-4) + 1;
  const toplam = g.total ?? 0;
  return toplam > 0 ? Math.max(1, Math.min(tahmin, toplam)) : Math.max(1, tahmin);
}

const SEVIYELER: readonly UyariSeviyesi[] = ["fatal", "serious", "common", "info"];

function sayi(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function metin(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/**
 * Kolondaki JSON'u oku — bozuk, boş ya da tanınmayan sürüm → null (ekran "—" gösterir).
 * Her alan tek tek doğrulanır: yarım yazılmış ya da elle bozulmuş satır ekranı çökertmemeli.
 */
export function yaziciDetayOku(json: string | null | undefined): YaziciDetay | null {
  if (!json) return null;
  let ham: unknown;
  try {
    ham = JSON.parse(json);
  } catch {
    return null;
  }
  if (!ham || typeof ham !== "object") return null;
  const d = ham as Record<string, unknown>;
  if (d.v !== 1) return null;
  const dizi = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
  return {
    v: 1,
    model: metin(d.model),
    layer: sayi(d.layer),
    totalLayers: sayi(d.totalLayers),
    startedAt: sayi(d.startedAt),
    nozzleTarget: sayi(d.nozzleTarget),
    bedTarget: sayi(d.bedTarget),
    heads: dizi(d.heads).map((h, i) => ({
      index: sayi(h.index) ?? i,
      temp: sayi(h.temp) ?? 0,
      target: sayi(h.target) ?? 0,
      active: h.active === true,
    })),
    speed: metin(d.speed),
    filamentType: metin(d.filamentType),
    filamentGrams: sayi(d.filamentGrams),
    slots: dizi(d.slots).map((s, i) => ({
      slot: sayi(s.slot) ?? i,
      color: typeof s.color === "string" ? s.color : "",
      type: typeof s.type === "string" ? s.type : "",
      empty: s.empty === true,
      active: s.active === true,
    })),
    warnings: dizi(d.warnings)
      .filter((w) => typeof w.text === "string" && w.text.trim())
      .map((w) => ({
        code: metin(w.code),
        level: SEVIYELER.includes(w.level as UyariSeviyesi) ? (w.level as UyariSeviyesi) : "common",
        text: String(w.text),
      })),
    currentObject: metin(d.currentObject),
  };
}
