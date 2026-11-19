/**
 * HEPSIJET gönderi gövdeleri — dokümanın (2.1 STD, 2.5 RETURNED) açıkça uyardığı kurallar.
 * Hesap sabitleri ve kişiler UYDURMADIR.
 */
import { describe, expect, it } from "vitest";
import {
  barkodUret, hepsijetTarihi, hesapSabitleriniCoz, iadeGovdesi, stdGovdesi,
  type HepsijetHesapSabitleri, type KargoKisisi,
} from "./hepsijet-govde";

const hesap: HepsijetHesapSabitleri = {
  sirketAdi: "ÖRNEK MAĞAZA", sirketKodu: "ORNKMGZ", aktarmaKodu: "ORNKMGZMERKEZ", barkodOnEki: "ORN",
  depo: {
    adresKimligi: "orne-ornkmgz-1", il: "İzmir", ilce: "MENEMEN", mahalle: "ÖRNEK",
    adres: "ÖRNEK MH. 1 SK. NO:1 MENEMEN / İZMİR", yetkili: "Depo Görevlisi", telefon: "05001112233",
  },
};
const alici: KargoKisisi = {
  ad: "Deneme", soyad: "Müşteri", telefon: "05321234567", il: "ANKARA", ilce: "ÇANKAYA",
  mahalle: "KIZILAY", adres: "Kızılay Mah. Lale Sok. No:1 D:2",
};
let sayac = 0;
const uuid = () => `uuid-${++sayac}`;

describe("standart teslimat", () => {
  it("dokümandaki iskelet: sabit alanlar, depo gönderici, müşteri alıcı", () => {
    sayac = 0;
    const g = stdGovdesi(hesap, {
      barkod: "ORN176300000012", siparisNo: "1213", alici, uuid, tarih: new Date("2026-11-19T08:00:00Z"),
      icerik: [{ ad: "Kulaklık Standı", adet: 1, sku: "KS-1" }, { ad: "Figür", adet: 2 }],
    });
    expect(g.company).toEqual({ name: "ÖRNEK MAĞAZA", abbreviationCode: "ORNKMGZ" });
    expect(g.currentXDock).toEqual({ abbreviationCode: "ORNKMGZMERKEZ" });
    expect(g.delivery).toMatchObject({
      customerDeliveryNo: "ORN176300000012", customerOrderId: "1213", deliveryDateOriginal: "2026-11-19",
      totalParcels: "1", desi: "1", deliverySlotOriginal: "0", deliveryType: "RETAIL",
      product: { productCode: "HX_STD" },
      senderAddress: { companyAddressId: "orne-ornkmgz-1", country: { name: "Türkiye" }, city: { name: "İzmir" }, town: { name: "MENEMEN" } },
      receiver: { firstName: "Deneme", lastName: "Müşteri", phone1: "05321234567", phone2: "", email: "" },
      recipientAddress: { country: { name: "Türkiye" }, city: { name: "ANKARA" }, town: { name: "ÇANKAYA" }, district: { name: "KIZILAY" } },
      recipientPerson: "Deneme Müşteri", recipientPersonPhone1: "05321234567",
    });
    expect(g.deliveryContent).toEqual([
      { sku: "KS-1", description: "Kulaklık Standı", desi: 1, quantity: 1, indivisibleQuantity: false },
      { sku: "", description: "Figür", desi: 1, quantity: 2, indivisibleQuantity: false },
    ]);
  });

  it("alıcı ve adres kimliği HER gönderide yeni (çapraz kargo olmasın)", () => {
    const a = stdGovdesi(hesap, { barkod: "ORN1", siparisNo: "1", alici, icerik: [] });
    const b = stdGovdesi(hesap, { barkod: "ORN2", siparisNo: "1", alici, icerik: [] });
    const kimlikler = [a, b].flatMap((g) => [g.delivery.receiver.companyCustomerId, g.delivery.recipientAddress.companyAddressId]);
    expect(new Set(kimlikler).size).toBe(4);
    expect(kimlikler.every((k) => /^[0-9a-f-]{36}$/.test(k))).toBe(true);
    // Depo kimliği ise sabit.
    expect(a.delivery.senderAddress.companyAddressId).toBe(b.delivery.senderAddress.companyAddressId);
  });

  it("mahalle yoksa alan gönderilmez; içerik boşsa tek genel kalem; gece yarısı Türkiye tarihi", () => {
    const g = stdGovdesi(hesap, {
      barkod: "ORN1", siparisNo: "1", alici: { ...alici, mahalle: null }, icerik: [{ ad: " ", adet: 1 }, { ad: "İade edildi", adet: 0 }],
      tarih: new Date("2026-11-19T22:30:00Z"),
    });
    expect(g.delivery.recipientAddress).not.toHaveProperty("district");
    expect(g.deliveryContent).toHaveLength(1);
    expect(g.delivery.deliveryDateOriginal).toBe("2026-11-20");
    expect(hepsijetTarihi(new Date("2026-11-19T20:59:00Z"))).toBe("2026-11-19");
  });

  it("eksik / hatalı bilgiyle gövde ÜRETİLMEZ", () => {
    const yap = (o: Partial<KargoKisisi>, ek: object = {}) => () =>
      stdGovdesi(hesap, { barkod: "ORN1", siparisNo: "1", alici: { ...alici, ...o }, icerik: [], ...ek });
    expect(yap({ ilce: "" })).toThrow(/ilçesi/);
    expect(yap({ telefon: "5321234567" })).toThrow(/telefonu/);
    expect(yap({ soyad: " " })).toThrow(/soyadı/);
    expect(yap({ adres: "" })).toThrow(/adresi/);
    expect(yap({}, { desi: 42 })).toThrow(/Desi/);
    expect(yap({}, { barkod: "ORN12345678901234567" })).toThrow(/19 karakter/);
  });
});

