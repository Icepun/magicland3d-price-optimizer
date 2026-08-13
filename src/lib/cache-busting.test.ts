import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Sipariş senkronu bitince finans önbelleği düşüyor mu?
 *
 * SORUN (ölçüldü): sipariş özet yazımı arka plana alınınca, yazım bitince önbelleği düşüren
 * kimse kalmadı. Yeni sipariş listede görünüyor ama "Ciro (bu ay)" / "Net kâr (bu ay)"
 * kartları bir görüntüleme geride kalıyordu.
 *
 * İKİ YÖNLÜ KORUMA — bu testler hem "düşürmeyi kaçırma" hem "gereksiz düşürme" hatasını tutar.
 * İkincisi önemli: Siparişler 60 saniyede bir arka planda tazeleniyor ve turların çoğunda
 * hiçbir satır değişmiyor; koşulsuz düşürmek pahalı aylık hesabı sürekli baştan koşturur.
 */

const bustCache = vi.fn();
const bustCaches = vi.fn();
vi.mock("@/lib/route-cache", () => ({
  bustCache: (...a: unknown[]) => bustCache(...a),
  bustCaches: (...a: unknown[]) => bustCaches(...a),
}));
const invalidateOrdersCache = vi.fn();
vi.mock("@/lib/orders-cache", () => ({
  invalidateOrdersCache: () => invalidateOrdersCache(),
}));

type Durum = { ok: boolean; writtenOrders: number; writtenItems: number } | null;
let inFlight = false;
let sonDurum: Durum = null;
/** Gerçek modüldeki gibi SÜREÇ ÖMRÜ BOYUNCA artan sayaçlar. */
let toplamlar = { orders: 0, items: 0, rounds: 0 };
vi.mock("@/lib/order-finance-snapshots", () => ({
  orderFinanceSnapshotWriteInFlight: () => inFlight,
  lastOrderFinanceSnapshotWrite: () => sonDurum,
  orderFinanceSnapshotWriteTotals: () => toplamlar,
}));

import {
  bustActualCommissionCaches,
  bustFinanceCachesAfterOrderSnapshots,
} from "@/lib/cache-busting";

const hizli = { pollMs: 1, timeoutMs: 2_000 };

/**
 * Yazım turunu taklit et: bir süre "sürüyor", sonra verilen sonuçları sırayla damgala.
 * Gerçek `drainQueue` gibi hem son durumu EZER hem de sayaçları artırır.
 */
function turlariKoştur(sonuclar: Durum[], aralikMs = 3): void {
  inFlight = true;
  let i = 0;
  const tik = setInterval(() => {
    if (i >= sonuclar.length) {
      inFlight = false;
      clearInterval(tik);
      return;
    }
    const durum = sonuclar[i++];
    sonDurum = durum;
    if (durum?.ok) {
      toplamlar = {
        orders: toplamlar.orders + durum.writtenOrders,
        items: toplamlar.items + durum.writtenItems,
        rounds: toplamlar.rounds + 1,
      };
    } else {
      toplamlar = { ...toplamlar, rounds: toplamlar.rounds + 1 };
    }
  }, aralikMs);
}

beforeEach(() => {
  bustCache.mockClear();
  bustCaches.mockClear();
  invalidateOrdersCache.mockClear();
  inFlight = false;
  sonDurum = null;
  toplamlar = { orders: 0, items: 0, rounds: 0 };
});

describe("bustActualCommissionCaches", () => {
  // Gerçek komisyon senkronu önbelleği ham `invalidateOrdersCache()` + `bustCache("finance-monthly:")`
  // ile düşürüyordu. Davranış doğruydu ama düşürme kuralı bu dosyanın DIŞINDA yaşıyordu:
  // yeni bir finans önbelleği eklendiğinde o rota sessizce eksik kalırdı.
  it("hem sipariş kârını hem aylık finans gövdesini düşürür", () => {
    bustActualCommissionCaches();
    expect(invalidateOrdersCache).toHaveBeenCalledTimes(1);
    expect(bustCache).toHaveBeenCalledWith("finance-monthly:");
  });

  it("ürün görünümlerini KORUR (komisyon kuralı değişmedi, pahalı hesap boşuna koşmasın)", () => {
    bustActualCommissionCaches();
    expect(bustCaches).not.toHaveBeenCalled();
  });
});

