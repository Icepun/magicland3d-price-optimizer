import { computeFullProductCost } from "./cost-calculator";
import {
  computePackagingCost,
  parsePackagingSettings,
  type PackagingBreakdown,
} from "./packaging";

/**
 * Bir ürünün maliyetini, kayıtlı SEÇİMLER + GÜNCEL ayarlardan yeniden hesaplar.
 *
 * Kritik: paketleme/naylon/bant/kart fiyatları Maliyet Ayarları'ndan dinamik
 * çekilir. Böylece zam yapılınca cached değere bakmadan tüm ürünler güncel kalır.
 *
 * detailed mod → tam hesap. manual/template → cached totalCost/manualCost.
 */
export interface ResolvableProductCost {
  costMode: string;
  manualCost: number | null;
  totalCost: number | null;
  packagingCost?: number | null;
  filamentWeight: number | null;
  printTimeHours: number | null;
  wasteRate: number | null;
  packagingOptionId: string | null;
  nylonLevel: string | null;
  tapeUsed: boolean | null;
}

export interface ResolvedCost {
  productionCost: number;
  packagingCost: number;
  totalCost: number;
  /** Üretim maliyeti içindeki filament malzeme payı (KDV iadesi hesabı için). manual/template → 0. */
  filamentCost: number;
  /** Çok adetli siparişlerde kapsamı doğru uygulamak için bileşen dökümü. */
  packagingBreakdown: PackagingBreakdown | null;
  /**
   * "Bu ürünün ÜRETİM maliyeti gerçekten girilmiş mi?"
   *
   * ⚠️ `totalCost > 0` bu soruyu YANITLAMAZ: paketleme ayarlarındaki kart/sticker/sakız her ürüne
   * koşulsuz eklenir (packaging.ts), dolayısıyla `totalCost` fiilen HİÇBİR zaman 0 olmaz. Filament
   * gramajı/süresi hiç girilmemiş bir ürün bu yüzden "maliyeti tam" sayılıp şişik kâr gösteriyordu.
   * Maliyet bilinirliğine bakan HER yeni kod yolu totalCost'a değil BUNA bakmalı.
   */
  productionCostKnown: boolean;
}

/** simulatePrice çağrılarında paketleme kapsamlarını tek biçimde taşır. */
export function packagingScopeInput(cost: ResolvedCost | null | undefined) {
  const breakdown = cost?.packagingBreakdown;
  if (!breakdown) return {};
  return {
    packagingUnitCost: breakdown.perUnit,
    packagingOrderCost: breakdown.perOrder,
    packagingShipmentCost: breakdown.perShipment,
  };
}

function manualPackagingBreakdown(
  amount: number,
  settings: Record<string, string | undefined>
): PackagingBreakdown {
  const scope = parsePackagingSettings(settings).scopes.option;
  return {
    poset: amount,
    nylon: 0,
    tape: 0,
    card: 0,
    sticker: 0,
    sakiz: 0,
    perUnit: scope === "per_unit" ? amount : 0,
    perOrder: scope === "per_order" ? amount : 0,
    perShipment: scope === "per_shipment" ? amount : 0,
    components: [{ key: "option", scope, cost: amount }],
    total: amount,
  };
}

export function resolveProductCost(
  cost: ResolvableProductCost | null | undefined,
  settings: Record<string, string | undefined>,
  filamentCostPerGram: number
): ResolvedCost | null {
  if (!cost) return null;

  if (cost.costMode === "detailed") {
    const packagingSettings = parsePackagingSettings(settings);
    const packaging = computePackagingCost(
      {
        packagingOptionId: cost.packagingOptionId,
        nylonLevel: cost.nylonLevel,
        tapeUsed: cost.tapeUsed,
      },
      packagingSettings
    );
    const calc = computeFullProductCost({
      filamentWeight: cost.filamentWeight ?? 0,
      costPerGram: filamentCostPerGram,
      printTimeHours: cost.printTimeHours ?? 0,
      electricityCostPerHour:
        settings.costElectricityIncluded === "true"
          ? Number(settings.costElectricityPerHour ?? 0)
          : 0,
      machineWearCostPerHour: Number(settings.costMachineWearPerHour ?? 0),
      laborCostPerHour: Number(settings.costLaborPerHour ?? 0),
      wasteRate: cost.wasteRate ?? 0,
      packagingCost: packaging.total,
    });
    return {
      productionCost: calc.productionCost,
      packagingCost: calc.packagingCost,
      totalCost: calc.totalCost,
      filamentCost: calc.filamentCost,
      packagingBreakdown: packaging,
      // Paketleme HARİÇ üretim payı: filament gramajı/süresi girilmemişse 0 kalır → bilinmiyor.
      productionCostKnown: calc.productionCost > 0,
    };
  }

  // manual / template. CSV ve hızlı ürün ekleme akışında ürün + ambalaj ayrı kaydedilir;
  // totalCost bu ikisinin toplamına eşitse kapsamı kaybetmeden ayrı tut.
  const manual = cost.manualCost ?? 0;
  const cachedPackaging = Math.max(0, cost.packagingCost ?? 0);
  const cachedTotal = cost.totalCost;
  const hasSeparatedPackaging =
    cachedTotal != null &&
    cost.manualCost != null &&
    cachedPackaging > 0 &&
    Math.abs(cachedTotal - (manual + cachedPackaging)) < 0.005;
  if (hasSeparatedPackaging) {
    return {
      productionCost: manual,
      packagingCost: cachedPackaging,
      totalCost: manual + cachedPackaging,
      filamentCost: 0,
      packagingBreakdown: manualPackagingBreakdown(cachedPackaging, settings),
      productionCostKnown: manual > 0,
    };
  }

  // Ayrıştırılmamış tek tutar: paketleme ayrı değil, girilen rakamın kendisi ürünün maliyeti.
  const total = cachedTotal ?? cost.manualCost ?? 0;
  return {
    productionCost: total,
    packagingCost: 0,
    totalCost: total,
    filamentCost: 0,
    packagingBreakdown: null,
    productionCostKnown: total > 0,
  };
}
