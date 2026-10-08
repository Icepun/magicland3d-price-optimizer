import { describe, expect, it } from "vitest";

import { zararGruplari } from "./panel-gruplama";

const satir = (id: string, name: string, profit: number | null, platform: string | null = "trendyol") => ({
  id,
  name,
  platform,
  salePrice: 74.99,
  profit,
  margin: profit == null ? null : profit / 74.99,
});

describe("Panel: aynı ürünün renkleri tek satır", () => {
  it("aynı platform + aynı taban ad birleşir, kâr aralığı en kötü..en iyi", () => {
    const g = zararGruplari([
      satir("1", "Balerin Takı Standı — Mavi-Yeşil", -43.98),
      satir("2", "Balerin Takı Standı — Bakır", -31.69),
      satir("3", "Balerin Takı Standı — Mor", -29.85),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].ad).toBe("Balerin Takı Standı");
    expect(g[0].satirlar).toHaveLength(3);
    expect(g[0].karAralik).toEqual([-43.98, -29.85]);
  });

  it("farklı platformdaki aynı ürün ayrı kalır", () => {
    const g = zararGruplari([
      satir("1", "Balerin Takı Standı — Mor", -29.85, "trendyol"),
      satir("2", "Balerin Takı Standı — Mor", -12, "hepsiburada"),
    ]);
    expect(g).toHaveLength(2);
  });

  it("varyantsız ad tek satır kalır ve tam adıyla görünür; sıra korunur", () => {
    const g = zararGruplari([
      satir("9", "Black Panther Kulaklık Standı", -22.18, "hepsiburada"),
      satir("1", "Balerin Takı Standı — Mor", -29.85),
      satir("2", "Balerin Takı Standı — Altın", -31.69),
    ]);
    expect(g.map((x) => x.ad)).toEqual(["Black Panther Kulaklık Standı", "Balerin Takı Standı"]);
  });

  it("kârı bilinmeyen satır aralığı bozmaz", () => {
    const g = zararGruplari([satir("1", "A — x", null), satir("2", "A — y", -5)]);
    expect(g[0].karAralik).toEqual([-5, -5]);
  });
});