describe("bustFinanceCachesAfterOrderSnapshots", () => {
  it("satır yazıldıysa finans önbelleğini düşürür", async () => {
    turlariKoştur([{ ok: true, writtenOrders: 3, writtenItems: 7 }]);
    await expect(bustFinanceCachesAfterOrderSnapshots(hizli)).resolves.toBe(true);
    expect(bustCache).toHaveBeenCalledWith("finance-monthly:");
  });

  it("yalnız kalem yazıldıysa da düşürür (ürün bazlı satış geçmişi rapora girer)", async () => {
    turlariKoştur([{ ok: true, writtenOrders: 0, writtenItems: 4 }]);
    await expect(bustFinanceCachesAfterOrderSnapshots(hizli)).resolves.toBe(true);
    expect(bustCache).toHaveBeenCalledWith("finance-monthly:");
  });

  it("hiçbir şey değişmediyse önbelleği KORUR (60sn'lik tazelemeler pahalı hesabı ezmesin)", async () => {
    turlariKoştur([{ ok: true, writtenOrders: 0, writtenItems: 0 }]);
    await expect(bustFinanceCachesAfterOrderSnapshots(hizli)).resolves.toBe(false);
    expect(bustCache).not.toHaveBeenCalled();
  });

  it("yazım hata verdiyse düşürmez (yarım veriyle taze görünmesin)", async () => {
    turlariKoştur([{ ok: false, writtenOrders: 0, writtenItems: 0 }]);
    await expect(bustFinanceCachesAfterOrderSnapshots(hizli)).resolves.toBe(false);
    expect(bustCache).not.toHaveBeenCalled();
  });

  it("ARADAKİ tur yazdıysa, son tur 0 yazsa bile düşürür", async () => {
    // Kuyrukta iki tur varsa her tur bir öncekinin sonucunu EZİYOR. Yalnız sona bakan bir
    // düzeltme burada sessizce kaçırırdı — düzeltmenin kendisi yeni bir hata olurdu.
    turlariKoştur([
      { ok: true, writtenOrders: 12, writtenItems: 40 },
      { ok: true, writtenOrders: 0, writtenItems: 0 },
    ]);
    await expect(bustFinanceCachesAfterOrderSnapshots(hizli)).resolves.toBe(true);
    expect(bustCache).toHaveBeenCalledWith("finance-monthly:");
  });

  it("yazım hiç başlamadıysa (yazılacak sipariş yok) önceki turun sonucuyla düşürmez", async () => {
    // Yazılacak sipariş yoksa kuyruğa iş girmez ve `lastStatus` ÖNCEKİ turda kalır.
    // Onu "yeni yazım" sanmak her sipariş isteğinde gereksiz bir düşürme demek olurdu.
    sonDurum = { ok: true, writtenOrders: 9, writtenItems: 9 };
    toplamlar = { orders: 9, items: 9, rounds: 1 }; // geçmişte yazılmış satırlar
    inFlight = false;
    await expect(bustFinanceCachesAfterOrderSnapshots(hizli)).resolves.toBe(false);
    expect(bustCache).not.toHaveBeenCalled();
  });

  it("AYNI yoklama aralığında biten iki turdan ilki yazdıysa yine düşürür", async () => {
    // 🔴 DENETİMDE BULUNDU: örnekleme yöntemi bu durumu KAÇIRIYORDU. Paketlenmiş uygulamada
    // sorgular gömülü replikadan gelir (alt-milisaniye); iki tur tek yoklama penceresinde
    // bitince yalnız SONUNCUSU görülüyor, aradaki turun 12 satırı yok sayılıyordu.
    // Yoklama aralığı bilerek turlardan çok daha uzun tutuldu.
    turlariKoştur(
      [
        { ok: true, writtenOrders: 12, writtenItems: 40 },
        { ok: true, writtenOrders: 0, writtenItems: 0 },
      ],
      1
    );
    await expect(
      bustFinanceCachesAfterOrderSnapshots({ pollMs: 200, timeoutMs: 2_000 })
    ).resolves.toBe(true);
    expect(bustCache).toHaveBeenCalledWith("finance-monthly:");
  });

  it("yazım takılırsa süre dolar ve sipariş akışını bloklamaz", async () => {
    inFlight = true; // hiç bitmiyor
    const t0 = Date.now();
    await expect(
      bustFinanceCachesAfterOrderSnapshots({ pollMs: 1, timeoutMs: 40 })
    ).resolves.toBe(false);
    expect(Date.now() - t0).toBeLessThan(2_000);
    inFlight = false;
  });
});
