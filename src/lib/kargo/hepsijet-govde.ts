/**
 * HEPSIJET GÖNDERİ İSTEĞİ — standart teslimat (STD) ve iade (RETURNED) gövdeleri.
 *
 * Kaynak: HepsiJet dokümanı "2.1. Standart" ve "2.5. HJ - RETURNED". Dokümanın açıkça uyardığı
 * kurallar burada KODLA korunur (testte kilitli):
 *  • Alıcının `companyCustomerId` ve adresinin `companyAddressId` değeri HER gönderide YENİ UUID —
 *    eski kimlik tekrar giderse paket müşterinin eski adresine yönlenir ("çapraz kargo").
 *  • `phone2` / `email` yoksa alan silinmez, "" gönderilir.
 *  • İadede gönderici = müşteri, alıcı = depomuz; `deliveryContent` bloğu KESİNLİKLE yok;
 *    tarih rastgele olamaz (randevu servisinden gelir).
 *  • Barkod en çok 19 karakter (çoklu koli eklerine yer kalsın), başında 3 haneli firma kodu.
 *
 * SAF — ağ yok. Hesap sabitleri (şirket, depo, aktarma) dışarıdan verilir; repoda TUTULMAZ.
 */
import { randomUUID } from "node:crypto";

/** HepsiJet'in hesaba tanımladığı sabitler (mailinden). */
export interface HepsijetHesapSabitleri {
  sirketAdi: string;
  sirketKodu: string;
  /** Aktarma merkezi (X-Dock) kısa kodu. */
  aktarmaKodu: string;
  /** Barkodun başındaki 3 haneli firma kodu. */
  barkodOnEki: string;
  depo: {
    /** HepsiJet'in verdiği sabit adres kimliği. */
    adresKimligi: string;
    il: string;
    ilce: string;
    mahalle: string;
    adres: string;
    /** İadeyi teslim alacak kişi ve telefonu (iade gönderilerinde alıcı). */
    yetkili?: string;
    telefon?: string;
  };
}

export interface KargoKisisi {
  ad: string;
  soyad: string;
  /** 05xxxxxxxxx */
  telefon: string;
  il: string;
  ilce: string;
  mahalle?: string | null;
  adres: string;
}

export interface KargoIcerigi {
  ad: string;
  adet: number;
  sku?: string | null;
}

const BARKOD_AZAMI = 19;

/**
 * Yeni barkod: ön ek + 12 rakam (saniye cinsinden zaman + 2 rastgele rakam) — panelin ürettiği
 * biçimle aynı uzunlukta (3 + 12). Aynı saniyede iki gönderi çakışmasın diye son iki rakam rastgele.
 */
export function barkodUret(onEk: string, simdi: Date = new Date(), rastgele: () => number = Math.random): string {
  const ek = onEk.trim().toUpperCase();
  if (!/^[A-Z0-9]{3}$/.test(ek)) throw new Error("Barkod ön eki 3 karakter olmalı.");
  const saniye = String(Math.floor(simdi.getTime() / 1000)).padStart(10, "0").slice(-10);
  const son = String(Math.floor(rastgele() * 100)).padStart(2, "0");
  return `${ek}${saniye}${son}`;
}

