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
