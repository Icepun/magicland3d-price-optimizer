import { describe, expect, it } from "vitest";
import {
  hepsijetDurumu,
  hepsijetTakipAdresi,
  hepsijetTakipCoz,
  kargoIptalEdilebilir,
  kargoOlaylariOku,
  kargoSonDurumMu,
  kuryeAldiMi,
} from "./kargo-gonderisi";
import { etiketAnahtari, etiketBasilabilir, etiketIstegi, type EtiketSiparisi } from "./etiket-uygunluk";

// Test ortamında ölçülen yanıtın biçimi (24 Kas 2026) — kişisel alanlar uydurma.
const olcumYaniti = {
  status: "OK",
  data: [
    {
      customerDeliveryNo: "CPR100000000001",
      barcode: "CPR100000000001",
      deliveryType: "RETURNED",
      lastTransaction: "İade gönderisi teslim alınacak",
      deliveryStatus: "WAITING_FOR_DISPATCH",
      operationStatus: "IN_CUSTOMER",
      transactions: [
        {
          deliveryStatus: "WAITING_FOR_DISPATCH",
          operationStatus: "IN_CUSTOMER",
          transactionType: "SET_APPOINTMENT_DATE",
          transactionDateTime: "2026-11-24T20:43:24+03:00",
          transaction: "İade gönderisi teslim alınacak",
        },
      ],
    },
  ],
};

describe("HepsiJet durum kodu → uygulama durumu", () => {
  it("bilinen kodlar", () => {
    expect(hepsijetDurumu("WAITING_FOR_DISPATCH", "IN_CUSTOMER")).toBe("olusturuldu");
    expect(hepsijetDurumu("ACCEPTED", "IN_TRANSFER")).toBe("yolda");
    expect(hepsijetDurumu("DELIVERING")).toBe("dagitimda");
    expect(hepsijetDurumu("DELIVERED")).toBe("teslim");
    expect(hepsijetDurumu("UNDELIVERED")).toBe("sorun");
    expect(hepsijetDurumu("RETURNED_TO_SENDER")).toBe("iade");
    expect(hepsijetDurumu("DELETED")).toBe("iptal");
  });

  it("tanınmayan kod 'yolda' sayılır; gönderende bekleyen paket 'kurye bekleniyor'", () => {
    expect(hepsijetDurumu("IN_BRANCH_XYZ")).toBe("yolda");
    expect(hepsijetDurumu("", "IN_CUSTOMER")).toBe("olusturuldu");
    expect(hepsijetDurumu("WAITING_FOR_DISPATCH", "ON_THE_WAY")).toBe("yolda");
  });

  it("kurye aldı / son durum / iptal edilebilir", () => {
    expect(kuryeAldiMi("olusturuldu")).toBe(false);
    for (const d of ["yolda", "dagitimda", "teslim", "sorun", "iade"]) expect(kuryeAldiMi(d)).toBe(true);
    expect(kargoSonDurumMu("teslim")).toBe(true);
    expect(kargoSonDurumMu("iptal")).toBe(true);
    expect(kargoSonDurumMu("yolda")).toBe(false);
    expect(kargoIptalEdilebilir({ durum: "olusturuldu" })).toBe(true);
    expect(kargoIptalEdilebilir({ durum: "yolda" })).toBe(false);
  });
});

describe("takip yanıtını çöz", () => {
  it("ölçülen biçim: barkod, HepsiJet'in Türkçe metni, olaylar", () => {
    const m = hepsijetTakipCoz(olcumYaniti);
    const t = m.get("CPR100000000001");
    expect(t).toMatchObject({
      durum: "olusturuldu",
      metin: "İade gönderisi teslim alınacak",
      ham: "WAITING_FOR_DISPATCH",
      sonOlayAni: Date.parse("2026-11-24T20:43:24+03:00"),
    });
    expect(t?.olaylar).toHaveLength(1);
  });

  it("yanıtta olmayan barkod sonuçta yoktur (kurye henüz almadı)", () => {
    expect(hepsijetTakipCoz({ status: "OK" }).size).toBe(0);
    expect(hepsijetTakipCoz({ status: "OK", data: [] }).size).toBe(0);
    expect(hepsijetTakipCoz(null).size).toBe(0);
  });

  it("olaylar zamana göre sıralanır; bozuk olay atlanır; son metin yoksa son olay", () => {
    const m = hepsijetTakipCoz({
      data: [
        {
          customerDeliveryNo: "X1",
          deliveryStatus: "DELIVERED",
          transactions: [
            { transactionDateTime: "2026-11-26T10:00:00+03:00", transaction: "Teslim edildi", deliveryStatus: "DELIVERED" },
            { transactionDateTime: "bozuk", transaction: "?" },
            { transactionDateTime: "2026-11-25T09:00:00+03:00", transaction: "Kurye teslim aldı", deliveryStatus: "ACCEPTED" },
          ],
        },
      ],
    });
    const t = m.get("X1")!;
    expect(t.durum).toBe("teslim");
    expect(t.olaylar.map((o) => o.metin)).toEqual(["Kurye teslim aldı", "Teslim edildi"]);
    expect(t.metin).toBe("Teslim edildi");
  });

  it("kayıtlı olay JSON'u güvenle okunur", () => {
    expect(kargoOlaylariOku(null)).toEqual([]);
    expect(kargoOlaylariOku("bozuk")).toEqual([]);
    expect(kargoOlaylariOku(JSON.stringify([{ an: 1, metin: "a", durum: null }, { an: "x" }]))).toEqual([{ an: 1, metin: "a", durum: null }]);
  });

  it("takip adresi Berke'nin Shopify'a elle yazdığıyla aynı", () => {
    expect(hepsijetTakipAdresi("CPR179554174047")).toBe("https://hepsijet.com/gonderi-takibi/CPR179554174047");
  });
});

describe("Shopify etiketi yalnız uygulamadan açılan HepsiJet gönderisinde", () => {
  const shopify = (ek: Partial<EtiketSiparisi>): EtiketSiparisi => ({
    platform: "shopify", id: "gid://shopify/Order/1", orderNumber: "#1227", trackingNumber: null, statusKind: "processing", ...ek,
  });

  it("barkod yoksa basılamaz (başka kargoyla elle gönderilen takip no yetmez)", () => {
    expect(etiketBasilabilir(shopify({ trackingNumber: "ARAS123" }))).toBe(false);
    expect(etiketAnahtari(shopify({ trackingNumber: "ARAS123" }))).toBeNull();
  });

  it("barkod varsa anahtar barkod, uç /api/kargo/etiket", () => {
    const s = shopify({ hepsijetBarkodu: "CPR179554174047", trackingNumber: "ESKI" });
    expect(etiketBasilabilir(s)).toBe(true);
    expect(etiketAnahtari(s)).toBe("CPR179554174047");
    expect(etiketIstegi(s)).toEqual({ url: "/api/kargo/etiket", govde: { barkod: "CPR179554174047", siparisNo: "#1227" } });
  });

  it("teslim edilmiş / iptal siparişte basılamaz", () => {
    expect(etiketBasilabilir(shopify({ hepsijetBarkodu: "CPR1", statusKind: "delivered" }))).toBe(false);
    expect(etiketBasilabilir(shopify({ hepsijetBarkodu: "CPR1", statusKind: "cancelled" }))).toBe(false);
  });
});
