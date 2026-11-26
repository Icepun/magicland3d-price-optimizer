import { n11PaketiCoz, n11Pencereleri } from "@core/n11-siparis";
import { anahtarListesi } from "@core/order-match";

import type { OrderItem, UnifiedOrder } from "@/lib/api/orders";
import { fetchT } from "@/lib/api/http";
import { ortakKimlik } from "@/lib/kimlik";

/**
 * n11 siparişleri (telefon) — masaüstü `/api/orders` n11 bloğunun karşılığı. Çözümleme ORTAK
 * çekirdekte (`@core/n11-siparis`): tarih, durum, gelir, kesintiler, kargo şablonu iki cihazda aynı.
 *
 * Kimlik: her istekte `appkey` + `appsecret` başlığı. Değerler masaüstünde girilen ortak kayıttan
 * (lib/kimlik); yoksa uygulamaya gömülü EXPO_PUBLIC_N11_APP_KEY / _SECRET'tan (repoya YAZILMAZ).
 * Yalnız OKUMA. n11 en çok 1 aylık pencere verir, sayfa başına en çok 100 paket.
 */
let APP_KEY = process.env.EXPO_PUBLIC_N11_APP_KEY;
let APP_SECRET = process.env.EXPO_PUBLIC_N11_APP_SECRET;

async function kimligiYukle(): Promise<void> {
  const o = await ortakKimlik("n11");
  if (o.appKey && o.appSecret) {
    APP_KEY = o.appKey;
    APP_SECRET = o.appSecret;
  }
}
const TABAN = "https://api.n11.com/rest/delivery/v1/shipmentPackages";

async function paketSayfasi(baslangic: number, bitis: number, sayfa: number): Promise<{ icerik: Record<string, unknown>[]; toplamSayfa: number }> {
  const q = new URLSearchParams({
    startDate: String(baslangic),
    endDate: String(bitis),
    page: String(sayfa),
    size: "100",
    orderByDirection: "DESC",
  });
  const yanit = await fetchT(`${TABAN}?${q.toString()}`, {
    headers: { appkey: APP_KEY ?? "", appsecret: APP_SECRET ?? "", Accept: "application/json" },
  });
  if (yanit.status === 401 || yanit.status === 403) throw new Error("n11 bilgileri kabul edilmedi");
  if (!yanit.ok) throw new Error(`n11 yanıt vermedi (${yanit.status})`);
  const govde = (await yanit.json().catch(() => null)) as { content?: unknown; totalPages?: unknown } | null;
  const icerik = Array.isArray(govde?.content)
    ? (govde.content.filter((x) => x && typeof x === "object") as Record<string, unknown>[])
    : [];
  const toplamSayfa = Number(govde?.totalPages) || 0;
  return { icerik, toplamSayfa };
}

export async function getN11Orders(historyDays = 30): Promise<UnifiedOrder[]> {
  await kimligiYukle();
  // Kimlik bilgisi eksikse sessizce boş (diğer pazaryerleri gibi).
  if (!APP_KEY || !APP_SECRET) return [];
  const gun = Math.max(1, Math.min(60, Math.trunc(historyDays)));
  // Masaüstüyle aynı: +1 gün pay, kırpma çağıranda (siparişin VERİLİŞ anına göre).
  const baslangic = (Math.floor(Date.now() / 86_400_000) - gun - 1) * 86_400_000;
  const gorulen = new Set<string>();
  const out: UnifiedOrder[] = [];
  for (const pencere of n11Pencereleri(Date.now(), baslangic)) {
    for (let sayfa = 0; sayfa < 50; sayfa++) {
      const s = await paketSayfasi(pencere.baslangic, pencere.bitis, sayfa);
      for (const paket of s.icerik) {
        const o = n11PaketiCoz(paket);
        if (gorulen.has(o.id)) continue; // pencereler örtüşüyor
        gorulen.add(o.id);
        const items: OrderItem[] = o.kalemler.map((k) => {
          const harici = k.productId ? `n11-${k.productId}` : null;
          return {
            name: k.name,
            quantity: k.quantity,
            unitPrice: k.unitPrice,
            matchKeys: anahtarListesi(k.stockCode, k.barcode, harici),
            // Masaüstü n11 bloğuyla birebir: stok kodu barkod kovasında da aranır, kimlik önekli.
            barcodes: anahtarListesi(k.barcode, k.stockCode),
            externalIds: anahtarListesi(harici),
            skus: anahtarListesi(k.stockCode),
            commissionRate: k.commissionRate,
            saleVatRate: k.saleVatRate,
            paymentFee: k.paymentFee,
            stoppage: k.stoppage,
          };
        });
        out.push({
          id: o.id,
          platform: "n11",
          orderNumber: o.orderNumber,
          date: o.tarihMs,
          // Ham durum (iade edilen pakette "Returned") — kova ortak tablodan (@core/order-status-kind).
          status: o.durum.ham,
          customer: o.musteri,
          total: o.toplam,
          currency: "TRY",
          items,
          dataIncomplete: o.eksik,
          trackingNumber: o.takipNo,
          cargoProvider: o.kargoFirmasi,
          kargo: o.kargo,
        });
      }
      if (s.icerik.length === 0 || sayfa + 1 >= s.toplamSayfa) break;
    }
  }
  return out;
}
