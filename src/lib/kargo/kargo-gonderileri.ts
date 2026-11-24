import { remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { siparisKimligi } from "@/core/order-line-cost";
import {
  KARGO_DURUM_ETIKETI,
  kargoOlaylariOku,
  type KargoDurumu,
  type KargoGonderiOzeti,
} from "@/core/kargo-gonderisi";

/**
 * KARGO GÖNDERİSİ KAYITLARI (`CargoShipment`). Uzak bağlantı (`remotePrisma`): Mac ve Windows
 * aynı anda açık olabilir, ikisi de gönderi açabilir; takip turu da kaydı koşullu günceller.
 * Telefon aynı tabloyu doğrudan okur.
 */

export type GonderiSatiri = Awaited<ReturnType<typeof remotePrisma.cargoShipment.findFirstOrThrow>>;

const DURUMLAR = new Set(Object.keys(KARGO_DURUM_ETIKETI));

export function gonderiOzeti(s: GonderiSatiri): KargoGonderiOzeti {
  const durum = (DURUMLAR.has(s.status) ? s.status : "olusturuldu") as KargoDurumu;
  return {
    barkod: s.barcode,
    firma: "hepsijet",
    ortam: s.environment === "prod" ? "prod" : "test",
    durum,
    metin: s.statusText?.trim() || KARGO_DURUM_ETIKETI[durum],
    olusturmaAni: s.createdAtMs,
    sonOlayAni: s.lastEventAtMs ?? null,
    olaylar: kargoOlaylariOku(s.eventsJson),
    shopifyGonderildi: s.shopifyShippedAtMs ?? null,
    shopifyTeslim: s.shopifyDeliveredAtMs ?? null,
    shopifyHata: s.shopifyError ?? null,
  };
}

/**
 * Siparişlerin GÜNCEL gönderisi (sipariş kimliği → özet). İptal edilen gönderi, yerine yenisi
 * açılmadıysa yine döner (ekranda "İptal edildi" görünür, yeniden oluşturulabilir).
 */
export async function siparislerinGonderileri(platform: string, siparisIdleri: string[]): Promise<Map<string, KargoGonderiOzeti>> {
  const sonuc = new Map<string, KargoGonderiOzeti>();
  if (siparisIdleri.length === 0) return sonuc;
  await ensureRuntimeSchema();
  const kanonik = new Map(siparisIdleri.map((id) => [siparisKimligi(platform, id), id]));
  const satirlar = await remotePrisma.cargoShipment.findMany({
    where: { platform, externalOrderId: { in: [...kanonik.keys()] } },
    orderBy: { createdAtMs: "asc" },
  });
  const secilen = new Map<string, GonderiSatiri>();
  for (const s of satirlar) {
    const onceki = secilen.get(s.externalOrderId);
    // İptal edilmemiş olan önceliklidir; ikisi de aynıysa en yenisi.
    if (!onceki || onceki.status === "iptal" || s.status !== "iptal") secilen.set(s.externalOrderId, s);
  }
  for (const [kimlik, s] of secilen) {
    const id = kanonik.get(kimlik);
    if (id) sonuc.set(id, gonderiOzeti(s));
  }
  return sonuc;
}

/**
 * Son 90 günün gönderileri, kanonik sipariş kimliği ("sh-<no>") → güncel gönderi. Siparişler
 * ekranı bunu ayrı ve sık okur (sipariş listesi önbellekli; kargo durumu canlı kalmalı).
 */
export async function sonGonderiler(platform: string, simdi = Date.now()): Promise<Record<string, KargoGonderiOzeti>> {
  await ensureRuntimeSchema();
  const satirlar = await remotePrisma.cargoShipment.findMany({
    where: { platform, createdAtMs: { gt: simdi - 90 * 24 * 60 * 60_000 } },
    orderBy: { createdAtMs: "asc" },
  });
  const secilen = new Map<string, GonderiSatiri>();
  for (const s of satirlar) {
    const onceki = secilen.get(s.externalOrderId);
    if (!onceki || onceki.status === "iptal" || s.status !== "iptal") secilen.set(s.externalOrderId, s);
  }
  return Object.fromEntries([...secilen].map(([k, s]) => [k, gonderiOzeti(s)]));
}

/** Siparişin iptal edilmemiş gönderisi (yeni gönderi açmayı engeller). */
export async function siparisinAcikGonderisi(platform: string, siparisId: string): Promise<GonderiSatiri | null> {
  await ensureRuntimeSchema();
  return remotePrisma.cargoShipment.findFirst({
    where: { platform, externalOrderId: siparisKimligi(platform, siparisId), status: { not: "iptal" } },
    orderBy: { createdAtMs: "desc" },
  });
}

export async function barkodlaGonderi(barkod: string): Promise<GonderiSatiri | null> {
  await ensureRuntimeSchema();
  return remotePrisma.cargoShipment.findUnique({ where: { barcode: barkod } });
}

/** Takip edilecek gönderiler: bitmemiş ve 60 günden yeni. */
export async function takiptekiGonderiler(simdi = Date.now()): Promise<GonderiSatiri[]> {
  await ensureRuntimeSchema();
  return remotePrisma.cargoShipment.findMany({
    where: { status: { notIn: ["iptal"] }, createdAtMs: { gt: simdi - 60 * 24 * 60 * 60_000 } },
    orderBy: { createdAtMs: "asc" },
  });
}
