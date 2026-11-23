import { prisma } from "@/lib/prisma";
import { batchWrite } from "@/lib/libsql-batch";
import { bustFinanceCaches } from "@/lib/cache-busting";
import { monthKey, tlToKurus } from "@/lib/monthly-finance";
import { parseDbDate } from "@/core/sqlite-date";
import { recalculateFinanceMonths } from "@/lib/order-finance-snapshots";
import { trendyolTalepSonuclariniOku } from "@/lib/trendyol-iadeleri";
import { trendyolOrderId } from "@/core/trendyol-order-id";
import {
  gecikmeleriFaturalarlaEsle,
  trendyolGecikmesi,
  tyGecikmeFaturalariOku,
  type TyGecikme,
  type TyGecikmeSonucu,
} from "@/core/trendyol-gecikme";
import {
  kusurluIadeleriFaturalarlaEsle,
  tyCezaToplami,
  type TyKusurluSonucu,
} from "@/core/trendyol-kusurlu";
import { trendyolIadeDurumu, type TrendyolPaketIadesi } from "@/core/trendyol-iade";
import type { TrendyolClient, TrendyolOrder } from "@/services/trendyol-client";
// Döngüsel içe aktarma bilerek: yalnız fonksiyon içinde kullanılıyor (modül yüklenirken değil).
import { haftalikFaturalariSakla, kesintiFaturalariniOku } from "@/lib/trendyol-finance";

/**
 * GEÇMİŞ TRENDYOL CEZALARI VE İADE ZARARI — sipariş penceresinin (60 gün) DIŞINA düşmüş siparişler.
 *
 * Siparişler ucu gecikme / kusurlu ürün bedelini ve iade zararını yalnız penceredeki siparişlere
 * yazıyor. Bedel faturası ve iade haftalar sonra geldiği için eski kayıtlar eksik kalıyordu
 * (23 Kas 2026: Ağu–Eki'de 4 gecikme 510 ₺, 4 kusurlu ürün 600 ₺, iade edilen siparişlerde zarar yok).
 *
 *  1. Tazmin faturaları BİR KEZ 200 gün geriye okunur (eski haftalar eşleşebilsin).
 *  2. Gecikme: pencere dışı siparişler Trendyol'dan BİR KEZ okunur; sonrası siparişler ucunun işi
 *     (fatura ~16 günde gelir, sipariş 60 gün pencerede kalır). ⚠️ Eski sipariş ucu tutarsız: aynı
 *     sorgu bazen boş, bazen dolu dönüyor → her pencere yeniden denenir; eksik kalırsa sonraki tur.
 *  3. Kusurlu ürün bedeli ve iade zararı: iade talepleri (150 gün) her turda — tek istek.
 *  4. Değişen kayıtların kârı YALNIZ o siparişler için yeniden hesaplanır.
 */

const GUN_MS = 86_400_000;
/** Gecikme bedeli baremi 27 Tem 2026'da başladı; daha önceki haftaya fatura kesilmemiş (200 gün ölçüldü). */
const GECMIS_BAS = Date.UTC(2026, 6, 20);
const PENCERE_GUN = 60;
const AYAR = "tyCezaGecmisi";

interface GecmisAyari {
  /** Tazmin faturaları 200 gün geriye okundu (an). */
  faturalar?: number;
  /** Pencere dışı gecikme taraması tamamlandı (an). */
  gecikme?: number;
}

/** Kayıtlı satırın bu işin okuduğu kısmı. */
export interface TyGecmisSatiri {
  externalOrderId: string;
  orderedAtMs: number;
  statusKind: string;
  penaltyKurus: number | null;
  delayInfo: string | null;
  returnLossKurus: number | null;
  /** Kalem geçmişindeki toplam adet (tam iade mi diye); bilinmiyorsa null. */
  adet: number | null;
}

export interface TyGecmisGuncellemesi {
  externalOrderId: string;
  orderedAtMs: number;
  penaltyKurus: number | null;
  delayInfo: string | null;
  returnLossKurus: number | null;
}

/** Siparişler ucunun yazdığı gecikme bilgisiyle AYNI biçim. */
function gecikmeMetni(g: TyGecikme, s: TyGecikmeSonucu): string {
  return JSON.stringify({
    sonGun: g.sonGun,
    tolerans: g.tolerans,
    kargolanma: g.kargolanma,
    gecikti: g.gecikti,
    kargolanmadi: g.kargolanmadi,
    ceza: s.ceza,
    durum: s.durum,
  });
}

