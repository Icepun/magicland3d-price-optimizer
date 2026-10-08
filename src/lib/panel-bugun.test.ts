import { describe, expect, it } from "vitest";

import { YAZICI_BAYAT_MS, gonderilecekSayisi, yaziciOzeti } from "./panel-bugun";

const SIMDI = 1_791_500_000_000;
const y = (name: string, status: string, online = true, yasMs = 5_000) => ({
  name,
  status,
  online,
  updatedAtMs: SIMDI - yasMs,
});

describe("Panel 'Bugün': yazıcılar", () => {
  it("boşta, sorunlu ve basan ayrılır", () => {
    const o = yaziciOzeti(
      [y("A1", "idle"), y("A2L", "finished"), y("U1 Alt", "paused"), y("U1 Üst", "printing")],
      SIMDI
    );
    expect(o).toEqual({ bosta: ["A1", "A2L"], sorunlu: ["U1 Alt"], basiyor: 1, bilinmiyor: 0 });
  });

  it("bayat satır hakkında hüküm verilmez (relay kapalıyken 'boşta' denmez)", () => {
    const o = yaziciOzeti([y("A1", "idle", true, YAZICI_BAYAT_MS + 1)], SIMDI);
    expect(o.bosta).toEqual([]);
    expect(o.bilinmiyor).toBe(1);
  });

  it("çevrimdışı yazıcı boşta sayılmaz", () => {
    expect(yaziciOzeti([y("A1", "idle", false)], SIMDI).bosta).toEqual([]);
  });
});

describe("Panel 'Bugün': gönderilecek siparişler", () => {
  it("Siparişler sayfasıyla aynı kural (bekleyen + hazırlanıyor)", () => {
    expect(
      gonderilecekSayisi([
        { statusKind: "pending" },
        { statusKind: "processing" },
        { statusKind: "shipped" },
        { statusKind: "delivered" },
        { statusKind: "cancelled" },
      ])
    ).toBe(2);
  });
});
