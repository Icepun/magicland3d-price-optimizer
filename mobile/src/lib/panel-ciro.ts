/**
 * PANEL CİROSU — saf hesap (React/ağ yok; kökteki testler doğrudan içe aktarır).
 *
 * ⚠️ KESİM MASAÜSTÜYLE AYNI: UTC gün başına yuvarlanmış (`api/window.ts`, masaüstü
 * `api/orders/route.ts`). Panel bir tur "şu an − N×24 saat" kayan penceresi kullanıyordu;
 * masaüstü özeti 30 gün önceki UTC günün BAŞINDAN sayarken telefon aynı günün kalanını
 * atlıyordu. 23 Eyl 2026 canlı ölçüm: 24 Ağustos'un 4 siparişi (2.519,97 ₺) yalnız masaüstünde
 * sayılıyordu — kullanıcının "bir iki günlük fark var gibi" dediği tablo.
 *
 * Grafik kovaları da UTC TAKVİM GÜNÜDÜR: kesim bir günün başında olduğu için pencere `gun + 1`
 * gün kapsar (N tam gün + bugün). Kovalar kayan 24 saatlik dilimlerken en eski çubuk iki günü
 * birden taşıyabiliyordu.
 */
export const GUN_MS = 86_400_000;

/** `gun` gün önceki UTC günün başı — masaüstü özetinin kesimiyle birebir. */
export function donemKesimi(simdi: number, gun: number): number {
  return (Math.floor(simdi / GUN_MS) - gun) * GUN_MS;
}

export interface PanelSiparis {
  platform: string;
  /** Sipariş verme anı (epoch ms); bilinmiyorsa null → masaüstü gibi pencereye DAHİL. */
  date: number | null;
  currency?: string;
}

export interface PanelCiroSonucu {
  total: number;
  profit: number;
  count: number;
  byPlat: Record<string, { rev: number; n: number }>;
  /** Günlük ciro, eskiden bugüne; uzunluk `gun + 1`. */
  gunluk: number[];
}

export function panelCirosu<O extends PanelSiparis>(
  orders: readonly O[],
  opts: {
    gun: number;
    simdi: number;
    platformlar: readonly string[];
    /** Ciroya girmeyecek sipariş: iptal/iade ve (pazaryerinde) tanınmayan durum. */
    sayilmazMi: (o: O) => boolean;
    hesapla: (o: O) => { revenue: number; profit: number | null };
  }
): PanelCiroSonucu {
  const { gun, simdi } = opts;
  const byPlat: Record<string, { rev: number; n: number }> = Object.fromEntries(
    opts.platformlar.map((p) => [p, { rev: 0, n: 0 }])
  );
  const gunluk = new Array<number>(gun + 1).fill(0);
  let total = 0;
  let profit = 0;
  let count = 0;
  if (!simdi) return { total, profit, count, byPlat, gunluk };

  const kesim = donemKesimi(simdi, gun);
  const ilkGun = Math.floor(kesim / GUN_MS);
  for (const o of orders) {
    if (o.date != null && o.date < kesim) continue;
    if (opts.sayilmazMi(o)) continue;
    // Döviz çevrimi yok: TL dışı sipariş TL toplamına eklenmez (masaüstü özeti de aynı).
    if ((o.currency ?? "TRY").trim().toUpperCase() !== "TRY") continue;
    const op = opts.hesapla(o);
    total += op.revenue;
    const b = byPlat[o.platform];
    if (b) {
      b.rev += op.revenue;
      b.n++;
    }
    if (op.profit != null) profit += op.profit;
    count++;
    if (o.date != null) {
      const i = Math.min(gun, Math.max(0, Math.floor(o.date / GUN_MS) - ilkGun));
      gunluk[i] += op.revenue;
    }
  }
  return { total, profit, count, byPlat, gunluk };
}
