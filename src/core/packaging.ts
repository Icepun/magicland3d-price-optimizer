/**
 * Paketleme & sabit ek maliyet sistemi.
 *
 * Tüm fiyatlar Maliyet Ayarları'nda (AppSetting key-value) tutulur. Ürün sadece
 * SEÇİM saklar (hangi poşet, naylon seviyesi, bant var/yok). Maliyet her hesapta
 * güncel ayarlardan üretilir — böylece zam yapılınca tüm ürünler otomatik güncellenir.
 *
 * Kart / Sticker / Sakız → her ürüne sabit eklenir (seçim yok).
 */

export interface PackagingOption {
  id: string;
  name: string;
  price: number;
}

export interface PackagingSettings {
  options: PackagingOption[];
  nylonRollPrice: number;
  nylonRollGrams: number;
  nylonLowGrams: number;
  nylonMediumGrams: number;
  nylonHighGrams: number;
  tapePrice: number;
  tapeProductsPerRoll: number;
  cardQty: number;
  cardPrice: number;
  stickerQty: number;
  stickerPrice: number;
  sakizQty: number;
  sakizPrice: number;
  scopes: PackagingScopes;
}

export type NylonLevel = "none" | "low" | "medium" | "high";
export type PackagingScope = "per_unit" | "per_order" | "per_shipment";
export type PackagingComponentKey =
  | "option"
  | "nylon"
  | "tape"
  | "card"
  | "sticker"
  | "sakiz";
export type PackagingScopes = Record<PackagingComponentKey, PackagingScope>;

export const DEFAULT_PACKAGING_SCOPES: PackagingScopes = {
  option: "per_shipment",
  nylon: "per_shipment",
  tape: "per_shipment",
  card: "per_order",
  sticker: "per_order",
  sakiz: "per_order",
};

export interface PackagingSelection {
  packagingOptionId?: string | null;
  nylonLevel?: string | null;
  tapeUsed?: boolean | null;
}

export interface PackagingBreakdown {
  poset: number;
  nylon: number;
  tape: number;
  card: number;
  sticker: number;
  sakiz: number;
  perUnit: number;
  perOrder: number;
  perShipment: number;
  components: {
    key: PackagingComponentKey;
    scope: PackagingScope;
    cost: number;
  }[];
  total: number;
}

export const DEFAULT_PACKAGING_OPTIONS: PackagingOption[] = [
  { id: "poset-kucuk", name: "Küçük kargo poşeti", price: 0 },
  { id: "poset-buyuk", name: "Büyük kargo poşeti", price: 0 },
  { id: "kutu-kucuk", name: "Kutu (Küçük)", price: 0 },
  { id: "kutu-orta", name: "Kutu (Orta)", price: 0 },
  { id: "kutu-buyuk", name: "Kutu (Büyük)", price: 0 },
];

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * AppSetting key-value map'inden paketleme ayarlarını parse eder.
 *
 * MEMO: settings nesnesi kimliği değişmedikçe aynı sonuç döner. resolveProductCost her ürün için
 * bunu çağırır → 400+ ürünlük toplu kâr hesabında JSON.parse ürün başına tekrarlanıyordu
 * (mobilde tek geçişte 400+ parse). Aynı settings referansı = tek parse.
 */
let memoSettings: Record<string, string | undefined> | null = null;
let memoResult: PackagingSettings | null = null;

export function parsePackagingSettings(
  settings: Record<string, string | undefined>
): PackagingSettings {
  if (memoSettings === settings && memoResult) return memoResult;
  const result = parsePackagingSettingsUncached(settings);
  memoSettings = settings;
  memoResult = result;
  return result;
}

