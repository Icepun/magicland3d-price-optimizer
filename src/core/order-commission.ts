/**
 * SİPARİŞTE KESİLEN KOMİSYON ORANI — pazaryerinin siparişin KENDİSİNDE bildirdiği oran.
 *
 * Trendyol sipariş satırında (`lines[].commission`), Hepsiburada sipariş kaleminde
 * (`commissionRate`) o satışa uygulanan oranı YÜZDE olarak bildiriyor (21, 13.2, 2.7 …).
 * Kampanya günlerinde ya da tarife değiştiğinde bu oran ürünün varsayılan oranından farklıdır;
 * ölçüldü (22 Kas 2026): Trendyol'da ödemesi gelmiş 34 siparişin 34'ünde ödeme kaydındaki
 * gerçek komisyonla birebir tuttu.
 *
 * Berke'nin kararı (22 Kas 2026): sipariş kârına siparişte kesilen oran girer; ürüne elle
 * girilen oran yalnız satış öncesi maliyet hesabının varsayılanıdır.
 */

/**
 * Pazaryerinin bildirdiği YÜZDE → kesir (21 → 0.21). Geçersizse null.
 *
 * ⚠️ Girdi HER ZAMAN yüzdedir: "1'den küçükse zaten kesirdir" tahmini YAPILMAZ — %0,5'lik bir
 * kampanya oranı %50 diye okunurdu. Sıfır ve negatif "bilinmiyor" sayılır (alan boş gelmiş
 * olabilir; sıfır komisyon varsaymak kârı sessizce şişirir), %100 ve üstü saçmadır.
 */
export function siparisKomisyonKesri(yuzde: unknown): number | null {
  if (yuzde == null || yuzde === "") return null;
  const sayi = typeof yuzde === "number" ? yuzde : Number(yuzde);
  if (!Number.isFinite(sayi)) return null;
  const kesir = sayi / 100;
  if (kesir <= 0 || kesir >= 1) return null;
  return Math.round(kesir * 1_000_000) / 1_000_000;
}

/**
 * Kayıtlı/taşınan KESİR geçerli mi? (Önbellekten, kalem geçmişinden ya da eski bir sürümün
 * yazdığı kayıttan gelen değer için — biçimi bozuksa "yok" sayılır, varsayılan orana düşülür.)
 */
export function gecerliSiparisOrani(kesir: unknown): number | null {
  if (typeof kesir !== "number" || !Number.isFinite(kesir)) return null;
  if (kesir <= 0 || kesir >= 1) return null;
  return kesir;
}

/** `{ amount }` nesnesi ya da düz sayı → sayı (HB tutarları iki biçimde de gelebiliyor). */
function tutarOku(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "amount" in (v as Record<string, unknown>)) {
    return Number((v as { amount?: unknown }).amount);
  }
  return Number(v);
}

/**
 * HEPSİBURADA kalemi → siparişte kesilen oran (KESİR, satırın birim fiyatına göre).
 *
 * HB kalemde hem oranı (`commissionRate`, yüzde) hem KESİLEN TUTARI (`commission.amount`) verir.
 * Ölçüldü (22 Kas 2026, 57 kalem):
 *   • tutar ADET BAŞINADIR (2 adet × 199,99 ve %10 → 20, 40 değil);
 *   • Hepsiburada kendi indirimini uyguladığında (`hbDiscount`) komisyon İNDİRİM ÖNCESİ fiyattan
 *     kesilir: birim 450, HB indirimi 50, oran %22 → kesilen 110 (450 × %22 = 99 DEĞİL).
 * Bu yüzden gerçekten kesilen tutar esas alınır ve satırın birim fiyatına bölünerek orana çevrilir;
 * çekirdek komisyonu "fiyat × oran" diye hesapladığı için sonuç tam olarak kesilen tutarı verir.
 *
 * Tutar yoksa ya da akla yatkın değilse (bildirilen oranın yarısından az / 1,6 katından çok —
 * alanın anlamı değişmiş olabilir) bildirilen orana düşülür. Yuvarlama farkı kadar yakınsa da
 * bildirilen oran kullanılır (0,100005 gibi gürültülü değerler saklanmasın).
 */
export function hbSiparisKomisyonOrani(
  kalem: { commissionRate?: unknown; commission?: unknown },
  birimFiyat: number
): number | null {
  const bildirilen = siparisKomisyonKesri(kalem.commissionRate);
  const tutar = tutarOku(kalem.commission);
  if (!Number.isFinite(tutar) || tutar <= 0 || !Number.isFinite(birimFiyat) || birimFiyat <= 0) {
    return bildirilen;
  }
  const kesilen = gecerliSiparisOrani(Math.round((tutar / birimFiyat) * 1_000_000) / 1_000_000);
  if (kesilen == null) return bildirilen;
  if (bildirilen == null) return kesilen;
  if (Math.abs(kesilen - bildirilen) <= 0.0005) return bildirilen;
  if (kesilen < bildirilen * 0.5 || kesilen > bildirilen * 1.6) return bildirilen;
  return kesilen;
}
