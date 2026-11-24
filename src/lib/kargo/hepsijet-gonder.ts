import { randomUUID } from "node:crypto";
import { remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { siparisKimligi } from "@/core/order-line-cost";
import { kargoIptalEdilebilir, type KargoGonderiOzeti } from "@/core/kargo-gonderisi";
import { HepsijetClient, HepsijetHatasi, hepsijetSonucu, zplBul, type HepsijetOrtami } from "@/services/hepsijet-client";
import { hepsijetKimligi } from "@/services/hepsijet-settings";
import { ShopifyClient, type ShopifyKargoBilgisi } from "@/services/shopify-client";
import { getShopifyCredentials } from "@/services/shopify-settings";
import { kopyaKaydet } from "@/lib/etiket/kayit";
import { KullaniciHatasi } from "@/lib/etiket/kullanici-hatasi";
import { adresCoz, mahalleEsle, telefonCoz, type CozulenAdres } from "./adres-coz";
import { barkodUret, stdGovdesi, type KargoKisisi } from "./hepsijet-govde";
import { hepsijetHesabiOku } from "./hepsijet-hesap";
import { hepsijetIlleri, hepsijetMahalleleri } from "./hepsijet-yerler";
import { barkodlaGonderi, gonderiOzeti, siparisinAcikGonderisi } from "./kargo-gonderileri";

/**
 * KARGO OLUŞTUR (Shopify siparişi → HepsiJet). Berke'nin onayladığı akış (19 Kas 2026):
 * solda müşterinin yazdığı, sağda HepsiJet alanları (otomatik dolu, elle düzeltilir) → onay →
 * etiket. Desi ve koli HEP 1 (HepsiJet paketi kendisi ölçer). Shopify'a bu adımda YAZILMAZ —
 * "gönderildi" işareti kurye paketi alınca takip turunda konur (`kargo-takip`).
 *
 * ⚠️ Müşteri adı/adresi/telefonu günlüğe yazılmaz, veritabanına da kaydedilmez.
 */

const PLATFORM = "shopify";
/** Kargo içeriğinde ürün sayılmayan kalemler. */
const URUN_DEGIL = /hediye\s*paket/i;

export interface KargoHazirligi {
  siparis: { id: string; no: string; iptal: boolean; shopifydaGonderildi: boolean };
  /** Müşterinin Shopify'a yazdığı (ham). */
  musteri: {
    ad: string; soyad: string; telefon: string; address1: string; address2: string;
    city: string; province: string; zip: string;
  };
  /** HepsiJet alanları için öneri. */
  oneri: {
    ad: string; soyad: string; telefon: string; il: string; ilce: string; mahalle: string; acikAdres: string;
    kontrol: CozulenAdres["kontrol"];
  };
  iller: { ad: string; ilceler: string[] }[];
  mahalleler: string[];
  icerik: { ad: string; adet: number }[];
  ortam: HepsijetOrtami;
  hesapHazir: boolean;
  acikGonderi: KargoGonderiOzeti | null;
}

export interface KargoOlusturGirdisi {
  siparisId: string;
  alici: { ad: string; soyad: string; telefon: string; il: string; ilce: string; mahalle?: string | null; adres: string };
}

async function shopify(): Promise<ShopifyClient> {
  try {
    return new ShopifyClient(await getShopifyCredentials());
  } catch {
    throw new KullaniciHatasi("Shopify bağlantısı kurulmamış.");
  }
}

async function hepsijet(): Promise<{ hj: HepsijetClient; ortam: HepsijetOrtami }> {
  let kimlik;
  try {
    kimlik = await hepsijetKimligi();
  } catch {
    throw new KullaniciHatasi("HepsiJet bağlantısı kurulmamış.");
  }
  return { hj: new HepsijetClient(kimlik), ortam: kimlik.ortam };
}

function shopifyGid(siparisId: string): string {
  if (siparisId.startsWith("gid://")) return siparisId;
  const kimlik = siparisKimligi(PLATFORM, siparisId); // "sh-<no>"
  return `gid://shopify/Order/${kimlik.slice(3)}`;
}

async function siparisOku(siparisId: string): Promise<ShopifyKargoBilgisi> {
  const bilgi = await (await shopify()).kargoBilgisi(shopifyGid(siparisId)).catch(() => {
    throw new KullaniciHatasi("Shopify'dan sipariş okunamadı. Tekrar dene.");
  });
  if (!bilgi) throw new KullaniciHatasi("Sipariş Shopify'da bulunamadı.");
  return bilgi;
}

const sade = (s: string | null | undefined) => (s ?? "").toLocaleUpperCase("tr-TR").replace(/\s+/g, " ").trim();

function icerikCikar(bilgi: ShopifyKargoBilgisi) {
  return bilgi.kalemler.filter((k) => !URUN_DEGIL.test(k.ad)).map((k) => ({ ad: k.ad, adet: k.adet, sku: k.sku }));
}

/** İki sütunlu ekranın verisi. */
export async function kargoHazirligi(siparisId: string): Promise<KargoHazirligi> {
  const [bilgi, { hj, ortam }, hesap, acik] = await Promise.all([
    siparisOku(siparisId),
    hepsijet(),
    hepsijetHesabiOku(),
    siparisinAcikGonderisi(PLATFORM, siparisId),
  ]);
  const iller = await hepsijetIlleri(hj, ortam).catch((e) => {
    throw e instanceof HepsijetHatasi ? new KullaniciHatasi(e.message) : new KullaniciHatasi("HepsiJet'e ulaşılamadı. Tekrar dene.");
  });
  const ilKayitlari = iller.map((il) => ({ ad: il.ad, ilceler: il.ilceler.map((x) => x.ad) }));
  const a = bilgi.adres;
  const cozulen = adresCoz(
    { ad: a?.ad, soyad: a?.soyad, address1: a?.address1, address2: a?.address2, city: a?.city, province: a?.province, zip: a?.zip, phone: a?.phone },
    ilKayitlari
  );
  const mahalleler = cozulen.il && cozulen.ilce
    ? await hepsijetMahalleleri(hj, ortam, cozulen.il, cozulen.ilce).catch(() => [])
    : [];
  return {
    siparis: {
      id: siparisId,
      no: bilgi.ad,
      iptal: bilgi.iptal,
      shopifydaGonderildi: bilgi.acikGonderimEmirleri.length === 0 && bilgi.gonderimler.length > 0,
    },
    musteri: {
      ad: a?.ad ?? "", soyad: a?.soyad ?? "", telefon: a?.phone ?? "", address1: a?.address1 ?? "",
      address2: a?.address2 ?? "", city: a?.city ?? "", province: a?.province ?? "", zip: a?.zip ?? "",
    },
    oneri: {
      ad: cozulen.ad,
      soyad: cozulen.soyad,
      telefon: cozulen.telefon ?? "",
      il: cozulen.il ?? "",
      ilce: cozulen.ilce ?? "",
      mahalle: mahalleEsle(cozulen.mahalle, mahalleler) ?? "",
      acikAdres: cozulen.acikAdres,
      kontrol: cozulen.kontrol,
    },
    iller: ilKayitlari,
    mahalleler,
    icerik: icerikCikar(bilgi).map(({ ad, adet }) => ({ ad, adet })),
    ortam,
    hesapHazir: hesap != null,
    acikGonderi: acik ? gonderiOzeti(acik) : null,
  };
}

/** Seçilen ilçenin mahalleleri (ekranda ilçe değişince). */
export async function kargoMahalleleri(il: string, ilce: string): Promise<string[]> {
  const { hj, ortam } = await hepsijet();
  return hepsijetMahalleleri(hj, ortam, il, ilce);
}

function aliciDogrula(g: KargoOlusturGirdisi["alici"], iller: { ad: string; ilceler: { ad: string }[] }[]): KargoKisisi {
  const ad = g.ad.trim();
  const soyad = g.soyad.trim();
  if (!ad || !soyad) throw new KullaniciHatasi("Alıcının adı ve soyadı gerekli.");
  const telefon = telefonCoz(g.telefon);
  if (!telefon) throw new KullaniciHatasi("Telefon 05xx xxx xx xx biçiminde olmalı.");
  const il = iller.find((x) => sade(x.ad) === sade(g.il));
  if (!il) throw new KullaniciHatasi("İli listeden seç.");
  const ilce = il.ilceler.find((x) => sade(x.ad) === sade(g.ilce));
  if (!ilce) throw new KullaniciHatasi("İlçeyi listeden seç.");
  const adres = g.adres.trim();
  if (adres.length < 10) throw new KullaniciHatasi("Açık adres çok kısa.");
  return { ad, soyad, telefon, il: il.ad, ilce: ilce.ad, mahalle: g.mahalle?.trim() || null, adres };
}

export interface KargoOlusturSonucu {
  gonderi: KargoGonderiOzeti;
  siparisNo: string;
  /** Etiket gönderi açılırken geldi mi (yerel kopyaya yazıldı). */
  etiketHazir: boolean;
}

/** HepsiJet gönderisini aç, kaydet, etiketi yerel kopyaya yaz. Basma ayrı adım (`hepsijetEtiketiBas`). */
export async function kargoGonderisiAc(girdi: KargoOlusturGirdisi): Promise<KargoOlusturSonucu> {
  const [bilgi, { hj, ortam }, hesap, acik] = await Promise.all([
    siparisOku(girdi.siparisId),
    hepsijet(),
    hepsijetHesabiOku(),
    siparisinAcikGonderisi(PLATFORM, girdi.siparisId),
  ]);
  if (!hesap) throw new KullaniciHatasi("Önce Entegrasyonlar → HepsiJet'te gönderici bilgilerini gir.");
  if (acik) throw new KullaniciHatasi("Bu siparişin kargosu zaten oluşturuldu.");
  if (bilgi.iptal) throw new KullaniciHatasi("Sipariş iptal edilmiş.");
  const iller = await hepsijetIlleri(hj, ortam);
  const alici = aliciDogrula(girdi.alici, iller);

  const barkod = barkodUret(hesap.barkodOnEki);
  const govde = stdGovdesi(hesap, {
    barkod,
    siparisNo: bilgi.ad.replace(/^#/, ""),
    alici,
    icerik: icerikCikar(bilgi),
  });

  let yanit: { durum: number; govde: unknown };
  try {
    yanit = await hj.gonderiOlustur(govde);
  } catch (hata) {
    // Belirsiz (zaman aşımı / bağlantı koptu): gönderi HepsiJet'te açılmış olabilir → yarım kayıt
    // kalmasın diye silmeyi dene (yoksa HepsiJet "bulunamadı" der, zararsız).
    await hj.gonderiSil(barkod).catch(() => {});
    throw hata instanceof HepsijetHatasi ? new KullaniciHatasi(hata.message) : new KullaniciHatasi("HepsiJet'e ulaşılamadı. Tekrar dene.");
  }
  const sonuc = hepsijetSonucu(yanit);
  if (!sonuc.ok) throw new KullaniciHatasi(sonuc.mesaj);

  const zpl = zplBul(yanit.govde);
  if (zpl) kopyaKaydet(barkod, [zpl]);
  const simdi = Date.now();
  await ensureRuntimeSchema();
  const satir = await remotePrisma.cargoShipment.create({
    data: {
      id: `cs_${randomUUID().replace(/-/g, "")}`,
      platform: PLATFORM,
      externalOrderId: siparisKimligi(PLATFORM, girdi.siparisId),
      orderNumber: bilgi.ad,
      carrier: "hepsijet",
      environment: ortam,
      kind: "STD",
      barcode: barkod,
      status: "olusturuldu",
      createdAtMs: simdi,
      updatedAtMs: simdi,
    },
  });
  console.info(`[kargo] HepsiJet gönderisi açıldı: ${bilgi.ad} → ${barkod} (${ortam})`);
  return { gonderi: gonderiOzeti(satir), siparisNo: bilgi.ad, etiketHazir: Boolean(zpl) };
}

/** Kurye almadan önce gönderiyi iptal et (HepsiJet'ten siler). */
export async function kargoGonderisiniIptalEt(barkod: string): Promise<KargoGonderiOzeti> {
  const satir = await barkodlaGonderi(barkod);
  if (!satir) throw new KullaniciHatasi("Gönderi bulunamadı.");
  if (satir.status === "iptal") return gonderiOzeti(satir);
  if (!kargoIptalEdilebilir(gonderiOzeti(satir))) throw new KullaniciHatasi("Kurye paketi aldı, artık iptal edilemez.");
  const { hj } = await hepsijet();
  const yanit = await hj.gonderiSil(barkod).catch(() => {
    throw new KullaniciHatasi("HepsiJet'e ulaşılamadı. Tekrar dene.");
  });
  const sonuc = hepsijetSonucu(yanit);
  const zatenSilinmis = !sonuc.ok && /zaten silinmi/i.test(sonuc.mesaj);
  if (!sonuc.ok && !zatenSilinmis) throw new KullaniciHatasi(sonuc.mesaj);
  const simdi = Date.now();
  const guncel = await remotePrisma.cargoShipment.update({
    where: { barcode: barkod },
    data: { status: "iptal", statusText: null, cancelledAtMs: simdi, updatedAtMs: simdi },
  });
  console.info(`[kargo] HepsiJet gönderisi iptal edildi: ${satir.orderNumber} → ${barkod}`);
  return gonderiOzeti(guncel);
}
