import os from "node:os";
import { remotePrisma } from "@/lib/prisma";
import {
  hepsijetTakipAdresi,
  hepsijetTakipCoz,
  kargoOlaylariOku,
  kargoSonDurumMu,
  kuryeAldiMi,
  type CozulenTakip,
} from "@/core/kargo-gonderisi";
import { HepsijetClient } from "@/services/hepsijet-client";
import { hepsijetKimligi } from "@/services/hepsijet-settings";
import { ShopifyClient } from "@/services/shopify-client";
import { getShopifyCredentials } from "@/services/shopify-settings";
import { takiptekiGonderiler, type GonderiSatiri } from "./kargo-gonderileri";

/**
 * KARGO TAKİBİ — uygulamadan açılan HepsiJet gönderilerinin durumunu çeker ve Shopify'ı
 * Berke'nin elle yaptığı gibi işaretler (onay 19 Kas 2026):
 *  • Kurye paketi alınca (ACCEPTED ve sonrası) → Shopify'da gönderim: takip no = barkod, şirket
 *    "Other", HepsiJet takip bağlantısı, müşteriye bildirim AÇIK.
 *  • HepsiJet "teslim edildi" deyince → gönderime DELIVERED olayı.
 *  • TEST ORTAMI gönderisi Shopify'a ASLA yazılmaz (gerçek müşteriye sahte takip maili gitmesin).
 *
 * Mac ve Windows aynı anda açık olabilir: Shopify adımı satırı koşullu güncellemeyle SAHİPLENEREK
 * yapılır (çift gönderim açılmasın). Durum yazımı yalnız değişen satıra yapılır.
 */

const TUR_ARALIGI_MS = 10 * 60_000;
const ILK_GECIKME_MS = 2 * 60_000;
const DILIM = 50;
const SAHIPLIK_OMRU_MS = 10 * 60_000;
/** Shopify'a bilerek yazılmayan gönderi (başka takip numarasıyla zaten gönderilmiş vb.). */
export const SHOPIFY_ATLA = "atla";

const g = globalThis as unknown as { __MLHUB_KARGO_TAKIP__?: boolean; __MLHUB_KARGO_TURU__?: Promise<KargoTuruSonucu> };

export function startKargoTakibi(): void {
  if (g.__MLHUB_KARGO_TAKIP__) return;
  g.__MLHUB_KARGO_TAKIP__ = true;
  const calistir = () => void kargoTakibiTuru().catch(() => {});
  setTimeout(() => {
    calistir();
    setInterval(calistir, TUR_ARALIGI_MS);
  }, ILK_GECIKME_MS);
}

export interface KargoTuruSonucu {
  sorgulanan: number;
  degisen: number;
  shopifyGonderildi: number;
  shopifyTeslim: number;
}

/** Tek tur (aynı anda ikinci tur başlamaz; çağıran süren turu bekler). */
export function kargoTakibiTuru(): Promise<KargoTuruSonucu> {
  if (g.__MLHUB_KARGO_TURU__) return g.__MLHUB_KARGO_TURU__;
  const is = tur().finally(() => {
    g.__MLHUB_KARGO_TURU__ = undefined;
  });
  g.__MLHUB_KARGO_TURU__ = is;
  return is;
}

