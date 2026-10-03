import { describe, expect, it } from "vitest";

import {
  TRENDYOL_TALEP_SAYFA_BOYU,
  TRENDYOL_TALEP_SAYFA_TAVANI,
  trendyolIadeDurumu,
  trendyolIadeleri,
  trendyolTalepleriniTopla,
  type TrendyolIadeTalebi,
} from "./trendyol-iade";

/** Canlı yanıtın biçimi (4 Eki 2026): her talep kalemi BİR adet. */
function talep(
  paket: number | null,
  satirlar: Array<{ satir: number; durumlar: string[] }>,
  onEk = "k"
): TrendyolIadeTalebi {
  return {
    orderNumber: "11401378050",
    orderOutboundPackageId: paket,
    items: satirlar.map(({ satir, durumlar }) => ({
      orderLine: { id: satir },
      claimItems: durumlar.map((name, i) => ({ id: `${onEk}-${satir}-${i}`, claimItemStatus: { name } })),
    })),
  };
}

describe("trendyolIadeleri", () => {
  it("anahtar ASIL gönderi paketi: ty-<orderOutboundPackageId>", () => {
    const sonuc = trendyolIadeleri([talep(3989713907, [{ satir: 1, durumlar: ["Accepted", "Accepted"] }])]);
    expect([...sonuc.entries()]).toEqual([["ty-3989713907", { kabulAdet: 2, satirSayisi: 1 }]]);
  });

  it("yalnız kabul edilen kalemler sayılır (iptal edilmiş / bekleyen talep iade değildir)", () => {
    const sonuc = trendyolIadeleri([
      talep(1, [{ satir: 1, durumlar: ["Cancelled"] }], "a"),
      talep(1, [{ satir: 1, durumlar: ["Created"] }], "b"),
      talep(2, [{ satir: 5, durumlar: ["Rejected", "WaitingInAction"] }]),
    ]);
    expect(sonuc.size).toBe(0);
  });

  it("aynı talep iki sayfada gelirse bir kez sayılır", () => {
    const t = talep(7, [{ satir: 1, durumlar: ["Accepted"] }]);
    expect(trendyolIadeleri([t, t]).get("ty-7")).toEqual({ kabulAdet: 1, satirSayisi: 1 });
  });

  it("paketi belli olmayan talep hiçbir siparişe yazılmaz", () => {
    expect(trendyolIadeleri([talep(null, [{ satir: 1, durumlar: ["Accepted"] }])]).size).toBe(0);
    expect(trendyolIadeleri([talep(0, [{ satir: 1, durumlar: ["Accepted"] }])]).size).toBe(0);
  });

  it("bozuk/eksik alanlar çökertmez", () => {
    const bozuk = [
      {},
      { orderOutboundPackageId: 9, items: null },
      { orderOutboundPackageId: 9, items: [{ orderLine: null, claimItems: [{ claimItemStatus: null }] }] },
    ] as TrendyolIadeTalebi[];
    expect(trendyolIadeleri(bozuk).size).toBe(0);
  });

  it("aynı paketin farklı satırları ayrı sayılır", () => {
    const sonuc = trendyolIadeleri([
      talep(4, [
        { satir: 1, durumlar: ["Accepted"] },
        { satir: 2, durumlar: ["Accepted"] },
      ]),
    ]);
    expect(sonuc.get("ty-4")).toEqual({ kabulAdet: 2, satirSayisi: 2 });
  });
});

describe("trendyolIadeDurumu", () => {
  it("bütün adetler iade edildiyse tam, bir kısmıysa kısmi", () => {
    expect(trendyolIadeDurumu(2, { kabulAdet: 2, satirSayisi: 1 })).toBe("tam");
    expect(trendyolIadeDurumu(3, { kabulAdet: 1, satirSayisi: 1 })).toBe("kismi");
  });

  it("iade yoksa ya da paket adedi bilinmiyorsa iddia YOK", () => {
    expect(trendyolIadeDurumu(1, undefined)).toBeNull();
    expect(trendyolIadeDurumu(0, { kabulAdet: 1, satirSayisi: 1 })).toBeNull();
    expect(trendyolIadeDurumu(Number.NaN, { kabulAdet: 1, satirSayisi: 1 })).toBeNull();
  });
});

describe("trendyolTalepleriniTopla", () => {
  it("son sayfada durur", async () => {
    const istenen: number[] = [];
    const dolu = Array.from({ length: TRENDYOL_TALEP_SAYFA_BOYU }, () => ({}));
    const sonuc = await trendyolTalepleriniTopla(async (sayfa) => {
      istenen.push(sayfa);
      return { content: sayfa === 0 ? dolu : [{}], totalPages: 2 };
    });
    expect(istenen).toEqual([0, 1]);
    expect(sonuc).toHaveLength(TRENDYOL_TALEP_SAYFA_BOYU + 1);
  });

  it("bozuk yanıt sonsuz döngüye sokmaz", async () => {
    let n = 0;
    const dolu = Array.from({ length: TRENDYOL_TALEP_SAYFA_BOYU }, () => ({}));
    await trendyolTalepleriniTopla(async () => {
      n++;
      return { content: dolu };
    });
    expect(n).toBe(TRENDYOL_TALEP_SAYFA_TAVANI);
  });

  it("içerik dizi değilse boş sayılır", async () => {
    expect(await trendyolTalepleriniTopla(async () => ({ content: null }))).toEqual([]);
  });
});