function parsePackagingSettingsUncached(
  settings: Record<string, string | undefined>
): PackagingSettings {
  let options: PackagingOption[] = DEFAULT_PACKAGING_OPTIONS;
  if (settings.packagingOptions) {
    try {
      const parsed = JSON.parse(settings.packagingOptions);
      if (Array.isArray(parsed)) {
        options = parsed
          .filter((o) => o && typeof o.id === "string" && typeof o.name === "string")
          .map((o) => ({ id: o.id, name: o.name, price: num(o.price) }));
      }
    } catch {
      /* bozuk JSON → default */
    }
  }

  let scopes = DEFAULT_PACKAGING_SCOPES;
  if (settings.packagingScopes) {
    try {
      const parsed = JSON.parse(settings.packagingScopes) as Partial<PackagingScopes>;
      const valid = (value: unknown): value is PackagingScope =>
        value === "per_unit" || value === "per_order" || value === "per_shipment";
      scopes = {
        option: valid(parsed.option) ? parsed.option : DEFAULT_PACKAGING_SCOPES.option,
        nylon: valid(parsed.nylon) ? parsed.nylon : DEFAULT_PACKAGING_SCOPES.nylon,
        tape: valid(parsed.tape) ? parsed.tape : DEFAULT_PACKAGING_SCOPES.tape,
        card: valid(parsed.card) ? parsed.card : DEFAULT_PACKAGING_SCOPES.card,
        sticker: valid(parsed.sticker) ? parsed.sticker : DEFAULT_PACKAGING_SCOPES.sticker,
        sakiz: valid(parsed.sakiz) ? parsed.sakiz : DEFAULT_PACKAGING_SCOPES.sakiz,
      };
    } catch {
      /* bozuk JSON → varsayılan kapsamlar */
    }
  }

  return {
    options,
    nylonRollPrice: num(settings.nylonRollPrice),
    nylonRollGrams: num(settings.nylonRollGrams),
    nylonLowGrams: num(settings.nylonLowGrams, 10),
    nylonMediumGrams: num(settings.nylonMediumGrams, 20),
    nylonHighGrams: num(settings.nylonHighGrams, 30),
    tapePrice: num(settings.tapePrice),
    tapeProductsPerRoll: num(settings.tapeProductsPerRoll, 20),
    cardQty: num(settings.cardQty),
    cardPrice: num(settings.cardPrice),
    stickerQty: num(settings.stickerQty),
    stickerPrice: num(settings.stickerPrice),
    sakizQty: num(settings.sakizQty),
    sakizPrice: num(settings.sakizPrice),
    scopes,
  };
}

function nylonGramsForLevel(level: string | null | undefined, s: PackagingSettings): number {
  switch (level) {
    case "low":
      return s.nylonLowGrams;
    case "medium":
      return s.nylonMediumGrams;
    case "high":
      return s.nylonHighGrams;
    default:
      return 0;
  }
}

/** qty>0 ise birim başına maliyet, değilse 0 */
function perUnit(price: number, qty: number): number {
  return qty > 0 ? price / qty : 0;
}

/**
 * Bir ürünün paketleme maliyetini, seçimi + güncel ayarlardan hesaplar.
 * Kart/Sticker/Sakız her zaman eklenir (sabit ek maliyet).
 */
export function computePackagingCost(
  selection: PackagingSelection,
  s: PackagingSettings
): PackagingBreakdown {
  const poset =
    s.options.find((o) => o.id === selection.packagingOptionId)?.price ?? 0;

  const nylonGrams = nylonGramsForLevel(selection.nylonLevel, s);
  const nylonPerGram = s.nylonRollGrams > 0 ? s.nylonRollPrice / s.nylonRollGrams : 0;
  const nylon = nylonGrams * nylonPerGram;

  const tape = selection.tapeUsed
    ? perUnit(s.tapePrice, s.tapeProductsPerRoll)
    : 0;

  // Sabit ek maliyetler — her üründe
  const card = perUnit(s.cardPrice, s.cardQty);
  const sticker = perUnit(s.stickerPrice, s.stickerQty);
  const sakiz = perUnit(s.sakizPrice, s.sakizQty);

  const components: PackagingBreakdown["components"] = [
    { key: "option", scope: s.scopes.option, cost: poset },
    { key: "nylon", scope: s.scopes.nylon, cost: nylon },
    { key: "tape", scope: s.scopes.tape, cost: tape },
    { key: "card", scope: s.scopes.card, cost: card },
    { key: "sticker", scope: s.scopes.sticker, cost: sticker },
    { key: "sakiz", scope: s.scopes.sakiz, cost: sakiz },
  ];
  const sumScope = (scope: PackagingScope) =>
    components.reduce((sum, item) => sum + (item.scope === scope ? item.cost : 0), 0);
  const perUnitTotal = sumScope("per_unit");
  const perOrderTotal = sumScope("per_order");
  const perShipmentTotal = sumScope("per_shipment");
  const total = perUnitTotal + perOrderTotal + perShipmentTotal;
  return {
    poset,
    nylon,
    tape,
    card,
    sticker,
    sakiz,
    perUnit: perUnitTotal,
    perOrder: perOrderTotal,
    perShipment: perShipmentTotal,
    components,
    total,
  };
}
