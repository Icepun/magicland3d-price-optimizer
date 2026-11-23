import { prisma } from "@/lib/prisma";
import {
  TUM_PLATFORMLAR,
  reklamOrani,
  reklamOraniIcin,
  donemGunSayisi,
  type DonemliButce,
} from "@/core/ad-cost";
import { dbEpochMs, parseDbDate } from "@/lib/sqlite-date";
import { monthKey } from "@/lib/monthly-finance";

/**
 * REKLAM ORANI SERVİSİ — her bütçe DÖNEMİNİ kendi cirosuna oranlar.
 *
 * Çekirdek (`core/ad-cost.ts`) saf matematiktir; ciroyu bilmez. Burası ciroyu veritabanından
 * okur ve her dönemin oranını o dönemin kaydına yazar.
 *
 * ⚠️ NEDEN DÖNEM BAŞINA: önce tek bir "son 30 gün" oranı hesaplanıp geçmiş dönemler ona göre
 * ölçekleniyordu. Pencere her gün kaydığı için GEÇMİŞ siparişlerin kârı da her gün kayıyordu
 * (ölçüldü: aynı Ağustos siparişi, bugünkü ciro seviyesine göre 120 ₺ ya da 300 ₺ reklam payı
 * — 2,5 kat fark). Artık kapanmış dönemin oranı sabittir: kendi başlangıç–bitişi arasındaki
 * gerçek ciroya bölünür ve bir daha oynamaz.
 *
 * ⚠️ ÖNBELLEK ŞART: uzak Turso'da her sorgu ~96ms ve süreç genelinde SIRALI. Oran sipariş
 * listesinde her sipariş için gerekiyor; önbelleksiz yüzlerce sorgu ederdi.
 *
 * ⚠️ OKUNAMAZSA "BİLİNMİYOR" (denetim, 23 Kas 2026): eskiden hata boş bütçe (oran 0) sayılıp
 * 5 dakika önbellekte tutuluyordu. O sürede yeniden hesap bütün ayları reklamsız yazıyor, ilk kez
 * kaydedilen siparişler reklamsız donuyordu. Artık hata `bilinmiyor: true` döner, önbelleğe
 * GİRMEZ (sonraki çağrı yeniden dener); kâr yazan yollar bu durumda o turu yazmadan bırakır.
 */

const TTL_MS = 5 * 60_000;
/** Son okuma hatasından sonra kâr yazımlarının bekleyeceği süre (sipariş ekranı dakikada bir tazeler). */
const HATA_BEKLEME_MS = 2 * 60_000;

export interface AdSnapshot {
  at: number;
  /** Oranı doldurulmuş bütçe kayıtları. */
  butceler: DonemliButce[];
  /** Arayüz önizlemesi için platform → bugünkü dönemin oran bilgisi. */
  bugun: Map<string, { oran: number; toplamHarcama: number; guvenilir: boolean; cirodanBuyuk: boolean }>;
  /**
   * true = reklam bütçesi OKUNAMADI. Oran 0 DEĞİL, bilinmiyor: canlı ekranlar reklamsız
   * gösterebilir ama kâr YAZAN hiçbir yol (yeniden hesap, ilk yakalama) bu turda yazmamalı.
   */
  bilinmiyor?: boolean;
}

interface Durum {
  v: AdSnapshot | null;
  /** Son okuma hatasının anı (ms) — kâr yazımları bu süre boyunca bekler. */
  sonHataMs: number | null;
  /** Her `bustAdRateCache()` artırır: bütçe değişirken süren eski okuma önbelleğe yazılmasın. */
  nesil: number;
}

// Süreç geneli: instrumentation (relay) ile rotalar ayrı paketlere derleniyor; modül
// kapsamında tutulsaydı iki ayrı önbellek doğar ve sorgu iki katına çıkardı.
const g = globalThis as unknown as Record<string, unknown>;
function kayit(): Durum {
  const anahtar = "__mlhub_adRateCache";
  if (!(anahtar in g)) g[anahtar] = { v: null, sonHataMs: null, nesil: 0 };
  const d = g[anahtar] as Partial<Durum>;
  // Eski biçimli kayıt (yalnız `v`) — sıcak yeniden yüklemede eksik alanlar tamamlanır.
  d.sonHataMs ??= null;
  d.nesil ??= 0;
  return d as Durum;
}

/** Önbelleği at — bütçe eklenince/değişince çağrılır. */
export function bustAdRateCache(): void {
  const d = kayit();
  d.v = null;
  d.nesil += 1;
}

const BOS = (at: number): AdSnapshot => ({ at, butceler: [], bugun: new Map() });