/** Kayıtlı gecikme bilgisinden kâra giren bedel (TL). */
function gecikmeBedeli(metin: string | null): number {
  if (!metin) return 0;
  try {
    const v = JSON.parse(metin) as { ceza?: unknown; durum?: unknown };
    const ceza = Number(v.ceza);
    return (v.durum === "gercek" || v.durum === "tahmini") && Number.isFinite(ceza) ? ceza : 0;
  } catch {
    return 0;
  }
}

/**
 * SAF: pencere dışı kayıtların yeni ceza / gecikme / iade zararı alanları — yalnız DEĞİŞENLER.
 *  • `gecikmeler` verilmediyse (tarama bu turda yok) kayıtlı gecikme bilgisi korunur.
 *  • Kusurlu talebi bilinmeyen kayıtta kayıtlı kusurlu payı (ceza − gecikme) korunur: talep 150 günü
 *    geçince bilgi kaybolmasın.
 *  • İade zararı: kabul edilmiş TAM iade, zararı hiç hesaplanmamış iptal kaydına 0 işareti konur —
 *    yeniden hesap zararı siparişin kendi kargo/hizmet bedelinden üretir.
 */
export function tyGecmisGuncellemeleri(
  satirlar: readonly TyGecmisSatiri[],
  girdi: {
    pencereBas: number;
    gecikmeler: ReadonlyMap<string, { g: TyGecikme; s: TyGecikmeSonucu }> | null;
    kusurlular: ReadonlyMap<string, TyKusurluSonucu>;
    iadeler: ReadonlyMap<string, TrendyolPaketIadesi>;
  }
): TyGecmisGuncellemesi[] {
  const sonuc: TyGecmisGuncellemesi[] = [];
  for (const r of satirlar) {
    if (!(r.orderedAtMs < girdi.pencereBas)) continue;
    const gecikme = girdi.gecikmeler?.get(r.externalOrderId);
    const delayInfo = gecikme ? gecikmeMetni(gecikme.g, gecikme.s) : r.delayInfo;
    const eskiKusurlu = Math.max(0, (r.penaltyKurus ?? 0) / 100 - gecikmeBedeli(r.delayInfo));
    const kusurlu = girdi.kusurlular.get(r.externalOrderId)?.ceza ?? eskiKusurlu;
    const toplam = tyCezaToplami(gecikmeBedeli(delayInfo), kusurlu);
    const penaltyKurus = toplam > 0 ? tlToKurus(toplam) : r.penaltyKurus == null ? null : 0;
    const tamIade =
      r.statusKind === "cancelled" &&
      r.adet != null &&
      trendyolIadeDurumu(r.adet, girdi.iadeler.get(r.externalOrderId)) === "tam";
    const returnLossKurus = r.returnLossKurus == null && tamIade ? 0 : r.returnLossKurus;
    if (
      penaltyKurus !== r.penaltyKurus ||
      (delayInfo ?? null) !== (r.delayInfo ?? null) ||
      returnLossKurus !== r.returnLossKurus
    ) {
      sonuc.push({ externalOrderId: r.externalOrderId, orderedAtMs: r.orderedAtMs, penaltyKurus, delayInfo, returnLossKurus });
    }
  }
  return sonuc;
}

async function ayarOku(): Promise<GecmisAyari> {
  const s = await prisma.appSetting.findUnique({ where: { key: AYAR } });
  try {
    return s?.value ? (JSON.parse(s.value) as GecmisAyari) : {};
  } catch {
    return {};
  }
}

async function ayarYaz(v: GecmisAyari): Promise<void> {
  const value = JSON.stringify(v);
  await prisma.appSetting.upsert({ where: { key: AYAR }, update: { value }, create: { key: AYAR, value } });
}

const bekle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Bir sipariş sayfasını tutarsız uca karşı yeniden deneyerek al. `bosKabul` = sayfanın boş gelmesi
 * meşru mu (ilk sayfada toplam 0 olabilir; sonraki sayfalar dolu olmalı).
 */
