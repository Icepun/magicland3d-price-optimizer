/**
 * n11 API İSTEMCİSİ — yalnız OKUMA (pazaryerine yazma yok, Berke'nin ürün kararı).
 *
 * Kaynak: "n11 API Referans Dokümantasyonu v10.0" (Berke 26 Kas 2026). Ürün ve sipariş servisleri
 * REST'e taşındı (SOAP ürün yükleme kapatıldı):
 *  • GET https://api.n11.com/ms/product-query — satıcının ürünleri, sayfa başına en çok 50.
 *  • GET https://api.n11.com/rest/delivery/v1/shipmentPackages — siparişler (paket), sayfa başına
 *    en çok 100; dakikada en çok 1000 istek; 2024 Kasım öncesi veri yok; tarih verilmezse/aralık
 *    büyükse yalnız 1 aylık pencere döner; `status` tek değer alır.
 * Kimlik: her istekte `appkey` + `appsecret` başlığı (Authorization yok).
 * ⚠️ Sipariş zarfında `totalElements` YOK (dokümanın aksine; 26 Kas 2026 ölçüldü: pageCount,
 *    totalPages, page, size, content) → sipariş sayısı sayfalar dolaşılarak bulunur. Ürün zarfında var.
 * Satırlarda komisyon ve kesinti ORANLARI gelir (commissionRate, netMarketingFeeRate,
 * netMarketplaceFeeRate, taxDeductionRate = stopaj, vatRate) — dokümanda yazmıyor.
 * Tarihler epoch-ms, GMT+3.
 */

const TABAN = "https://api.n11.com";
const ZAMAN_ASIMI_MS = 20_000;

export interface N11Kimligi {
  appKey: string;
  appSecret: string;
}

export class N11Hatasi extends Error {
  constructor(mesaj: string, readonly durum = 502) {
    super(mesaj);
    this.name = "N11Hatasi";
  }
}

export interface N11Sayfa<T> {
  icerik: T[];
  /** Zarfta toplam yoksa (siparişler) null. */
  toplam: number | null;
  toplamSayfa: number;
}

export type N11PaketDurumu = "Created" | "Picking" | "Shipped" | "Cancelled" | "Delivered" | "UnPacked" | "UnSupplied";

export class N11Client {
  constructor(private readonly kimlik: N11Kimligi) {}

  private async getir(yol: string, parametreler: Record<string, string | number | undefined>): Promise<unknown> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(parametreler)) if (v !== undefined && v !== "") q.set(k, String(v));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ZAMAN_ASIMI_MS);
    let yanit: Response;
    try {
      yanit = await fetch(`${TABAN}${yol}${q.size ? `?${q.toString()}` : ""}`, {
        method: "GET",
        headers: { appkey: this.kimlik.appKey, appsecret: this.kimlik.appSecret, Accept: "application/json" },
        signal: ctrl.signal,
      });
    } catch {
      throw new N11Hatasi("n11'e ulaşılamadı. Tekrar dene.");
    } finally {
      clearTimeout(t);
    }
    const metin = await yanit.text();
    let govde: unknown = null;
    try {
      govde = metin ? JSON.parse(metin) : null;
    } catch {
      govde = null;
    }
    if (yanit.status === 401 || yanit.status === 403) throw new N11Hatasi("n11 API anahtarı ya da şifresi kabul edilmedi.", 401);
    if (yanit.status === 429) throw new N11Hatasi("n11 çok sık istek aldı. Biraz bekleyip tekrar dene.", 429);
    if (!yanit.ok) throw new N11Hatasi("n11 şu an yanıt vermiyor. Biraz sonra tekrar dene.", yanit.status >= 500 ? 502 : yanit.status);
    return govde;
  }

  /** Satıcının ürünleri (bir sayfa). */
  async urunler(sayfa = 0, boyut = 50): Promise<N11Sayfa<Record<string, unknown>>> {
    return sayfaCoz(await this.getir("/ms/product-query", { page: sayfa, size: Math.min(50, boyut) }));
  }

  /** Sipariş paketleri (bir sayfa). Tarihler epoch-ms (GMT+3); n11 en çok 1 aylık pencere verir. */
  async siparisPaketleri(secenek: {
    baslangic?: number;
    bitis?: number;
    durum?: N11PaketDurumu;
    sayfa?: number;
    boyut?: number;
  } = {}): Promise<N11Sayfa<Record<string, unknown>>> {
    return sayfaCoz(
      await this.getir("/rest/delivery/v1/shipmentPackages", {
        startDate: secenek.baslangic,
        endDate: secenek.bitis,
        status: secenek.durum,
        page: secenek.sayfa ?? 0,
        size: Math.min(100, secenek.boyut ?? 100),
        orderByDirection: "DESC",
      })
    );
  }

  /** Aralıktaki TÜM paketler (sayfa sayfa; n11 en çok 1 aylık pencere verir). Güvenlik sınırı 50 sayfa. */
  async tumSiparisPaketleri(secenek: { baslangic: number; bitis: number; durum?: N11PaketDurumu }): Promise<Record<string, unknown>[]> {
    const hepsi: Record<string, unknown>[] = [];
    for (let sayfa = 0; sayfa < 50; sayfa++) {
      const s = await this.siparisPaketleri({ ...secenek, sayfa, boyut: 100 });
      hepsi.push(...s.icerik);
      if (s.icerik.length === 0 || sayfa + 1 >= s.toplamSayfa) break;
    }
    return hepsi;
  }
}

/** `{content, totalElements, totalPages}` zarfını çözer; beklenmeyen biçimde boş sayfa. */
export function sayfaCoz(govde: unknown): N11Sayfa<Record<string, unknown>> {
  const g = (govde ?? {}) as { content?: unknown; totalElements?: unknown; totalPages?: unknown };
  const icerik = Array.isArray(g.content) ? (g.content.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : [];
  const sayi = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
  return { icerik, toplam: g.totalElements == null ? null : sayi(g.totalElements), toplamSayfa: sayi(g.totalPages) };
}
