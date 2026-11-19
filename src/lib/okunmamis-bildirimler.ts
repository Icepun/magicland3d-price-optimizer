import { processSingleton } from "@/core/printers/process-singleton";

/**
 * KISA ÖMÜRLÜ ORTAK OKUMA — aynı veriyi birkaç saniye içinde isteyen yoklayıcılar tek sorgu paylaşır.
 *
 * `bayatOnbellek`ten FARKI: süre dolunca bayat veriyi vermez, taze okumayı BEKLER (eşzamanlı
 * çağrılar aynı okumayı paylaşır). Bildirim gibi "geç görünmesi kabul edilemez" veriler için:
 * en kötü durumda veri `omurMs` kadar eskidir, asla daha fazla değil.
 *
 * Kutu süreç genelidir (Next relay'i ve rotaları ayrı paketlere derliyor).
 */
export interface KisaBellek<T> {
  /** Taze veri varsa onu, yoksa `oku()` sonucunu verir. */
  al(oku: () => Promise<T>): Promise<T>;
  /** Belleği düşür — sonraki `al` yeniden okur (yerel bir yazmadan sonra çağrılır). */
  dusur(): void;
}

export function kisaBellek<T>(ad: string, omurMs: number): KisaBellek<T> {
  const kutu = processSingleton(`kisa_bellek_${ad}`, () => ({
    v: null as { at: number; data: T } | null,
    ucus: null as Promise<T> | null,
    nesil: 0,
  }));
  return {
    al(oku: () => Promise<T>): Promise<T> {
      const v = kutu.v;
      if (v && Date.now() - v.at < omurMs) return Promise.resolve(v.data);
      if (kutu.ucus) return kutu.ucus;
      const nesil = kutu.nesil;
      const p: Promise<T> = oku()
        .then((data) => {
          // Okuma sürerken düşürüldüyse bu sonuç eski olabilir: çağırana dön ama saklama.
          if (kutu.nesil === nesil) kutu.v = { at: Date.now(), data };
          return data;
        })
        .finally(() => {
          if (kutu.ucus === p) kutu.ucus = null;
        });
      kutu.ucus = p;
      return p;
    },
    dusur(): void {
      kutu.v = null;
      kutu.nesil++;
      kutu.ucus = null;
    },
  };
}

/** Bir Notification satırının zilin kullandığı alanları. */
export interface OkunmamisBildirim {
  id: string;
  type: string | null;
  severity: string;
  title: string;
  body: string;
  href: string;
  createdAt: Date | string | null;
}

/**
 * Okunmamış bildirimler — masaüstü bildirimi (12 sn) ile zil (20 sn) arasında paylaşılır.
 * Ömür, en sık yoklayıcının aralığından KISA: ana süreç her yoklamada taze okur, zil ise
 * az önce okunmuşsa onu kullanır.
 */
export const okunmamisBildirimBellegi = kisaBellek<OkunmamisBildirim[]>("okunmamisBildirimler", 8_000);
