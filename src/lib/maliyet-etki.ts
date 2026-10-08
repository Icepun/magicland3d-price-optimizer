/**
 * MALİYET AYARI ETKİ ÖNİZLEMESİ — "kaydedersen kaç ürünün kârı ne kadar değişir?"
 * (9 Eki 2026 denetimi). İki ürün listesi karşılaştırılır: şu anki (önbellekteki) ve kaydedilmemiş
 * ayarlarla hesaplanan (`/api/products?ayarOnizleme=…`). İkisi de Ürünler'in AYNI hesabından
 * gelir; burada yalnız fark sayılır, yeni hesap yoktur.
 */
export interface EtkiUrunu {
  id: string;
  name: string;
  platforms: { platform: string; netProfit: number | null }[];
}

export interface EtkiSatiri {
  id: string;
  name: string;
  platform: string;
  once: number;
  sonra: number;
  fark: number;
}

export interface EtkiOzeti {
  /** Kârı en az bir ilanda değişen ürün sayısı. */
  etkilenenUrun: number;
  /** Kârı değişen ilan (ürün × platform) sayısı. */
  etkilenenIlan: number;
  /** Değişen ilanlarda satış başına ortalama fark (₺); değişen yoksa null. */
  ortalamaFark: number | null;
  /** Kârdan zarara geçen ilan sayısı. */
  zarargaGecen: number;
  /** Zarardan kâra geçen ilan sayısı. */
  karaGecen: number;
  /** En çok etkilenen 5 ÜRÜN (mutlak farka göre; ürün başına en büyük farklı ilanı). */
  enCok: EtkiSatiri[];
}

const ESIK = 0.005; // yarım kuruş altı yuvarlama gürültüsü

export function maliyetEtkisi(once: readonly EtkiUrunu[], sonra: readonly EtkiUrunu[]): EtkiOzeti {
  const onceHarita = new Map(once.map((u) => [u.id, u]));
  const satirlar: EtkiSatiri[] = [];
  for (const u of sonra) {
    const eski = onceHarita.get(u.id);
    if (!eski) continue;
    for (const p of u.platforms) {
      const e = eski.platforms.find((x) => x.platform === p.platform);
      if (e?.netProfit == null || p.netProfit == null) continue;
      const fark = p.netProfit - e.netProfit;
      if (Math.abs(fark) < ESIK) continue;
      satirlar.push({ id: u.id, name: u.name, platform: p.platform, once: e.netProfit, sonra: p.netProfit, fark });
    }
  }
  const toplam = satirlar.reduce((t, s) => t + s.fark, 0);
  return {
    etkilenenUrun: new Set(satirlar.map((s) => s.id)).size,
    etkilenenIlan: satirlar.length,
    ortalamaFark: satirlar.length ? toplam / satirlar.length : null,
    zarargaGecen: satirlar.filter((s) => s.once >= 0 && s.sonra < 0).length,
    karaGecen: satirlar.filter((s) => s.once < 0 && s.sonra >= 0).length,
    // Ürün başına TEK satır: aynı ürün üç platformda aynı farkla üç kez listeleniyordu.
    enCok: [
      ...satirlar
        .reduce((m, s) => {
          const e = m.get(s.id);
          if (!e || Math.abs(s.fark) > Math.abs(e.fark)) m.set(s.id, s);
          return m;
        }, new Map<string, EtkiSatiri>())
        .values(),
    ]
      .sort((a, b) => Math.abs(b.fark) - Math.abs(a.fark))
      .slice(0, 5),
  };
}
