import { computeFullProductCost } from "@/core/cost-calculator";
import { computePackagingCost, parsePackagingSettings } from "@/core/packaging";
import {
  ekFilamentMaliyeti,
  ekFilamentleriOku,
  ekFilamentleriYaz,
  type FilamentFiyatlari,
} from "@/core/filament-karisimi";

/**
 * Detaylı maliyet kaydının ÖNBELLEK kolonları (materialCost, totalCost…) — ürün kaydı ve
 * "tüm varyantlara uygula" AYNI hesabı kullanır (eskiden iki kopya vardı).
 *
 * Asıl hesap her okumada `resolveProductCost` ile güncel fiyatlardan yeniden yapılır; bu kolonlar
 * yalnız kayıt anının dökümüdür. Ek filamentler (çoklu filament) malzeme payına dahildir.
 */
export function detayliMaliyetOnbellegi(
  cost: {
    filamentTypeId?: string | null;
    filamentWeight?: number | null;
    ekFilamentlerJson?: string | null;
    printTimeHours?: number | null;
    wasteRate?: number | null;
    packagingOptionId?: string | null;
    nylonLevel?: string | null;
    tapeUsed?: boolean | null;
  },
  settings: Record<string, string | undefined>,
  fiyatlar: FilamentFiyatlari
) {
  const electricityCostPerHour =
    settings.costElectricityIncluded === "true" ? parseFloat(settings.costElectricityPerHour || "0") : 0;
  const packaging = computePackagingCost(
    { packagingOptionId: cost.packagingOptionId, nylonLevel: cost.nylonLevel, tapeUsed: cost.tapeUsed },
    parsePackagingSettings(settings)
  );
  const ek = ekFilamentMaliyeti(ekFilamentleriOku(cost.ekFilamentlerJson), fiyatlar);
  const calc = computeFullProductCost({
    filamentWeight: cost.filamentWeight ?? 0,
    costPerGram: (cost.filamentTypeId ? fiyatlar.get(cost.filamentTypeId) : undefined) ?? 0,
    printTimeHours: cost.printTimeHours ?? 0,
    electricityCostPerHour,
    machineWearCostPerHour: parseFloat(settings.costMachineWearPerHour || "0"),
    laborCostPerHour: parseFloat(settings.costLaborPerHour || "0"),
    wasteRate: cost.wasteRate ?? 0,
    packagingCost: packaging.total,
    ekFilamentMaliyeti: ek.tutar,
  });
  return {
    materialCost: calc.filamentCost,
    electricityCost: calc.electricityCost,
    machineWearCost: calc.machineWearCost,
    laborCost: calc.laborCost,
    packagingCost: calc.packagingCost,
    otherCost: calc.wasteCost,
    totalCost: calc.totalCost,
  };
}

/**
 * İstek gövdesindeki maliyet nesnesini veritabanı kolonlarına indir: `ekFilamentler` dizisi
 * `ekFilamentlerJson` metnine çevrilir (verilmediyse dokunulmaz → mevcut ekler korunur).
 */
export function maliyetGovdesiniKolonlaraCevir<T extends { ekFilamentler?: unknown }>(
  cost: T
): Omit<T, "ekFilamentler"> & { ekFilamentlerJson?: string | null } {
  const { ekFilamentler, ...kalan } = cost;
  return ekFilamentler === undefined ? kalan : { ...kalan, ekFilamentlerJson: ekFilamentleriYaz(ekFilamentler) };
}
