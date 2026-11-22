/**
 * KARGO DENETİMİ (sunucu) — fazla desi kesilen siparişler ve Trendyol gecikme bedelleri.
 *
 * Kaynak kalıcı kayıtlar: sipariş özeti (OrderFinanceSnapshot: tutar, kargo bağlamı, gecikme
 * bilgisi), kalem geçmişi + ürün desisi (beklenen desi) ve pazaryeri kaydı (PlatformOrderFinancial:
 * kesilen kargo + desi). Kargo faturası siparişten ~4 hafta sonra geldiği için canlı sipariş
 * penceresine (30 gün) bağlı DEĞİL — son 90 gün taranır.
 *
 * Yeni fazla desi bulunan siparişler masaüstü bildirimine düşer (tür "kargo"; telefona gitmez).
 */
import { prisma } from "@/lib/prisma";
import { dbEpochMs, parseDbDate, toDbDate } from "./sqlite-date";
import { kargoTahmini, fiyatDesisi } from "@/core/kargo-tarife";
import { fazlaDesiBul } from "@/core/kargo-denetim";
import { tyGecikmeFaturalariOku, type TyGecikmeDurumu, type TyGecikmeFaturasi } from "@/core/trendyol-gecikme";
import { vatRateOf } from "@/core/vat";
import { kargoBaglamiOku } from "./order-finance-snapshots";
import { batchWrite } from "./libsql-batch";

const GUN_MS = 86_400_000;
const PARCA = 400;

export interface FazlaDesiSatiri {
  platform: "trendyol" | "hepsiburada";
  orderNumber: string;
  orderedAt: string;
  /** Trendyol itirazı bununla yapılır (kargo takip numarası). */
  paketNo: string | null;
  urunler: string;
  bizimDesi: number;
  kesilenDesi: number;
  /** Fazladan ödenen kargo (brüt TL). */
  fazla: number;
  gercekKargo: number;
  tahminiKargo: number;
}

export interface GecikmeSatiri {
  orderNumber: string;
  orderedAt: string;
  sonGun: string;
  tolerans: string;
  kargolanma: number | null;
  kargolanmadi: boolean;
  ceza: number;
  durum: TyGecikmeDurumu;
  tutar: number;
}

export interface KargoDenetimi {
  fazlaDesi: FazlaDesiSatiri[];
  gecikmeler: GecikmeSatiri[];
  gecikmeFaturalari: TyGecikmeFaturasi[];
  toplamFazla: number;
  toplamCeza: number;
}

const sayi = (v: unknown) => (typeof v === "bigint" ? Number(v) : Number(v));