async function tur(): Promise<KargoTuruSonucu> {
  const sonuc: KargoTuruSonucu = { sorgulanan: 0, degisen: 0, shopifyGonderildi: 0, shopifyTeslim: 0 };
  const satirlar = await takiptekiGonderiler();
  if (satirlar.length === 0) return sonuc;

  let kimlik;
  try {
    kimlik = await hepsijetKimligi();
  } catch {
    return sonuc; // HepsiJet kurulu değil
  }
  // Yalnız şu an seçili ortamın gönderileri sorgulanabilir (öbürünün oturumu yok).
  const izlenecek = satirlar.filter((s) => s.environment === kimlik.ortam && !kargoSonDurumMu(s.status));
  const hj = new HepsijetClient(kimlik);
  const guncel = new Map(satirlar.map((s) => [s.barcode, s]));
  for (let i = 0; i < izlenecek.length; i += DILIM) {
    const dilim = izlenecek.slice(i, i + DILIM);
    const cozulen = hepsijetTakipCoz(await hj.takip(dilim.map((s) => s.barcode)));
    sonuc.sorgulanan += dilim.length;
    for (const s of dilim) {
      const t = cozulen.get(s.barcode);
      if (!t) continue; // kurye henüz almadı → "olusturuldu" kalır
      const yeni = await durumuYaz(s, t);
      if (yeni) {
        guncel.set(s.barcode, yeni);
        sonuc.degisen++;
      }
    }
  }

  // Shopify adımları — yalnız CANLI ortamın standart gönderileri.
  const shopifyIsi = [...guncel.values()].filter(
    (s) => s.environment === "prod" && s.kind === "STD" && s.platform === "shopify" && s.shopifyFulfillmentId !== SHOPIFY_ATLA &&
      ((kuryeAldiMi(s.status) && !gercekGonderimMi(s.shopifyFulfillmentId)) ||
        (s.status === "teslim" && gercekGonderimMi(s.shopifyFulfillmentId) && s.shopifyDeliveredAtMs == null))
  );
  if (shopifyIsi.length === 0) return sonuc;
  let shopify: ShopifyClient;
  try {
    shopify = new ShopifyClient(await getShopifyCredentials());
  } catch {
    return sonuc;
  }
  for (const s of shopifyIsi) {
    try {
      if (!gercekGonderimMi(s.shopifyFulfillmentId)) {
        if (await shopifyGonderildiIsaretle(shopify, s)) sonuc.shopifyGonderildi++;
      } else if (await shopifyTeslimIsaretle(shopify, s)) {
        sonuc.shopifyTeslim++;
      }
    } catch {
      /* satır bazında; sonraki tur yeniden dener */
    }
  }
  return sonuc;
}

function gercekGonderimMi(id: string | null | undefined): id is string {
  return Boolean(id?.startsWith("gid://"));
}

/** Değiştiyse yazar ve yeni satırı döner; değişmediyse null. */
async function durumuYaz(s: GonderiSatiri, t: CozulenTakip): Promise<GonderiSatiri | null> {
  const eskiOlaylar = kargoOlaylariOku(s.eventsJson);
  const olaylar = t.olaylar.length >= eskiOlaylar.length ? t.olaylar : eskiOlaylar;
  const eventsJson = JSON.stringify(olaylar);
  if (s.status === t.durum && s.statusText === t.metin && s.carrierStatus === t.ham && (s.eventsJson ?? "[]") === eventsJson) {
    return null;
  }
  return remotePrisma.cargoShipment.update({
    where: { barcode: s.barcode },
    data: {
      status: t.durum,
      statusText: t.metin,
      carrierStatus: t.ham,
      lastEventAtMs: t.sonOlayAni ?? s.lastEventAtMs,
      lastCheckedAtMs: Date.now(),
      eventsJson,
      updatedAtMs: Date.now(),
    },
  });
}

function shopifyGid(externalOrderId: string): string {
  return `gid://shopify/Order/${externalOrderId.replace(/^sh-/, "")}`;
}

/** Satırı bu bilgisayar adına sahiplen (Shopify adımı tek makinede yapılsın). */
async function sahiplen(s: GonderiSatiri): Promise<boolean> {
  const simdi = Date.now();
  const etiket = `sahip:${os.hostname()}:${simdi}`;
  // Çökmüş bir sahiplik (10 dk'dan eski) serbest bırakılır.
  const eski = s.shopifyFulfillmentId?.startsWith("sahip:") ? Number(s.shopifyFulfillmentId.split(":").at(-1)) : null;
  const where =
    eski != null && Number.isFinite(eski) && simdi - eski > SAHIPLIK_OMRU_MS
      ? { barcode: s.barcode, shopifyFulfillmentId: s.shopifyFulfillmentId }
      : { barcode: s.barcode, shopifyFulfillmentId: null };
  const r = await remotePrisma.cargoShipment.updateMany({ where, data: { shopifyFulfillmentId: etiket } });
  return r.count === 1;
}

