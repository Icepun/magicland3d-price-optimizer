import { describe, expect, it } from "vitest";
import { fazlaDesiBul } from "./kargo-denetim";

describe("fazla desi", () => {
  it("kesilen desi büyük ve kargo pahalandıysa fazlayı verir (HB 1 → 4 desi: 129,59 − 98,39)", () => {
    expect(fazlaDesiBul({ kesilenDesi: 4, bizimDesi: 1, gercekKargo: 129.59, tahminiKargo: 98.39 })).toEqual({
      bizimDesi: 1,
      kesilenDesi: 4,
      fazla: 31.2,
    });
  });

  it("barem siparişinde desi fiyatı değiştirmez → yok sayılır", () => {
    expect(fazlaDesiBul({ kesilenDesi: 4, bizimDesi: 1, gercekKargo: 94.49, tahminiKargo: 94.49 })).toBeNull();
  });

  it("kesilen desi bizimkinden büyük değilse ya da bilgi eksikse null", () => {
    expect(fazlaDesiBul({ kesilenDesi: 1, bizimDesi: 2, gercekKargo: 130, tahminiKargo: 98 })).toBeNull();
    expect(fazlaDesiBul({ kesilenDesi: null, bizimDesi: 1, gercekKargo: 130, tahminiKargo: 98 })).toBeNull();
    expect(fazlaDesiBul({ kesilenDesi: 4, bizimDesi: 1, gercekKargo: null, tahminiKargo: 98 })).toBeNull();
  });

  it("1 TL altı fark itiraza değmez", () => {
    expect(fazlaDesiBul({ kesilenDesi: 3, bizimDesi: 2, gercekKargo: 98.9, tahminiKargo: 98.39 })).toBeNull();
  });
});
