import { describe, expect, it } from "vitest";
import { computePackagingCost, parsePackagingSettings } from "./packaging";

const SETTINGS = {
  packagingOptions: JSON.stringify([{ id: "box", name: "Kutu", price: 2 }]),
  nylonRollPrice: "100",
  nylonRollGrams: "100",
  nylonLowGrams: "3",
  tapePrice: "12",
  tapeProductsPerRoll: "6",
  cardQty: "10",
  cardPrice: "10",
  stickerQty: "20",
  stickerPrice: "20",
  sakizQty: "30",
  sakizPrice: "30",
};

describe("paketleme kapsamları", () => {
  it("eski ayarlarda varsayılan olarak dış paket gönderi, sabit ekler sipariş başına", () => {
    const settings = parsePackagingSettings({ ...SETTINGS });
    const result = computePackagingCost(
      { packagingOptionId: "box", nylonLevel: "low", tapeUsed: true },
      settings
    );

    expect(result.perUnit).toBe(0);
    expect(result.perOrder).toBe(3);
    expect(result.perShipment).toBe(7);
    expect(result.total).toBe(10);
  });

  it("kullanıcı kapsam seçimini packagingScopes ile değiştirebilir", () => {
    const settings = parsePackagingSettings({
      ...SETTINGS,
      packagingScopes: JSON.stringify({
        option: "per_shipment",
        nylon: "per_unit",
        tape: "per_shipment",
        card: "per_order",
        sticker: "per_order",
        sakiz: "per_order",
      }),
    });
    const result = computePackagingCost(
      { packagingOptionId: "box", nylonLevel: "low", tapeUsed: true },
      settings
    );

    expect(result.perUnit).toBe(3);
    expect(result.perOrder).toBe(3);
    expect(result.perShipment).toBe(4);
    expect(result.total).toBe(10);
  });

  it("bozuk scope JSON güvenli varsayılanlara döner", () => {
    const settings = parsePackagingSettings({
      ...SETTINGS,
      packagingScopes: "{bozuk",
    });
    expect(settings.scopes.option).toBe("per_shipment");
    expect(settings.scopes.card).toBe("per_order");
  });
});
