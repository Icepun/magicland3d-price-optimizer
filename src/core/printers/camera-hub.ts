/**
 * KAMERA YAYIN MERKEZİ — bir yazıcının kamerasına TEK bağlantı, çok izleyici.
 *
 * NEDEN: masaüstündeki kamera penceresi ile telefona kare taşıyan aktarıcı (camera-relay) aynı
 * yazıcıyı aynı anda izleyebilir. Her biri kendi bağlantısını açsaydı:
 *   • yazıcıya iki kat yük biner — U1'in ek sorgular yüzünden ağdan düştüğü ölçüldü
 *     (bkz. transfer-state.ts),
 *   • Bambu raporları yalnız EN SON bağlanan istemciye gönderiyor (bkz. process-singleton.ts);
 *     kamera portunda ikinci bağlantı birinciyi susturabilir.
 * Burada kaynak bir kez açılır, her kare tüm abonelere dağıtılır, son abone ayrılınca kaynak
 * kapanır — kamera ancak biri izlerken açık kalır (kamera modüllerinin ana kuralı).
 *
 * ⚠️ `processSingleton`: Next, aktarıcıyı (instrumentation) rotalardan ayrı pakete derliyor;
 * modül kapsamındaki harita iki kopya olur ve paylaşım sessizce çalışmaz.
 */
import { processSingleton } from "./process-singleton";

export interface KameraAkisiKontrolu {
  durdur: () => void;
}

export interface KameraAbonesi {
  onKare: (jpeg: Buffer) => void;
  onHata: (mesaj: string) => void;
}

/** Kaynağı açan fonksiyon — kare ve hata geri çağrılarını alır, durdurulabilir akış döner. */
export type KameraKaynagi = (
  onKare: (jpeg: Buffer) => void,
  onHata: (mesaj: string) => void,
) => KameraAkisiKontrolu;

interface Yayin {
  aboneler: Set<KameraAbonesi>;
  akis: KameraAkisiKontrolu | null;
  sonKare: Buffer | null;
  sonKareAt: number;
}

/**
 * Yeni katılan izleyiciye elde duran son kare bu kadar tazeyse HEMEN verilir. Bambu 2,5 sn'de
 * bir kare gönderiyor; katılan pencere o süreyi boş beklemesin. Daha eskisi yalan olur.
 */
export const SON_KARE_TAZE_MS = 5_000;

const yayinlar = processSingleton("kamera_yayinlar", () => new Map<string, Yayin>());

/** Test ve tanı için: şu an açık yayın sayısı. */
export function acikYayinSayisi(): number {
  return yayinlar.size;
}

function dagit(liste: KameraAbonesi[], f: (a: KameraAbonesi) => void): void {
  for (const a of liste) {
    try {
      f(a);
    } catch {
      /* bir izleyicinin hatası diğerlerini durdurmasın */
    }
  }
}

/**
 * `anahtar` (yazıcı kimliği) için yayına katıl. Açık yayın yoksa `kaynak` çağrılıp açılır.
 * Dönen fonksiyon aboneliği bırakır; son abone ayrılınca kaynak durdurulur.
 *
 * Hata geri çağrısı HİÇBİR ZAMAN bu fonksiyon dönmeden çağrılmaz — çağıran taraf bırakma
 * fonksiyonunu elinde tutmadan kapanmayla uğraşmak zorunda kalmasın.
 */
export function kameraAbone(anahtar: string, kaynak: KameraKaynagi, abone: KameraAbonesi): () => void {
  let y = yayinlar.get(anahtar);
  if (!y) {
    const yeni: Yayin = { aboneler: new Set([abone]), akis: null, sonKare: null, sonKareAt: 0 };
    yayinlar.set(anahtar, yeni);
    y = yeni;
    const canli = () => yayinlar.get(anahtar) === yeni;
    try {
      yeni.akis = kaynak(
        (jpeg) => {
          if (!canli()) return;
          yeni.sonKare = jpeg;
          yeni.sonKareAt = Date.now();
          dagit([...yeni.aboneler], (a) => a.onKare(jpeg));
        },
        (mesaj) => {
          // Kaynak kendiliğinden bitti (bağlantı koptu, kamera uyanmadı…) → herkese haber ver.
          // Senkron gelirse bile abonelere bu fonksiyon döndükten sonra ulaşsın.
          queueMicrotask(() => {
            if (!canli()) return;
            yayinlar.delete(anahtar);
            const liste = [...yeni.aboneler];
            yeni.aboneler.clear();
            dagit(liste, (a) => a.onHata(mesaj));
          });
        },
      );
    } catch (e) {
      const mesaj = e instanceof Error && e.message ? e.message : "Kamera açılamadı.";
      queueMicrotask(() => {
        if (!canli()) return;
        yayinlar.delete(anahtar);
        const liste = [...yeni.aboneler];
        yeni.aboneler.clear();
        dagit(liste, (a) => a.onHata(mesaj));
      });
    }
  } else {
    const mevcut = y;
    mevcut.aboneler.add(abone);
    const kare = mevcut.sonKare;
    if (kare && Date.now() - mevcut.sonKareAt < SON_KARE_TAZE_MS) {
      queueMicrotask(() => {
        if (mevcut.aboneler.has(abone)) dagit([abone], (a) => a.onKare(kare));
      });
    }
  }

  const hedef = y;
  let birakildi = false;
  return () => {
    if (birakildi) return;
    birakildi = true;
    hedef.aboneler.delete(abone);
    if (hedef.aboneler.size === 0 && yayinlar.get(anahtar) === hedef) {
      yayinlar.delete(anahtar);
      try {
        hedef.akis?.durdur();
      } catch {
        /* zaten kapalı */
      }
    }
  };
}