/** Son `gun` günün kargo denetimi. Hata FIRLATIR (çağıran yakalar). */
export async function kargoDenetimiHesapla(gun = 90): Promise<KargoDenetimi> {
  const bas = Date.now() - gun * GUN_MS;
  const [ozetler, kayitlar, ayarlar] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "platform","externalOrderId","orderNumber","orderedAt","revenueKurus","statusKind",
              "cargoContext","delayInfo"
         FROM "OrderFinanceSnapshot"
        WHERE "platform" IN ('trendyol','hepsiburada') AND ${dbEpochMs("orderedAt")} >= ?`,
      bas
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "platform","externalOrderId","orderNumber","cargoKurus","chargedDesi","parcelNo"
         FROM "PlatformOrderFinancial"
        WHERE "platform" IN ('trendyol','hepsiburada') AND "chargedDesi" IS NOT NULL AND "cargoKurus" IS NOT NULL`
    ),
    prisma.appSetting.findMany(),
  ]);
  const ayar = Object.fromEntries(ayarlar.map((a) => [a.key, a.value])) as Record<string, string | undefined>;
  const kdvCarpani = 1 + vatRateOf(ayar) / 100;

  // Pazaryeri kaydı: kimlikle; Trendyol'da sipariş numarası tekilse numarayla da.
  const kayitByKimlik = new Map<string, Record<string, unknown>>();
  const tyNoSayisi = new Map<string, number>();
  for (const k of kayitlar) {
    kayitByKimlik.set(`${k.platform}|${k.externalOrderId}`, k);
    if (k.platform === "trendyol") tyNoSayisi.set(String(k.orderNumber), (tyNoSayisi.get(String(k.orderNumber)) ?? 0) + 1);
  }
  const tyByNo = new Map(
    kayitlar.filter((k) => k.platform === "trendyol" && tyNoSayisi.get(String(k.orderNumber)) === 1).map((k) => [String(k.orderNumber), k])
  );

  // ── FAZLA DESİ ────────────────────────────────────────────────────────────────────────────
  const adaylar = ozetler
    .filter((o) => o.statusKind !== "cancelled")
    .map((o) => ({
      o,
      k:
        kayitByKimlik.get(`${o.platform}|${o.externalOrderId}`) ??
        (o.platform === "trendyol" ? tyByNo.get(String(o.orderNumber)) : undefined),
    }))
    .filter((x): x is { o: Record<string, unknown>; k: Record<string, unknown> } => x.k != null);

  const kalemler = new Map<string, Array<{ productId: string | null; productName: string; quantity: number }>>();
  const kimlikler = [...new Set(adaylar.map((x) => String(x.o.externalOrderId)))];
  for (let i = 0; i < kimlikler.length; i += PARCA) {
    const dilim = kimlikler.slice(i, i + PARCA);
    const satirlar = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "platform","externalOrderId","productId","productName","quantity"
         FROM "OrderItemSnapshot" WHERE "externalOrderId" IN (${dilim.map(() => "?").join(",")})`,
      ...dilim
    );
    for (const s of satirlar) {
      const anahtar = `${s.platform}|${s.externalOrderId}`;
      const liste = kalemler.get(anahtar) ?? [];
      liste.push({ productId: s.productId == null ? null : String(s.productId), productName: String(s.productName ?? ""), quantity: sayi(s.quantity) });
      kalemler.set(anahtar, liste);
    }
  }
  const urunIdleri = [...new Set([...kalemler.values()].flat().map((k) => k.productId).filter((v): v is string => !!v))];
  const desiByUrun = new Map<string, number | null>();
  for (let i = 0; i < urunIdleri.length; i += PARCA) {
    const urunler = await prisma.product.findMany({ where: { id: { in: urunIdleri.slice(i, i + PARCA) } }, select: { id: true, desi: true } });
    for (const u of urunler) desiByUrun.set(u.id, u.desi);
  }

  const fazlaDesi: FazlaDesiSatiri[] = [];
  for (const { o, k } of adaylar) {
    const satirlar = kalemler.get(`${o.platform}|${o.externalOrderId}`) ?? [];
    if (satirlar.length === 0) continue;
    let toplam = 0;
    let bilinmeyen = false;
    for (const s of satirlar) {
      const d = s.productId ? desiByUrun.get(s.productId) : null;
      if (d == null || !(s.quantity > 0)) { bilinmeyen = true; break; }
      toplam += d * s.quantity;
    }
    // Ürün desisi bilinmiyorsa karşılaştırma yapılamaz (tahmin edilen desiyle itiraz önerilmez).
    if (bilinmeyen) continue;
    const tarih = parseDbDate(o.orderedAt);
    if (!tarih) continue;
    const bizimDesi = fiyatDesisi(toplam);
    const tutar = sayi(o.revenueKurus) / 100;
    const tahmin = kargoTahmini(String(o.platform), tutar, bizimDesi, tarih, kargoBaglamiOku(o.cargoContext as string | null));
    if (!tahmin) continue;
    const gercekKargo = sayi(k.cargoKurus) / 100;
    const tahminiKargo = Math.round(tahmin.fiyat * kdvCarpani * 100) / 100;
    const fazla = fazlaDesiBul({ kesilenDesi: sayi(k.chargedDesi), bizimDesi, gercekKargo, tahminiKargo });
    if (!fazla) continue;
    fazlaDesi.push({
      platform: o.platform === "hepsiburada" ? "hepsiburada" : "trendyol",
      orderNumber: String(o.orderNumber),
      orderedAt: tarih.toISOString(),
      paketNo: k.parcelNo == null ? null : String(k.parcelNo),
      urunler: satirlar.map((s) => (s.quantity > 1 ? `${s.quantity}× ${s.productName}` : s.productName)).join(", "),
      bizimDesi: fazla.bizimDesi,
      kesilenDesi: fazla.kesilenDesi,
      fazla: fazla.fazla,
      gercekKargo,
      tahminiKargo,
    });
  }
  fazlaDesi.sort((a, b) => b.orderedAt.localeCompare(a.orderedAt));

  // ── GECİKMELER (Trendyol) ─────────────────────────────────────────────────────────────────
  const gecikmeler: GecikmeSatiri[] = [];
  for (const o of ozetler) {
    if (o.platform !== "trendyol" || !o.delayInfo) continue;
    let g: Record<string, unknown> | null = null;
    try {
      g = JSON.parse(String(o.delayInfo)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!g || g.gecikti !== true) continue;
    const tarih = parseDbDate(o.orderedAt);
    gecikmeler.push({
      orderNumber: String(o.orderNumber),
      orderedAt: tarih ? tarih.toISOString() : "",
      sonGun: String(g.sonGun ?? ""),
      tolerans: String(g.tolerans ?? ""),
      kargolanma: typeof g.kargolanma === "number" ? g.kargolanma : null,
      kargolanmadi: g.kargolanmadi === true,
      ceza: typeof g.ceza === "number" ? g.ceza : 0,
      durum: (g.durum as TyGecikmeDurumu) ?? "tahmini",
      tutar: sayi(o.revenueKurus) / 100,
    });
  }
  gecikmeler.sort((a, b) => b.sonGun.localeCompare(a.sonGun));
  const faturalar = tyGecikmeFaturalariOku(ayar.tyGecikmeFaturalari)?.faturalar ?? [];

  const yuvarla = (n: number) => Math.round(n * 100) / 100;
  return {
    fazlaDesi,
    gecikmeler,
    gecikmeFaturalari: faturalar.filter((f) => f.tarih >= bas).sort((a, b) => b.tarih - a.tarih),
    toplamFazla: yuvarla(fazlaDesi.reduce((t, r) => t + r.fazla, 0)),
    toplamCeza: yuvarla(gecikmeler.reduce((t, r) => t + (r.durum === "gercek" || r.durum === "tahmini" ? r.ceza : 0), 0)),
  };
}

const BASLANGIC_AYARI = "kargoDesiBildirimBasladi";
/** Tek turda bundan fazla yeni sipariş çıkarsa tek tek değil, özet bildirim. */
const TEK_TEK_SINIRI = 5;
const tl = (n: number) => n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PLATFORM_ADI: Record<string, string> = { trendyol: "Trendyol", hepsiburada: "Hepsiburada" };

/**
 * Yeni fazla desi kesilen siparişleri bildir. İlk çalışmada eski birikmiş siparişler tek tek değil
 * tek bir özet bildirimle haber verilir. Hata FIRLATMAZ. Dönen değer: yeni bildirilen sipariş sayısı.
 */
export async function kargoDenetimBildirimleri(): Promise<number> {
  try {
    const { fazlaDesi } = await kargoDenetimiHesapla(90);
    const kimlik = (r: FazlaDesiSatiri) => `kargo-desi:${r.platform}:${r.orderNumber}`;
    const mevcut = new Set(
      (
        await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id" FROM "Notification" WHERE "id" LIKE 'kargo-desi:%'`)
      ).map((r) => String(r.id))
    );
    const yeniler = fazlaDesi.filter((r) => !mevcut.has(kimlik(r)));
    if (yeniler.length === 0) return 0;
    const basladi = await prisma.appSetting.findUnique({ where: { key: BASLANGIC_AYARI } });
    const an = toDbDate(new Date());
    // Çok sayıda (ya da ilk kez) → her sipariş sessiz işaretlenir, tek özet bildirim düşer.
    const ozetle = !basladi || yeniler.length > TEK_TEK_SINIRI;
    const ifadeler = yeniler.map((r) => ({
      sql: `INSERT OR IGNORE INTO "Notification" ("id","type","severity","title","body","href","createdAt","acknowledgedAt")
            VALUES (?,?,?,?,?,?,?,?)`,
      args: [
        kimlik(r),
        "kargo",
        "warning",
        "Fazla desi kesildi",
        `${PLATFORM_ADI[r.platform]} ${r.orderNumber} · ${r.bizimDesi} yerine ${r.kesilenDesi} desi · ${tl(r.fazla)} ₺ fazla`,
        "/cargo-rules?sekme=denetim",
        an,
        ozetle ? an : null,
      ] as unknown[],
    }));
    if (ozetle) {
      const toplam = yeniler.reduce((t, r) => t + r.fazla, 0);
      ifadeler.push({
        sql: `INSERT OR IGNORE INTO "Notification" ("id","type","severity","title","body","href","createdAt","acknowledgedAt")
              VALUES (?,?,?,?,?,?,?,?)`,
        args: [
          `kargo-desi-ozet:${new Date().toISOString().slice(0, 13)}`,
          "kargo",
          "warning",
          "Fazla desi kesilen siparişler",
          `${yeniler.length} siparişte ${tl(toplam)} ₺ fazla kargo kesildi — itiraz edebilirsin`,
          "/cargo-rules?sekme=denetim",
          an,
          null,
        ],
      });
    }
    if (!(await batchWrite(ifadeler))) {
      for (const ifade of ifadeler) await prisma.$executeRawUnsafe(ifade.sql, ...(ifade.args as never[]));
    }
    if (!basladi) {
      await prisma.appSetting.upsert({
        where: { key: BASLANGIC_AYARI },
        update: {},
        create: { key: BASLANGIC_AYARI, value: new Date().toISOString() },
      });
    }
    return yeniler.length;
  } catch (hata) {
    console.warn("[kargo-denetim] bildirim üretilemedi:", hata instanceof Error ? hata.message : hata);
    return 0;
  }
}
