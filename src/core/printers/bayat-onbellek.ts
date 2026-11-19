import { processSingleton } from "./process-singleton";

/**
 * BAYATI HEMEN VER, ARKADA TAZELE — nadiren değişen küçük veritabanı okumaları için.
 *
 * NEDEN (19 Kas 2026 denetimi): panel (5 sn'de bir) ve relay (10 sn'de bir) aynı dört küçük
 * tabloyu okuyor. Süre dolunca çağıran sorguyu BEKLİYORDU ve tek-uçuş yoktu: Kasım'ın ilk 19
 * gününde `/api/printers` 617 kez 3 saniyeyi aştı, bunların 400'ü bu beklemeydi (perf.log).
 * Sorgu takıldığında her yeni yoklama aynı sorgunun bir kopyasını daha kuyruğa ekliyordu.
 *
 * Davranış:
 *   - Hiç veri yok → yüklemeyi bekler; eşzamanlı çağrılar AYNI sözü paylaşır (tek uçuş).
 *   - Veri taze → hemen döner.
 *   - Veri bayat → bayatı HEMEN döner, arkada tek bir tazeleme başlatır. Tazeleme başarısızsa
 *     bayat veri kalır ve kısa bir süre yeniden denenmez (takılan sunucuya yük binmesin).
 *   - Geçersiz kılma → veri SİLİNİR; sonraki çağrı taze veriyi bekler. Kullanıcının kendi
 *     yaptığı değişiklik (eşleştirme, yazıcı ekleme, dosya yükleme) bu yüzden anında görünür.
 *
 * ⚠️ Kutu `processSingleton` ŞART: Next, relay'i rotalardan ayrı pakete derliyor; modül
 * kapsamındaki durum iki kopya olur ve geçersiz kılma diğer pakete ulaşmaz. Aynı sebeple
 * geçersiz kılma yükleyiciyi bilmeden, yalnız ADLA yapılabilir (`bayatOnbellegiDusur`) —
 * böylece önbelleği kuran ağır modülü içe aktarmak gerekmez.
 */
interface BayatKutu<T> {
  v: { at: number; data: T } | null;
  ucus: Promise<T> | null;
  hataAt: number;
  nesil: number;
}

/** Tazeleme başarısız olduktan sonra bu süre boyunca yeniden denenmez (bayat veri sunulur). */
export const TAZELEME_HATA_BEKLEME_MS = 10_000;

function kutuAl<T>(ad: string): BayatKutu<T> {
  return processSingleton(`sc_bayat_${ad}`, () => ({ v: null, ucus: null, hataAt: 0, nesil: 0 }) as BayatKutu<T>);
}

export interface BayatOnbellek<T> {
  /** Veriyi ver (yukarıdaki kurallarla). Dönen nesne PAYLAŞILIR — çağıran değiştirmemeli. */
  al(): Promise<T>;
  /** Veriyi sil; sonraki `al()` taze veriyi bekler. */
  gecersizKil(): void;
}

export function bayatOnbellek<T>(ad: string, ttlMs: number, yukle: () => Promise<T>): BayatOnbellek<T> {
  const kutu = kutuAl<T>(ad);
  const tazele = (): Promise<T> => {
    if (kutu.ucus) return kutu.ucus;
    const nesil = kutu.nesil;
    const p: Promise<T> = yukle()
      .then((data) => {
        // Yükleme sürerken geçersiz kılındıysa bu sonuç ESKİ veridir: çağırana dön ama saklama.
        if (kutu.nesil === nesil) kutu.v = { at: Date.now(), data };
        return data;
      })
      .catch((e) => {
        if (kutu.nesil === nesil) kutu.hataAt = Date.now();
        throw e;
      })
      .finally(() => {
        if (kutu.ucus === p) kutu.ucus = null;
      });
    kutu.ucus = p;
    return p;
  };
  return {
    al(): Promise<T> {
      const v = kutu.v;
      if (!v) return tazele();
      const simdi = Date.now();
      if (simdi - v.at >= ttlMs && simdi - kutu.hataAt >= TAZELEME_HATA_BEKLEME_MS) {
        void tazele().catch(() => {
          /* bayat veri korunur; sonraki çağrı yeniden dener */
        });
      }
      return Promise.resolve(v.data);
    },
    gecersizKil(): void {
      bayatOnbellegiDusur(ad);
    },
  };
}

/** Adı verilen önbelleği düşür — yükleyiciyi (ve onun ağır modülünü) içe aktarmadan. */
export function bayatOnbellegiDusur(ad: string): void {
  const kutu = kutuAl<unknown>(ad);
  kutu.v = null;
  kutu.nesil++;
  kutu.ucus = null; // süren yükleme eski veriyi getirir; yeni çağrı kendi yüklemesini başlatsın
  kutu.hataAt = 0;
}

/** Önbellek adları — düşüren taraf (ör. `lib/cache-busting`) dizgiyi elle yazmasın. */
export const BAYAT_ONBELLEK = {
  eslesmeler: "eslesmeler",
  eslesenUrunler: "eslesenUrunler",
  yapilandirmalar: "yapilandirmalar",
  modelDosyalari: "modelDosyalari",
} as const;
