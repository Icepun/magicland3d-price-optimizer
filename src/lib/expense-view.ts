/**
 * Gider Ödemeleri sayfasının saf görünüm mantığı — React'siz test edilebilsin diye ayrı.
 *
 * Sayfanın soruları: "bu dönemde ne kadar harcadım", "nereye harcadım", "geçen döneme göre
 * ne oldu". Hepsi ADET ve TUTAR sayımı; burada kâr/maliyet hesabı YOKTUR.
 *
 * Tarihler Türkiye duvar saatine göre bölünür (ülke kalıcı UTC+3): "bu ay" derken kullanıcı
 * Türkiye takvimini kastediyor, sunucunun UTC gününü değil.
 */

const TR_OFFSET_MS = 3 * 60 * 60 * 1000;
const GUN_MS = 86_400_000;

export type PeriyotTipi = "hafta" | "ay" | "3ay" | "6ay" | "yil";

export const PERIYOTLAR: Array<{ id: PeriyotTipi; label: string; kisa: string }> = [
  { id: "hafta", label: "Bu hafta", kisa: "Hafta" },
  { id: "ay", label: "Bu ay", kisa: "Ay" },
  { id: "3ay", label: "Son 3 ay", kisa: "3 ay" },
  { id: "6ay", label: "Son 6 ay", kisa: "6 ay" },
  { id: "yil", label: "Bu yıl", kisa: "Yıl" },
];

export interface Aralik {
  basMs: number;
  sonMs: number;
  /** Bir önceki eş uzunluktaki dönem — karşılaştırma için. */
  oncekiBasMs: number;
  oncekiSonMs: number;
}

/** Türkiye takvimine göre parçalar. */
function trParcalari(ms: number) {
  const d = new Date(ms + TR_OFFSET_MS);
  return {
    yil: d.getUTCFullYear(),
    ay: d.getUTCMonth(), // 0-11
    gun: d.getUTCDate(),
    haftaGunu: d.getUTCDay(), // 0 = Pazar
  };
}

/** Türkiye duvar saatiyle verilen tarihi gerçek UTC ms'e çevirir. */
function trAn(yil: number, ay: number, gun: number): number {
  return Date.UTC(yil, ay, gun, 0, 0, 0) - TR_OFFSET_MS;
}

/**
 * Seçilen periyodun aralığı.
 *
 * "Bu hafta" PAZARTESİ başlar — Türkiye'de hafta pazartesi başlar ve `getUTCDay()` pazarı 0
 * saydığı için naif bir hesap haftayı bir gün kaydırırdı.
 */
export function periyotAraligi(tip: PeriyotTipi, nowMs: number): Aralik {
  const { yil, ay, gun, haftaGunu } = trParcalari(nowMs);
  const sonMs = nowMs;

  if (tip === "hafta") {
    const pazartesiyeGeriSayi = (haftaGunu + 6) % 7; // Pazartesi=0, Pazar=6
    const basMs = trAn(yil, ay, gun) - pazartesiyeGeriSayi * GUN_MS;
    const uzunluk = 7 * GUN_MS;
    return { basMs, sonMs, oncekiBasMs: basMs - uzunluk, oncekiSonMs: basMs - 1 };
  }
  if (tip === "ay") {
    const basMs = trAn(yil, ay, 1);
    return { basMs, sonMs, oncekiBasMs: trAn(yil, ay - 1, 1), oncekiSonMs: basMs - 1 };
  }
  if (tip === "yil") {
    const basMs = trAn(yil, 0, 1);
    return { basMs, sonMs, oncekiBasMs: trAn(yil - 1, 0, 1), oncekiSonMs: basMs - 1 };
  }
  // 3ay / 6ay: içinde bulunulan ay DAHİL geriye doğru N ay.
  const aySayisi = tip === "3ay" ? 3 : 6;
  const basMs = trAn(yil, ay - (aySayisi - 1), 1);
  return {
    basMs,
    sonMs,
    oncekiBasMs: trAn(yil, ay - (aySayisi - 1) - aySayisi, 1),
    oncekiSonMs: basMs - 1,
  };
}

export interface GiderSatiri {
  id: string;
  name: string;
  category: string | null;
  amount: number;
  paidAt: string | null;
  note: string | null;
  recurringId: string | null;
}

/** Kategorisi girilmemiş giderlerin başlığı — grafikte de listede de aynı ad kullanılır. */
export const KATEGORISIZ = "Kategorisiz";

export function kategoriAdi(gider: GiderSatiri): string {
  const ad = (gider.category ?? "").trim();
  return ad || KATEGORISIZ;
}