/**
 * Reklam bütçesi yakın zamanda OKUNAMADI mı? Kâr yazan yollar (ilk yakalama) bu durumda turu
 * atlar; sipariş ekranı bir sonraki turda yeniden dener.
 *
 * NEDEN ZAMAN PENCERESİ: sipariş listesi oranı bir kez okuyup yüzlerce siparişi hesaplıyor ve
 * yazımı sonra kuyruğa atıyor. Arada başka bir isteğin okuması başarılı olsa bile BU listenin
 * kârları reklamsız hesaplanmıştır; "son okuma başarılı mı" sorusu bunu kaçırırdı.
 */
export function reklamOraniYakindaOkunamadi(simdiMs = Date.now()): boolean {
  const { sonHataMs } = kayit();
  return sonHataMs != null && simdiMs - sonHataMs < HATA_BEKLEME_MS;
}

export async function adRateSnapshot(): Promise<AdSnapshot> {
  const k = kayit();
  const simdi = Date.now();
  if (k.v && simdi - k.v.at < TTL_MS) return k.v;
  const baslangicNesli = k.nesil;
  /** Yalnız okuma sürerken bütçe DEĞİŞMEDİYSE önbelleğe yazılır. */
  const sakla = (snap: AdSnapshot): AdSnapshot => {
    if (k.nesil === baslangicNesli) k.v = snap;
    return snap;
  };

  try {
    // HAM SQL + `dbEpochMs`: dönem tarihleri telefonda `…Z`, masaüstünde `+00:00` biçiminde
    // yazılıyor; tarih kolonunu biçimden bağımsız sayıya çevirip okumak telefonun okumasıyla aynı.
    const kayitlar = (
      await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT "platform","dailyAmount",${dbEpochMs("validFrom")} AS "bas",${dbEpochMs("validTo")} AS "bit"
           FROM "AdBudget" WHERE "isActive" = 1`
      )
    ).map((r) => ({
      platform: String(r.platform ?? ""),
      dailyAmount: Number(r.dailyAmount) || 0,
      validFrom: r.bas == null ? null : Number(r.bas),
      validTo: r.bit == null ? null : Number(r.bit),
    }));
    if (kayitlar.length === 0) return sakla(BOS(simdi));

    const butceler: DonemliButce[] = [];
    const bugun: AdSnapshot["bugun"] = new Map();
    const ms = dbEpochMs("orderedAt");

    for (const b of kayitlar) {
      if (b.validFrom == null || !Number.isFinite(b.validFrom)) continue; // tarihsiz dönem eşleşemez
      const basMs = b.validFrom;
      const bitMs = b.validTo ?? simdi;
      // Dönemin KENDİ cirosu — iptal/iade hariç (ciro getirmediler, pay da taşımazlar).
      /**
       * PAYDA: "tüm platformlar" bütçesinde TOPLAM ciro, platform bütçesinde o platformun
       * cirosu. Marka reklamı tüm satışları besliyor; paydasını tek kanala daraltmak o kanalı
       * haksız yere ezerdi (ölçüldü: yalnız Shopify'a yüklenince oran %39,9, tümüne
       * yayılınca %18,1).
       *
       * Tarih karşılaştırması `dbEpochMs` ile: kolonda ISO metin ve epoch-ms sayı karışık
       * bulunabilir; düz `orderedAt >= ?` uyumsuz tipteki satırları sessizce eler (telefonun
       * aynı sorgusu da böyle).
       */
      const tumu = b.platform === TUM_PLATFORMLAR;
      const satir = await prisma.$queryRawUnsafe<{ ciro: number }[]>(
        `SELECT COALESCE(SUM(revenueKurus), 0) / 100.0 AS ciro
           FROM OrderFinanceSnapshot
          WHERE ${ms} >= ? AND ${ms} <= ?
            AND (statusKind IS NULL OR statusKind <> 'cancelled')
            ${tumu ? "" : "AND platform = ?"}`,
        ...(tumu ? [basMs, bitMs] : [basMs, bitMs, b.platform])
      );
      const ciro = Number(satir?.[0]?.ciro) || 0;
      const gun = donemGunSayisi(b.validFrom, b.validTo, simdi);
      const o = reklamOrani({ gunlukTutar: b.dailyAmount, gunSayisi: gun, pencereCirosu: ciro });

      butceler.push({
        platform: b.platform,
        dailyAmount: b.dailyAmount,
        validFrom: b.validFrom,
        validTo: b.validTo,
        isActive: true,
        oran: o.oran,
      });

      // Bugün yürürlükte olan dönem → arayüz önizlemesi.
      const yururlukBitis = b.validTo ?? Infinity;
      if (simdi >= basMs && simdi <= yururlukBitis) {
        bugun.set(b.platform, {
          oran: o.oran,
          toplamHarcama: o.toplamHarcama,
          guvenilir: o.guvenilir,
          cirodanBuyuk: o.cirodanBuyuk,
        });
      }
    }

    return sakla({ at: simdi, butceler, bugun });
  } catch (error) {
    // Reklam oranı okunamadı: sipariş listesi DÜŞMESİN (canlı ekran reklamsız gösterebilir) ama
    // sonuç "bilinmiyor" işaretlenir ve ÖNBELLEĞE GİRMEZ — bir sonraki çağrı yeniden dener.
    console.warn("[reklam-orani] okunamadı:", error instanceof Error ? error.message : error);
    k.sonHataMs = Date.now();
    return { ...BOS(simdi), bilinmiyor: true };
  }
}

/** Bir siparişin reklam oranı — platformu ve KENDİ tarihiyle (çekirdek karar verir). */
export function adRateFor(
  snapshot: AdSnapshot,
  platform: string,
  orderedAt: Date | null | undefined
): number {
  return reklamOraniIcin(snapshot.butceler, platform, orderedAt ? orderedAt.getTime() : Date.now());
}

/* ─────────────── Bütçe değişince: yalnız etkilenen siparişleri yeniden hesapla ─────────────── */

/** Bütçe değişikliğinin kâra dokunduğu aralık (dahil) ve platform ("all" = hepsi). */
export interface ReklamEtkiAraligi {
  basMs: number;
  bitMs: number;
  platform: string;
}

/**
 * Aralıktaki (manuel olmayan) siparişler ve ayları — ay sınırları İSTANBUL saatiyle.
 * Eskiden ay listesi UTC ile kuruluyor ve ayın TAMAMI yeniden yazılıyordu: bütçeden önceki,
 * hiç etkilenmeyen siparişler de bugünkü maliyetle yeniden donuyordu.
 */
export async function reklamAraligindakiSiparisler(
  aralik: ReklamEtkiAraligi
): Promise<{ aylar: string[]; siparisler: { platform: string; externalOrderId: string }[] }> {
  if (!Number.isFinite(aralik.basMs) || !Number.isFinite(aralik.bitMs) || aralik.bitMs < aralik.basMs) {
    return { aylar: [], siparisler: [] };
  }
  const tumu = aralik.platform === TUM_PLATFORMLAR;
  const ms = dbEpochMs("orderedAt");
  const satirlar = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "platform","externalOrderId","orderedAt" FROM "OrderFinanceSnapshot"
      WHERE "platform" <> 'manual' AND ${ms} >= ? AND ${ms} <= ?
        ${tumu ? "" : `AND "platform" = ?`}`,
    ...(tumu ? [aralik.basMs, aralik.bitMs] : [aralik.basMs, aralik.bitMs, aralik.platform])
  );
  const aylar = new Set<string>();
  const siparisler: { platform: string; externalOrderId: string }[] = [];
  for (const s of satirlar) {
    const tarih = parseDbDate(s.orderedAt);
    if (!tarih) continue;
    aylar.add(monthKey(tarih));
    siparisler.push({ platform: String(s.platform ?? ""), externalOrderId: String(s.externalOrderId ?? "") });
  }
  return { aylar: [...aylar].sort(), siparisler };
}

const MESGUL_TEKRAR_MS = 3_000;
const MESGUL_TEKRAR_SAYISI = 60; // ~3 dakika

/**
 * Bütçe kaydedildikten SONRA çağrılır (önce `bustAdRateCache()`): aralıktaki siparişleri arka
 * planda yeniden hesaplatır, bitince `onDone` (finans önbelleği) çalışır. Raporlar ilerlemeyi
 * `?recalc=status` ile görür. Başka bir tur sürüyorsa kısa aralıklarla yeniden denenir.
 *
 * Döner: yeniden hesaplanacak sipariş sayısı (0 = Raporlar'da değişecek bir şey yok).
 */
export async function reklamEtkisiniYenidenHesapla(
  aralik: ReklamEtkiAraligi,
  options: { onDone?: () => void } = {}
): Promise<number> {
  const { aylar, siparisler } = await reklamAraligindakiSiparisler(aralik);
  if (siparisler.length === 0) {
    options.onDone?.();
    return 0;
  }
  // Dinamik içe aktarma: yeniden hesap modülü bu dosyayı (adRateSnapshot) statik içe aktarıyor.
  const mod = await import("@/lib/order-finance-snapshots");
  const dene = (kalan: number) => {
    try {
      mod.startFinanceRecalc(aylar, { yalnizSiparisler: siparisler, onDone: options.onDone });
    } catch (error) {
      if (error instanceof mod.FinanceRecalcBusyError && kalan > 0) {
        const t = setTimeout(() => dene(kalan - 1), MESGUL_TEKRAR_MS);
        t.unref?.();
        return;
      }
      console.error("[reklam-orani] yeniden hesap başlatılamadı:", error instanceof Error ? error.message : error);
    }
  };
  dene(MESGUL_TEKRAR_SAYISI);
  return siparisler.length;
}