async function sayfaAl(
  client: TrendyolClient,
  q: { startDate: number; endDate: number; page: number },
  doluOlmali: boolean
): Promise<{ icerik: TrendyolOrder[]; toplam: number } | null> {
  for (let deneme = 0; deneme < 6; deneme++) {
    const y = await client.listOrders({ ...q, size: 100, orderByField: null });
    const icerik = y.content ?? [];
    const toplam = Number(y.totalElements ?? icerik.length);
    if (icerik.length > 0 || (!doluOlmali && deneme >= 2 && toplam === 0)) return { icerik, toplam };
    await bekle(400 + deneme * 300);
  }
  return null;
}

/**
 * Pencere dışı siparişlerin gecikmesi (paket → gecikme). Bir pencere eksik kalırsa null — eksik veriyle
 * haftalık eşleştirme yanlış "kesilmedi" üretebilirdi.
 */
async function eskiGecikmeleriOku(
  client: TrendyolClient,
  bas: number,
  bit: number,
  an: number
): Promise<Map<string, TyGecikme> | null> {
  const sonuc = new Map<string, TyGecikme>();
  for (let s = bas; s < bit; s += 7 * GUN_MS) {
    const e = Math.min(bit, s + 7 * GUN_MS) - 1;
    const ilk = await sayfaAl(client, { startDate: s, endDate: e, page: 0 }, false);
    if (!ilk) return null;
    const sayfaSayisi = Math.ceil(ilk.toplam / 100);
    const paketler = [...ilk.icerik];
    for (let p = 1; p < sayfaSayisi && p < 50; p++) {
      const y = await sayfaAl(client, { startDate: s, endDate: e, page: p }, true);
      if (!y) return null;
      paketler.push(...y.icerik);
    }
    if (paketler.length < ilk.toplam) return null;
    for (const [i, o] of paketler.entries()) {
      const g = trendyolGecikmesi(o, an);
      if (g) sonuc.set(trendyolOrderId(o, `${s}-${i}`), g);
    }
  }
  return sonuc;
}

