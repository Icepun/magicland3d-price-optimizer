import { computeFullProductCost } from "./cost-calculator";
import { computePackagingCost, parsePackagingSettings } from "./packaging";

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
      electricityCostPerHour: Number(settings.costElectricityPerHour ?? 0),
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
    };
  }

  // manual / template
  const total = cost.totalCost ?? cost.manualCost ?? 0;
  return { productionCost: total, packagingCost: 0, totalCost: total, filamentCost: 0 };
}
