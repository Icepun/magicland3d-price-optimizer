import { describe, expect, it } from "vitest";

import {
  HB_SAYFA_TAVANI,
  hbSiparisleriTopla,
  hbTalepSayfasi,
  hbTumSayfalar,
  type HbListeUclari,
  type HbTalepTuru,
} from "./hb-siparis";

/**
 * HB LİSTELERİNİN BİRLEŞTİRİLMESİ — masaüstü ve telefonun ORTAK kuralı.
 * Masaüstünün uçtan uca hâli `api/orders/orders-route.test.ts`, telefonunki
 * `lib/mobile-hb-siparis.test.ts`; burada kuralın kendisi.
 */

type Satir = Record<string, unknown>;

function uclar(v: {
  acik?: Satir[][];
  paket?: Partial<Record<"" | "shipped" | "delivered" | "undelivered", Satir[]>>;
  talep?: Partial<Record<HbTalepTuru, Satir[] | null | "patla">>;
}): HbListeUclari {
  return {
    acikSiparisler: async (offset) => ({ items: v.acik?.[offset / 100] ?? [] }),
    paketler: async (durum, offset) => ({ items: offset === 0 ? v.paket?.[durum] ?? [] : [] }),
    talepler: async (tur, offset) => {
      const t = v.talep?.[tur];
      if (t === "patla") throw new Error("beklenmeyen");
      if (t == null) return null;
      return { items: offset === 0 ? t : [] };
    },
  };
}

const kalem = (li: Satir) => ({ ad: String(li.productName ?? ""), adet: Number(li.quantity ?? 1) });
const topla = (u: HbListeUclari) => hbSiparisleriTopla(u, kalem);

const gunOnce = (n: number) => new Date(Date.UTC(2026, 8, 20) - n * 86_400_000).toISOString();

describe("açık siparişler", () => {
  it("tek sayfayla sınırlı kalmaz — 100'ü aşan kalemler de okunur", async () => {
    const li = (i: number) => ({ orderNumber: `A${i}`, orderDate: gunOnce(1), productName: "x" });
    const { siparisler } = await topla(
      uclar({
        acik: [Array.from({ length: 100 }, (_, i) => li(i)), Array.from({ length: 30 }, (_, i) => li(100 + i))],
      })
    );
    expect(siparisler.size).toBe(130);
  });

  it("aynı siparişin kalemleri birleşir", async () => {
    const { siparisler } = await topla(
      uclar({
        acik: [
          [
            { orderNumber: "A1", productName: "Vazo", quantity: 1 },
            { orderNumber: "A1", productName: "Kupa", quantity: 2 },
          ],
        ],
      })
    );
    expect(siparisler.get("A1")?.lines).toEqual([
      { ad: "Vazo", adet: 1 },
      { ad: "Kupa", adet: 2 },
    ]);
    expect(siparisler.get("A1")?.status).toBe("Open");
  });

  it("sayfalama tavanda durur (bozuk yanıt sonsuz döngüye sokmaz)", async () => {
    let cagri = 0;
    const dolu = Array.from({ length: 100 }, () => ({ orderNumber: "X" }));
    const hepsi = await hbTumSayfalar(async () => {
      cagri++;
      return dolu;
    }, ["items"]);
    expect(cagri).toBe(HB_SAYFA_TAVANI / 100);
    expect(hepsi).toHaveLength(HB_SAYFA_TAVANI);
  });
});

describe("tarih = siparişin VERİLİŞ anı", () => {
  it("teslim/kargo damgası sipariş tarihi sayılmaz", async () => {
    const { siparisler } = await topla(
      uclar({
        paket: {
          delivered: [{ OrderNumber: "T1", orderDate: gunOnce(5), DeliveredDate: gunOnce(1) }],
          shipped: [{ OrderNumber: "K1", CreatedDate: gunOnce(4), ShippedDate: gunOnce(2) }],
        },
      })
    );
    expect(siparisler.get("T1")?.date).toBe(Date.parse(gunOnce(5)));
    expect(siparisler.get("K1")?.date).toBe(Date.parse(gunOnce(4)));
  });

  it("yalnız teslim damgası varsa tarih BİLİNMİYOR sayılır (teslim anı uydurulmaz)", async () => {
    const { siparisler } = await topla(
      uclar({ paket: { delivered: [{ OrderNumber: "T2", DeliveredDate: gunOnce(1) }] } })
    );
    expect(siparisler.get("T2")?.date).toBeNull();
  });
});