describe("iade", () => {
  it("gönderici müşteri (yeni kimlik), alıcı depo (sabit kimlik); içerik bloğu YOK", () => {
    sayac = 0;
    const g = iadeGovdesi(hesap, { barkod: "ORN176300000099", siparisNo: "1213", musteri: alici, randevuTarihi: "2026-11-21", uuid });
    expect(g).not.toHaveProperty("deliveryContent");
    expect(g.delivery).toMatchObject({
      deliveryType: "RETURNED", product: { productCode: "HX_STD" }, deliveryDateOriginal: "2026-11-21", deliverySlotOriginal: "0",
      senderAddress: { companyAddressId: "uuid-1", city: { name: "ANKARA" }, town: { name: "ÇANKAYA" } },
      receiver: { companyCustomerId: "uuid-2", firstName: "Deneme", phone2: "", email: "" },
      recipientAddress: { companyAddressId: "orne-ornkmgz-1", town: { name: "MENEMEN" } },
      recipientPerson: "Depo Görevlisi", recipientPersonPhone1: "05001112233",
    });
  });

  it("tarih randevu servisinden gelmeli; depo yetkilisi tanımsızsa iade oluşturulmaz", () => {
    expect(() => iadeGovdesi(hesap, { barkod: "ORN1", siparisNo: "1", musteri: alici, randevuTarihi: "yarın" })).toThrow(/randevu/);
    const yetkilisiz = { ...hesap, depo: { ...hesap.depo, yetkili: undefined } };
    expect(() => iadeGovdesi(yetkilisiz, { barkod: "ORN1", siparisNo: "1", musteri: alici, randevuTarihi: "2026-11-21" })).toThrow(/yetkilisi/);
  });
});

describe("barkod ve hesap sabitleri", () => {
  it("ön ek + 12 rakam (panelin ürettiğiyle aynı boy), en çok 19 karakter", () => {
    const b = barkodUret("orn", new Date("2026-11-19T08:00:00Z"), () => 0.07);
    expect(b).toBe("ORN179507520007");
    expect(b).toHaveLength(15);
    expect(() => barkodUret("OR")).toThrow(/3 karakter/);
    expect(barkodUret("ORN", new Date(), () => 0.999)).toMatch(/^ORN\d{12}$/);
  });

  it("kayıtlı sabitler: eksik alan / bozuk JSON → null", () => {
    expect(hesapSabitleriniCoz(JSON.stringify(hesap))).toEqual(hesap);
    expect(hesapSabitleriniCoz(JSON.stringify({ ...hesap, aktarmaKodu: "" }))).toBeNull();
    expect(hesapSabitleriniCoz(JSON.stringify({ ...hesap, barkodOnEki: "ORNK" }))).toBeNull();
    expect(hesapSabitleriniCoz("{bozuk")).toBeNull();
    expect(hesapSabitleriniCoz(null)).toBeNull();
    const yetkilisiz = hesapSabitleriniCoz(JSON.stringify({ ...hesap, depo: { ...hesap.depo, yetkili: "", telefon: undefined } }));
    expect(yetkilisiz?.depo.yetkili).toBeUndefined();
  });
});