function zamani(gider: GiderSatiri): number {
  const ms = gider.paidAt ? Date.parse(gider.paidAt) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/** Aralığa düşen giderler. Tarihi okunamayan satır DIŞARIDA kalır (uydurma tarih yok). */
export function araliktakiler<T extends GiderSatiri>(giderler: T[], bas: number, son: number): T[] {
  return giderler.filter((g) => {
    const ms = zamani(g);
    return Number.isFinite(ms) && ms >= bas && ms <= son;
  });
}

export interface KategoriDilimi {
  kategori: string;
  toplam: number;
  /** Dönem toplamındaki payı (0-100). */
  yuzde: number;
  adet: number;
  renk: string;
}

/**
 * Kategori dağılımı — grafiğin ve süzgeç çiplerinin kaynağı.
 *
 * Renk `renkOf` ile dışarıdan gelir: kategori renkleri kullanıcının kendi listesinden
 * okunuyor ki grafik her açılışta AYNI kategoriye AYNI rengi versin.
 */
export function kategoriDagilimi(
  giderler: GiderSatiri[],
  renkOf: (kategori: string, sira: number) => string
): KategoriDilimi[] {
  const acc = new Map<string, { toplam: number; adet: number }>();
  for (const g of giderler) {
    const ad = kategoriAdi(g);
    const tutar = Number(g.amount);
    if (!Number.isFinite(tutar)) continue;
    const mevcut = acc.get(ad) ?? { toplam: 0, adet: 0 };
    mevcut.toplam += tutar;
    mevcut.adet += 1;
    acc.set(ad, mevcut);
  }
  const toplam = [...acc.values()].reduce((s, v) => s + v.toplam, 0);
  return [...acc.entries()]
    // Büyükten küçüğe: "para nereye gitti" sorusunun cevabı en üstte olsun.
    .sort((a, b) => b[1].toplam - a[1].toplam || a[0].localeCompare(b[0], "tr-TR"))
    .map(([kategori, v], i) => ({
      kategori,
      toplam: v.toplam,
      yuzde: toplam > 0 ? (v.toplam / toplam) * 100 : 0,
      adet: v.adet,
      renk: renkOf(kategori, i),
    }));
}

export interface DonemOzeti {
  toplam: number;
  adet: number;
  oncekiToplam: number;
  /** Önceki döneme göre değişim yüzdesi; önceki dönem sıfırsa null (oran tanımsız). */
  degisimYuzde: number | null;
}

export function donemOzeti(giderler: GiderSatiri[], aralik: Aralik): DonemOzeti {
  const simdiki = araliktakiler(giderler, aralik.basMs, aralik.sonMs);
  const onceki = araliktakiler(giderler, aralik.oncekiBasMs, aralik.oncekiSonMs);
  const toplam = simdiki.reduce((s, g) => s + (Number(g.amount) || 0), 0);
  const oncekiToplam = onceki.reduce((s, g) => s + (Number(g.amount) || 0), 0);
  return {
    toplam,
    adet: simdiki.length,
    oncekiToplam,
    // BİLİNMEYEN ≠ SIFIR: önceki dönem boşken "%100 arttı" demek yanlış; oran yok.
    degisimYuzde: oncekiToplam > 0 ? ((toplam - oncekiToplam) / oncekiToplam) * 100 : null,
  };
}

/** Listeyi ay başlıklarıyla gruplar (yeniden eskiye). */
export interface AyGrubu<T extends GiderSatiri = GiderSatiri> {
  key: string;
  label: string;
  toplam: number;
  giderler: T[];
}

const AY_ADLARI = [
  "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
  "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık",
];

export function aylaraGore<T extends GiderSatiri>(giderler: T[]): Array<AyGrubu<T>> {
  const acc = new Map<string, T[]>();
  for (const g of giderler) {
    const ms = zamani(g);
    if (!Number.isFinite(ms)) continue;
    const { yil, ay } = trParcalari(ms);
    const key = `${yil}-${String(ay + 1).padStart(2, "0")}`;
    const list = acc.get(key) ?? [];
    list.push(g);
    acc.set(key, list);
  }
  return [...acc.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, list]) => {
      const [yil, ay] = key.split("-");
      return {
        key,
        label: `${AY_ADLARI[Number(ay) - 1]} ${yil}`,
        toplam: list.reduce((s, g) => s + (Number(g.amount) || 0), 0),
        giderler: list.sort((a, b) => zamani(b) - zamani(a)),
      };
    });
}