describe("paket listeleri", () => {
  it("hem kargoda hem teslim listesindeki sipariş teslim sayılır (ileri durum kazanır)", async () => {
    const { siparisler } = await topla(
      uclar({ paket: { shipped: [{ OrderNumber: "S1" }], delivered: [{ OrderNumber: "S1" }] } })
    );
    expect(siparisler.get("S1")?.status).toBe("Delivered");
  });

  it("tam sipariş veren uçta anahtar paket numarası değil SİPARİŞ numarası", async () => {
    const { siparisler, paketCiftleri } = await topla(
      uclar({
        paket: {
          "": [{ OrderNumber: "O1", packageNumber: "P1", items: [{ productName: "Vazo" }] }],
          shipped: [{ OrderNumber: "O1" }],
        },
      })
    );
    expect([...siparisler.keys()]).toEqual(["O1"]);
    expect(siparisler.get("O1")?.lines).toEqual([{ ad: "Vazo", adet: 1 }]);
    expect(paketCiftleri).toEqual([{ orderNo: "O1", packageNo: "P1" }]);
  });

  /**
   * GERÇEK BİÇİM (ölçüldü 3 Eki 2026): statüsüz pakette sipariş numarası ÜSTTE yok, kalemde.
   * Eskiden anahtar paket numarasına düşüyordu → aynı sipariş paketlenince ikinci kez "yeni"
   * bildiriliyor ve finans geçmişine ikinci kez yazılıyordu.
   */
  it("sipariş numarası yalnız kalemdeyse de anahtar SİPARİŞ numarasıdır (açık siparişle birleşir)", async () => {
    const { siparisler, paketCiftleri } = await topla(
      uclar({
        acik: [[{ orderNumber: "4733", productName: "Vazo", quantity: 1 }]],
        paket: {
          "": [{ packageNumber: "5523", status: "Open", items: [{ orderNumber: "4733", productName: "Vazo" }] }],
        },
      })
    );
    expect([...siparisler.keys()]).toEqual(["4733"]);
    expect(paketCiftleri).toEqual([{ orderNo: "4733", packageNo: "5523" }]);
  });

  it("teslim/kargo listelerindeki büyük harfli PackageNumber da kopya temizliği için eşlenir", async () => {
    const { paketCiftleri } = await topla(
      uclar({ paket: { delivered: [{ OrderNumber: "4740", PackageNumber: "5522" }] } })
    );
    expect(paketCiftleri).toEqual([{ orderNo: "4740", packageNo: "5522" }]);
  });
});