async function shopifyGonderildiIsaretle(shopify: ShopifyClient, s: GonderiSatiri): Promise<boolean> {
  if (!(await sahiplen(s))) return false;
  const birak = (hata: string | null, id: string | null = null, ek: Partial<GonderiSatiri> = {}) =>
    remotePrisma.cargoShipment.update({
      where: { barcode: s.barcode },
      data: { shopifyFulfillmentId: id, shopifyError: hata, updatedAtMs: Date.now(), ...ek },
    });
  try {
    const bilgi = await shopify.kargoBilgisi(shopifyGid(s.externalOrderId));
    if (!bilgi) {
      await birak("Sipariş Shopify'da bulunamadı.", SHOPIFY_ATLA);
      return false;
    }
    // Berke aynı barkodla elle işaretlediyse onu benimse.
    const ayni = bilgi.gonderimler.find((x) => x.takipNo?.trim() === s.barcode);
    if (ayni) {
      await birak(null, ayni.id, { shopifyShippedAtMs: Date.now() });
      return true;
    }
    if (bilgi.acikGonderimEmirleri.length === 0) {
      await birak(
        bilgi.iptal ? "Sipariş Shopify'da iptal edilmiş." : "Shopify'da başka takip numarasıyla gönderilmiş.",
        SHOPIFY_ATLA
      );
      return false;
    }
    const id = await shopify.gonderimAc({
      gonderimEmirleri: bilgi.acikGonderimEmirleri,
      takipNo: s.barcode,
      takipUrl: hepsijetTakipAdresi(s.barcode),
      musteriyeBildir: true,
    });
    await birak(null, id, { shopifyShippedAtMs: Date.now() });
    console.info(`[kargo] Shopify'da gönderildi işaretlendi: ${s.orderNumber} → ${s.barcode}`);
    return true;
  } catch (hata) {
    await birak("Shopify'a yazılamadı, tekrar denenecek.").catch(() => {});
    console.error(`[kargo] Shopify gönderim işareti başarısız (${s.orderNumber}):`, hata instanceof Error ? hata.message : hata);
    return false;
  }
}

async function shopifyTeslimIsaretle(shopify: ShopifyClient, s: GonderiSatiri): Promise<boolean> {
  const id = s.shopifyFulfillmentId as string;
  try {
    await shopify.teslimEdildiIsaretle(id, new Date(s.lastEventAtMs ?? Date.now()));
  } catch (hata) {
    // Zaten teslim işaretliyse Shopify yine hata verebilir → durumu sorup karar ver.
    const bilgi = await shopify.kargoBilgisi(shopifyGid(s.externalOrderId)).catch(() => null);
    const zaten = bilgi?.gonderimler.find((x) => x.id === id)?.teslimEdildi === true;
    if (!zaten) {
      await remotePrisma.cargoShipment.update({
        where: { barcode: s.barcode },
        data: { shopifyError: "Teslim işareti Shopify'a yazılamadı, tekrar denenecek.", updatedAtMs: Date.now() },
      });
      console.error(`[kargo] Shopify teslim işareti başarısız (${s.orderNumber}):`, hata instanceof Error ? hata.message : hata);
      return false;
    }
  }
  await remotePrisma.cargoShipment.update({
    where: { barcode: s.barcode },
    data: { shopifyDeliveredAtMs: Date.now(), shopifyError: null, updatedAtMs: Date.now() },
  });
  console.info(`[kargo] Shopify'da teslim edildi işaretlendi: ${s.orderNumber}`);
  return true;
}
