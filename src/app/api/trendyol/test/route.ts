import { NextResponse } from "next/server";
import { TrendyolClient } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { jsonError } from "@/lib/api-error";

export async function POST() {
  try {
    const credentials = await getTrendyolCredentials();
    const client = new TrendyolClient(credentials);
    // Ürün v2: onay durumu artık parametre değil, UÇ seçimi.
    const result = await client.listApprovedProducts({ page: 0, size: 1 });

    /**
     * FİYAT UCU AYRICA SINANIR. Ürün v2 göçünde iki ucun gövde biçimi farklı ve doküman
     * hafif uç için yanlış bilgi veriyordu (fiyatı düz gösteriyor, sahada iç içe geldi) —
     * sonuç: tüm fiyatlar geçersiz sayıldı. Bağlantı testi artık fiyatın GERÇEKTEN
     * okunabildiğini de doğruluyor; "bağlantı var ama fiyat gelmiyor" durumu gizlenmesin.
     */
    let fiyatOrnegi: { barkod: string | null; satisFiyati: number | null; stok: number | null } | null = null;
    let fiyatHatasi: string | null = null;
    try {
      const fiyat = await client.listApprovedInventoryAndPrice({ page: 0, size: 1 });
      const ilk = fiyat.content?.[0];
      fiyatOrnegi = ilk
        ? {
            barkod: ilk.barcode ?? null,
            satisFiyati: ilk.salePrice ?? null,
            stok: ilk.quantity ?? null,
          }
        : null;
    } catch (e) {
      fiyatHatasi = e instanceof Error ? e.message : "okunamadı";
    }

    return NextResponse.json({
      ok: true,
      totalElements: result.totalElements ?? 0,
      totalPages: result.totalPages ?? 0,
      // Fiyat okunamıyorsa bağlantı "başarılı" görünse bile yenileme çalışmaz.
      fiyatOkunuyor: fiyatOrnegi != null && Number.isFinite(fiyatOrnegi.satisFiyati ?? NaN) && (fiyatOrnegi.satisFiyati ?? 0) > 0,
      fiyatOrnegi,
      fiyatHatasi,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return jsonError(error);
  }
}