describe("iptal / iade listeleri", () => {
  const teslim = { delivered: [{ OrderNumber: "R1", orderDate: gunOnce(3) }] };

  it("kaydın KENDİ durumu iade diyorsa teslim edilen sipariş iade olur", async () => {
    const { siparisler } = await topla(
      uclar({ paket: teslim, talep: { returned: [{ OrderNumber: "R1", status: "Returned" }] } })
    );
    expect(siparisler.get("R1")?.status).toBe("Returned");
  });

  it("müşteri iptali gibi alt durumlar da kendi adıyla yazılır", async () => {
    const { siparisler } = await topla(
      uclar({ paket: teslim, talep: { cancelled: [{ OrderNumber: "R1", Status: "CancelledByCustomer" }] } })
    );
    expect(siparisler.get("R1")?.status).toBe("CancelledByCustomer");
  });

  it("GÜVENLİK FRENİ: kayıt kendi durumunu söylemiyorsa aktif sipariş EZİLMEZ", async () => {
    const { siparisler } = await topla(
      uclar({
        paket: teslim,
        talep: {
          cancelled: [{ OrderNumber: "R1" }],
          returned: [{ OrderNumber: "R1", status: "Delivered" }],
        },
      })
    );
    expect(siparisler.get("R1")?.status).toBe("Delivered");
  });

  it("yalnız iptal/iade listesindeki sipariş eklenir; tarih yine veriliş anı", async () => {
    const { siparisler } = await topla(
      uclar({
        talep: {
          cancelled: [{ OrderNumber: "C1", CreatedDate: gunOnce(6), CancelledDate: gunOnce(1) }],
          returned: [{ OrderNumber: "C2", ReturnDate: gunOnce(1) }],
        },
      })
    );
    expect(siparisler.get("C1")).toEqual({
      status: "Cancelled",
      date: Date.parse(gunOnce(6)),
      customer: null,
      lines: null,
    });
    // Sipariş tarihi hiç yoksa talep damgası son çare (masaüstüyle aynı sıra).
    expect(siparisler.get("C2")).toMatchObject({ status: "Returned", date: Date.parse(gunOnce(1)) });
  });

  it("uç yoksa ya da beklenmedik hata verirse siparişler etkilenmez", async () => {
    for (const talep of [
      { cancelled: null, returned: null },
      { cancelled: "patla" as const, returned: "patla" as const },
    ]) {
      const { siparisler } = await topla(uclar({ paket: teslim, talep }));
      expect([...siparisler.entries()]).toEqual([
        ["R1", { status: "Delivered", date: Date.parse(gunOnce(3)), customer: null, lines: null }],
      ]);
    }
  });

  it("paket listesi hatası YUTULMAZ (eksik veri tam sanılmasın)", async () => {
    const u = uclar({});
    u.paketler = async () => {
      throw new Error("Hepsiburada API 500");
    };
    await expect(topla(u)).rejects.toThrow("500");
  });
});

describe("iptal/iade yol denemesi", () => {
  const hata = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

  it("ilk aday yoksa ikincisi denenir, çalışan yol hatırlanır", async () => {
    const istekler: string[] = [];
    const hafiza = new Map<HbTalepTuru, string | null>();
    const iste = async (yol: string) => {
      istekler.push(yol);
      if (yol.startsWith("/orders/merchantid/m%2F1/cancelled")) return { items: [] };
      throw hata(404);
    };
    const baglam = { merchantId: "m/1", hafiza, iste };

    expect(await hbTalepSayfasi("cancelled", { offset: 0, limit: 100 }, baglam)).toEqual({ items: [] });
    expect(istekler).toEqual([
      "/packages/merchantid/m%2F1/cancelled?offset=0&limit=100",
      "/orders/merchantid/m%2F1/cancelled?offset=0&limit=100",
    ]);
    await hbTalepSayfasi("cancelled", { offset: 100, limit: 100 }, baglam);
    expect(istekler.at(-1)).toBe("/orders/merchantid/m%2F1/cancelled?offset=100&limit=100");
    expect(istekler).toHaveLength(3);
  });

  it("400/401 ve durumsuz (ağ) hatalar yolu kalıcı olarak ELEMEZ", async () => {
    for (const h of [hata(400), hata(401), new Error("ağ koptu")]) {
      const hafiza = new Map<HbTalepTuru, string | null>();
      const sonuc = await hbTalepSayfasi("returned", { offset: 0, limit: 100 }, {
        merchantId: "m",
        hafiza,
        iste: async () => {
          throw h;
        },
      });
      expect(sonuc).toBeNull();
      expect(hafiza.has("returned")).toBe(false);
    }
  });

  it("bütün adaylar 'yol yok' derse bir daha ağa çıkılmaz", async () => {
    let n = 0;
    const baglam = {
      merchantId: "m",
      hafiza: new Map<HbTalepTuru, string | null>(),
      iste: async () => {
        n++;
        throw hata(404);
      },
    };
    expect(await hbTalepSayfasi("returned", { offset: 0, limit: 100 }, baglam)).toBeNull();
    const ilk = n;
    expect(await hbTalepSayfasi("returned", { offset: 0, limit: 100 }, baglam)).toBeNull();
    expect(n).toBe(ilk);
  });
});
