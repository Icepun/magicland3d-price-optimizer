import { reklamOraniIcin } from "@core/ad-cost";
import { sayiOku, type HizliHesapBaglam, type HizliHesapGirdi, type HizliPlatform } from "@core/hizli-hesap";

import type { FilamentType } from "@/lib/db/cost-save";
import type { Rules } from "@/lib/profit";

/**
 * HIZLI HESAP (telefon) — form alanları ve hesabın bağlamı. Saf modül (React Native'e dokunmaz):
 * rakam karşılaştırma düzeneği Node'da doğrudan çalıştırabilsin. Cihaza kayıt `hizli-hesap-kayit.ts`.
 * Hesabın kendisi ÇEKİRDEKTE (`@core/hizli-hesap` → `@core/client-pricing`): masaüstünün hızlı
 * hesabı ve ürün ekranıyla aynı fonksiyon, telefonda ayrı formül yok.
 *
 * Masaüstü formuyla aynı alanlar ve aynı varsayılanlar (`components/hizli-hesap/HizliHesap.tsx`).
 */
export interface HizliForm {
  platform: HizliPlatform;
  filamentTypeId: string;
  gram: string;
  saat: string;
  dakika: string;
  desi: string;
  fire: string;
  paket: string;
  naylon: string;
  bant: boolean;
  /** Platform başına ayrı: Trendyol ↔ HB arasında geçince oran kaybolmasın. */
  komisyon: Record<HizliPlatform, string>;
  fiyat: string;
}

export const BOS_FORM: HizliForm = {
  platform: "trendyol",
  filamentTypeId: "",
  gram: "",
  saat: "",
  dakika: "",
  desi: "1",
  fire: "0",
  // Canlı veride en sık seçim: küçük kargo poşeti + az naylon, bantsız.
  paket: "poset-kucuk",
  naylon: "low",
  bant: false,
  komisyon: { trendyol: "", hepsiburada: "", shopify: "" },
  fiyat: "",
};

const PLATFORMLAR: readonly HizliPlatform[] = ["trendyol", "hepsiburada", "shopify"];

/** Kayıttan okunan platform hâlâ geçerli mi (eski/bozuk dosyaya karşı). */
export function gecerliPlatformMu(p: unknown): p is HizliPlatform {
  return PLATFORMLAR.includes(p as HizliPlatform);
}

/** Formdaki metinler → çekirdek hesabın girdisi (masaüstü formuyla birebir aynı dönüşüm). */
export function formdanGirdi(form: HizliForm): HizliHesapGirdi {
  return {
    platform: form.platform,
    filamentTypeId: form.filamentTypeId,
    gram: sayiOku(form.gram) ?? 0,
    saat: (sayiOku(form.saat) ?? 0) + (sayiOku(form.dakika) ?? 0) / 60,
    desi: sayiOku(form.desi),
    firePct: sayiOku(form.fire) ?? 0,
    packagingOptionId: form.paket,
    nylonLevel: form.naylon,
    tapeUsed: form.bant,
    komisyonPct: sayiOku(form.komisyon[form.platform]),
    fiyat: sayiOku(form.fiyat),
  };
}

/** Yalnız rakam ve ondalık ayıracı kalsın (yapıştırılan "₺120,50" gibi metinler için). */
export function sayiMetni(metin: string): string {
  return metin.replace(/[^0-9.,]/g, "");
}

/**
 * Hesabın kuralları: filament fiyatları, ayarlar, komisyon/kargo/gider kuralları ve BUGÜNKÜ reklam
 * payı. Reklam oranı telefonun ürün ve sipariş kârıyla aynı çekirdek fonksiyondan (`reklamOraniIcin`).
 */
export function hizliHesapBaglami(
  filaments: FilamentType[],
  settings: Record<string, string>,
  rules: Rules
): HizliHesapBaglam {
  const simdi = Date.now();
  return {
    filaments,
    settings,
    commissionRules: rules.commission,
    cargoRules: rules.cargo,
    expenseRules: rules.expense,
    adRates: Object.fromEntries(
      PLATFORMLAR.map((p) => [p, reklamOraniIcin(rules.adBudgets ?? [], p, simdi)])
    ),
  };
}