/** YYYY-MM-DD (Türkiye saati) — "siparişin oluşturulduğu günün tarihi". */
export function hepsijetTarihi(zaman: Date = new Date()): string {
  return new Date(zaman.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

function barkodDenetle(barkod: string) {
  if (!barkod || barkod.length > BARKOD_AZAMI) throw new Error(`Barkod en çok ${BARKOD_AZAMI} karakter olabilir.`);
}

function kisiDenetle(k: KargoKisisi, kim: string) {
  if (!k.ad.trim() || !k.soyad.trim()) throw new Error(`${kim} adı ve soyadı gerekli.`);
  if (!/^05\d{9}$/.test(k.telefon)) throw new Error(`${kim} telefonu 05xxxxxxxxx biçiminde olmalı.`);
  if (!k.il.trim() || !k.ilce.trim()) throw new Error(`${kim} ili ve ilçesi gerekli.`);
  if (!k.adres.trim()) throw new Error(`${kim} adresi gerekli.`);
}

const sirket = (h: HepsijetHesapSabitleri) => ({ name: h.sirketAdi, abbreviationCode: h.sirketKodu });

function depoAdresi(h: HepsijetHesapSabitleri) {
  return {
    companyAddressId: h.depo.adresKimligi,
    country: { name: "Türkiye" },
    city: { name: h.depo.il },
    town: { name: h.depo.ilce },
    district: { name: h.depo.mahalle },
    addressLine1: h.depo.adres,
  };
}

/** Müşteri adresi — kimlik HER çağrıda yeni. Mahalle yoksa alan gönderilmez (açık adreste geçer). */
function musteriAdresi(k: KargoKisisi, uuid: () => string) {
  const mahalle = k.mahalle?.trim();
  return {
    companyAddressId: uuid(),
    country: { name: "Türkiye" },
    city: { name: k.il },
    town: { name: k.ilce },
    ...(mahalle ? { district: { name: mahalle } } : {}),
    addressLine1: k.adres.trim(),
  };
}

function musteriKisisi(k: KargoKisisi, uuid: () => string) {
  return {
    companyCustomerId: uuid(),
    firstName: k.ad.trim(),
    lastName: k.soyad.trim(),
    phone1: k.telefon,
    phone2: "",
    email: "",
  };
}

export interface StdGirdisi {
  barkod: string;
  /** Sipariş numarası (en çok 25 karakter; fazlası kesilir). */
  siparisNo: string;
  alici: KargoKisisi;
  icerik: KargoIcerigi[];
  /** Varsayılan 1 — HepsiJet paketi kendisi ölçüp günceller. */
  desi?: number;
  koli?: number;
  tarih?: Date;
  uuid?: () => string;
}

/** Standart teslimat (RETAIL / HX_STD). */
export function stdGovdesi(h: HepsijetHesapSabitleri, g: StdGirdisi) {
  barkodDenetle(g.barkod);
  kisiDenetle(g.alici, "Alıcı");
  const desi = g.desi ?? 1;
  if (!(desi >= 1 && desi <= 41)) throw new Error("Desi 1 ile 41 arasında olmalı.");
  const uuid = g.uuid ?? randomUUID;
  const icerik = g.icerik.filter((x) => x.adet > 0 && x.ad.trim());
  return {
    company: sirket(h),
    delivery: {
      customerDeliveryNo: g.barkod,
      customerOrderId: g.siparisNo.slice(0, 25),
      deliveryDateOriginal: hepsijetTarihi(g.tarih),
      totalParcels: String(g.koli ?? 1),
      desi: String(desi),
      deliverySlotOriginal: "0",
      deliveryType: "RETAIL",
      product: { productCode: "HX_STD" },
      senderAddress: depoAdresi(h),
      receiver: musteriKisisi(g.alici, uuid),
      recipientAddress: musteriAdresi(g.alici, uuid),
      recipientPerson: `${g.alici.ad.trim()} ${g.alici.soyad.trim()}`,
      recipientPersonPhone1: g.alici.telefon,
    },
    currentXDock: { abbreviationCode: h.aktarmaKodu },
    deliveryContent: (icerik.length ? icerik : [{ ad: "Ürün", adet: 1, sku: "" }]).map((x) => ({
      sku: x.sku ?? "",
      description: x.ad.trim().slice(0, 200),
      desi,
      quantity: x.adet,
      indivisibleQuantity: false,
    })),
  };
}

export interface IadeGirdisi {
  barkod: string;
  siparisNo: string;
  /** İadeyi gönderecek müşteri (kurye buradan alır). */
  musteri: KargoKisisi;
  /** Randevu servisinin (`findAvailableDeliveryDatesV2`) döndürdüğü tarih: YYYY-MM-DD. */
  randevuTarihi: string;
  desi?: number;
  koli?: number;
  uuid?: () => string;
}

/** İade (RETURNED / HX_STD): gönderici müşteri, alıcı depomuz; içerik bloğu YOK. */
export function iadeGovdesi(h: HepsijetHesapSabitleri, g: IadeGirdisi) {
  barkodDenetle(g.barkod);
  kisiDenetle(g.musteri, "Müşteri");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(g.randevuTarihi)) throw new Error("İade tarihi randevu servisinden alınmalı.");
  if (!h.depo.yetkili?.trim() || !/^0\d{10}$/.test(h.depo.telefon ?? "")) {
    throw new Error("İade için depo yetkilisi ve telefonu tanımlı olmalı.");
  }
  const uuid = g.uuid ?? randomUUID;
  return {
    company: sirket(h),
    delivery: {
      customerDeliveryNo: g.barkod,
      customerOrderId: g.siparisNo.slice(0, 25),
      deliveryDateOriginal: g.randevuTarihi,
      totalParcels: String(g.koli ?? 1),
      desi: String(g.desi ?? 1),
      deliverySlotOriginal: "0",
      deliveryType: "RETURNED",
      product: { productCode: "HX_STD" },
      senderAddress: musteriAdresi(g.musteri, uuid),
      receiver: musteriKisisi(g.musteri, uuid),
      recipientAddress: depoAdresi(h),
      recipientPerson: h.depo.yetkili.trim(),
      recipientPersonPhone1: h.depo.telefon!,
    },
    currentXDock: { abbreviationCode: h.aktarmaKodu },
  };
}

/** Kayıtlı (JSON) hesap sabitlerini doğrula; eksikse null. */
export function hesapSabitleriniCoz(ham: string | null | undefined): HepsijetHesapSabitleri | null {
  if (!ham) return null;
  try {
    const j = JSON.parse(ham) as Partial<HepsijetHesapSabitleri>;
    const m = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const d = (j.depo ?? {}) as Partial<HepsijetHesapSabitleri["depo"]>;
    const zorunlu = [j.sirketAdi, j.sirketKodu, j.aktarmaKodu, j.barkodOnEki, d.adresKimligi, d.il, d.ilce, d.mahalle, d.adres].map(m);
    if (zorunlu.some((x) => x == null)) return null;
    const [sirketAdi, sirketKodu, aktarmaKodu, barkodOnEki, adresKimligi, il, ilce, mahalle, adres] = zorunlu as string[];
    if (!/^[A-Za-z0-9]{3}$/.test(barkodOnEki)) return null;
    return {
      sirketAdi, sirketKodu, aktarmaKodu, barkodOnEki: barkodOnEki.toUpperCase(),
      depo: { adresKimligi, il, ilce, mahalle, adres, yetkili: m(d.yetkili) ?? undefined, telefon: m(d.telefon) ?? undefined },
    };
  } catch {
    return null;
  }
}