/** Kayıtlı satırlar (yalnız istenen kimlikler) + tam iade için kalem adetleri. */
async function satirlariOku(kimlikler: string[]): Promise<TyGecmisSatiri[]> {
  const satirlar: TyGecmisSatiri[] = [];
  for (let i = 0; i < kimlikler.length; i += 200) {
    const parca = kimlikler.slice(i, i + 200);
    const yer = parca.map(() => "?").join(",");
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "externalOrderId", "orderedAt", "statusKind", "penaltyKurus", "delayInfo", "returnLossKurus"
         FROM "OrderFinanceSnapshot" WHERE "platform" = 'trendyol' AND "externalOrderId" IN (${yer})`,
      ...parca
    );
    const iptal = rows.filter((r) => r.statusKind === "cancelled" && r.returnLossKurus == null).map((r) => String(r.externalOrderId));
    const adetler = new Map<string, number>();
    if (iptal.length > 0) {
      const a = await prisma.$queryRawUnsafe<Array<{ externalOrderId: string; adet: unknown }>>(
        `SELECT "externalOrderId", SUM("quantity") AS "adet" FROM "OrderItemSnapshot"
          WHERE "platform" = 'trendyol' AND "externalOrderId" IN (${iptal.map(() => "?").join(",")})
          GROUP BY "externalOrderId"`,
        ...iptal
      );
      for (const r of a) adetler.set(String(r.externalOrderId), Number(r.adet));
    }
    for (const r of rows) {
      const tarih = parseDbDate(r.orderedAt);
      if (!tarih) continue;
      const id = String(r.externalOrderId);
      satirlar.push({
        externalOrderId: id,
        orderedAtMs: tarih.getTime(),
        statusKind: String(r.statusKind),
        penaltyKurus: r.penaltyKurus == null ? null : Number(r.penaltyKurus),
        delayInfo: r.delayInfo == null ? null : String(r.delayInfo),
        returnLossKurus: r.returnLossKurus == null ? null : Number(r.returnLossKurus),
        adet: adetler.has(id) ? adetler.get(id)! : null,
      });
    }
  }
  return satirlar;
}

/**
 * Finans turundan çağrılır (3 saatte bir). Hata FIRLATMAZ: komisyon/kargo işlemesini bozamaz.
 * Döndürdüğü sayı alanları güncellenen kayıt adedidir.
 */
export async function tyCezaGecmisiniIsle(client: TrendyolClient): Promise<number> {
  try {
    const an = Date.now();
    const pencereBas = (Math.floor(an / GUN_MS) - PENCERE_GUN) * GUN_MS;
    const ayar = await ayarOku();

    // 1. Tazmin faturaları — bir kez 200 gün geriye (finans turu yalnız son 60 günü okuyor).
    if (!ayar.faturalar) {
      const bas = an - 200 * GUN_MS;
      const f = await kesintiFaturalariniOku(client, bas, an);
      await haftalikFaturalariSakla("tyGecikmeFaturalari", f.gecikme, bas, an);
      await haftalikFaturalariSakla("tyKusurluFaturalari", f.kusurlu, bas, an);
      ayar.faturalar = an;
      await ayarYaz(ayar);
    }
    const ayarlar = Object.fromEntries(
      (await prisma.appSetting.findMany({ where: { key: { in: ["tyGecikmeFaturalari", "tyKusurluFaturalari"] } } })).map(
        (s) => [s.key, s.value]
      )
    );

    // 2. Pencere dışı gecikmeler — bir kez. Haftalar eksik kalmasın diye pencereye iki hafta taşar.
    let gecikmeler: Map<string, { g: TyGecikme; s: TyGecikmeSonucu }> | null = null;
    if (!ayar.gecikme) {
      const bas = Math.max(GECMIS_BAS, an - 150 * GUN_MS);
      const okunan = bas < pencereBas ? await eskiGecikmeleriOku(client, bas, pencereBas + 14 * GUN_MS, an) : new Map();
      if (okunan) {
        const eslesme = gecikmeleriFaturalarlaEsle(
          [...okunan].map(([id, g]) => ({ id, g })),
          tyGecikmeFaturalariOku(ayarlar.tyGecikmeFaturalari),
          an
        );
        gecikmeler = new Map(
          [...okunan].flatMap(([id, g]) => {
            const s = eslesme.get(id);
            return s ? [[id, { g, s }] as const] : [];
          })
        );
      } else {
        console.warn("[ty-ceza-gecmisi] eski siparişler eksik geldi; gecikme taraması sonraki turda");
      }
    }

    // 3. Kusurlu ürün bedeli + iade zararı — iade taleplerinden (150 gün).
    const { iadeler, kusurlular } = await trendyolTalepSonuclariniOku(client);
    const kusurluSonuclari = kusurluIadeleriFaturalarlaEsle(
      kusurlular,
      tyGecikmeFaturalariOku(ayarlar.tyKusurluFaturalari),
      an
    );

    const kimlikler = [...new Set([...(gecikmeler?.keys() ?? []), ...kusurlular.keys(), ...iadeler.keys()])];
    const guncellemeler =
      kimlikler.length === 0
        ? []
        : tyGecmisGuncellemeleri(await satirlariOku(kimlikler), {
            pencereBas,
            gecikmeler,
            kusurlular: kusurluSonuclari,
            iadeler,
          });

    if (guncellemeler.length > 0) {
      const ifadeler = guncellemeler.map((u) => ({
        sql: `UPDATE "OrderFinanceSnapshot" SET "penaltyKurus" = ?, "delayInfo" = ?, "returnLossKurus" = ?
               WHERE "platform" = 'trendyol' AND "externalOrderId" = ?`,
        args: [u.penaltyKurus, u.delayInfo, u.returnLossKurus, u.externalOrderId],
      }));
      if (!(await batchWrite(ifadeler))) {
        for (const f of ifadeler) await prisma.$executeRawUnsafe(f.sql, ...(f.args as never[]));
      }
      // Kâr yalnız bu siparişler için yeniden hesaplanır (yeni ceza + iade zararı kâra girsin).
      await recalculateFinanceMonths(
        [...new Set(guncellemeler.map((u) => monthKey(new Date(u.orderedAtMs))))],
        { yalnizSiparisler: guncellemeler.map((u) => ({ platform: "trendyol", externalOrderId: u.externalOrderId })) }
      );
      bustFinanceCaches();
    }

    if (gecikmeler) {
      ayar.gecikme = an;
      await ayarYaz(ayar);
    }
    return guncellemeler.length;
  } catch (hata) {
    console.warn("[ty-ceza-gecmisi] işlenemedi:", hata instanceof Error ? hata.message : hata);
    return 0;
  }
}
