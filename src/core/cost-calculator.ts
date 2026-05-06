import type { ProductCostInput } from "./types";

export function calculateTemplateCost(input: ProductCostInput): number {
  const {
    materialWeight = 0,
    printTimeHours = 0,
    materialCostPerGram = 0,
    electricityCostPerHour = 0,
    machineWearCostPerHour = 0,
    packagingCost = 0,
    laborCost = 0,
    otherCost = 0,
    wasteRate = 0,
  } = input;

  const material = materialWeight * materialCostPerGram;
  const electricity = printTimeHours * electricityCostPerHour;
  const machineWear = printTimeHours * machineWearCostPerHour;
  const subtotal = material + electricity + machineWear + packagingCost + laborCost + otherCost;
  const waste = subtotal * wasteRate;

  return subtotal + waste;
}

export interface DetailedCostInput {
  filamentWeight: number;
  costPerGram: number;
  printTimeHours: number;
  electricityCostPerHour: number;
  machineWearCostPerHour: number;
  laborCostPerHour: number;
  packagingPoset: number;
  packagingNaylon: number;
  packagingBant: number;
  packagingKart: number;
  wasteRate: number;
}

export function calculateDetailedCost(input: DetailedCostInput) {
  const filamentCost = input.filamentWeight * input.costPerGram;
  const electricityCost = input.printTimeHours * input.electricityCostPerHour;
  const machineWearCost = input.printTimeHours * input.machineWearCostPerHour;
  const laborCost = input.printTimeHours * input.laborCostPerHour;
  const packagingCost =
    input.packagingPoset +
    input.packagingNaylon +
    input.packagingBant +
    input.packagingKart;

  const subtotal =
    filamentCost + electricityCost + machineWearCost + laborCost + packagingCost;
  const wasteCost = subtotal * input.wasteRate;
  const totalCost = subtotal + wasteCost;

  return {
    filamentCost,
    electricityCost,
    machineWearCost,
    laborCost,
    packagingCost,
    subtotal,
    wasteCost,
    totalCost,
  };
}
