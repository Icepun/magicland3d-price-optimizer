/**
 * ÇİFT DOKUNUŞ — telefondaki 3B sahnede "görünümü başa al" (mobil-izleyici). Saf, test edilir.
 *
 * Yalnız gerçek DOKUNUŞLAR sayılır: parmak kısa sürede ve neredeyse kıpırdamadan kalkmalı, iki
 * dokunuş aynı yere yakın olmalı. İki parmak inmesi (yakınlaştırma) dokunuş değildir.
 * NEDEN: ilk sürüm iki "parmak indi" arasına bakıyordu (< 300 ms) → modeli arka arkaya hızlıca
 * iki kez çeviren kullanıcının görünümü her seferinde sıfırlanırdı.
 */
export const DOKUNUS_EN_UZUN_MS = 250;
export const DOKUNUS_KIPIRDAMA_PX = 10;
/** İlk dokunuşun kalkışıyla ikincinin inişi arası. */
export const CIFT_DOKUNUS_ARALIK_MS = 300;
export const CIFT_DOKUNUS_MESAFE_PX = 40;

interface Nokta {
  x: number;
  y: number;
  t: number;
}

export interface CiftDokunusTakipcisi {
  /** İlk parmak indi. */
  indi(x: number, y: number, t: number): void;
  /** Tek parmak hareket etti. */
  oynadi(x: number, y: number): void;
  /** İkinci parmak indi — bu hareket dokunuş sayılmaz. */
  ikinciParmak(): void;
  /** Son parmak kalktı; çift dokunuş tamamlandıysa `true`. */
  kalkti(t: number): boolean;
  /** Sistem hareketi devraldı (pointercancel) — yarım kalan dokunuşu unut. */
  iptal(): void;
}

export function ciftDokunusTakipcisi(): CiftDokunusTakipcisi {
  let bas: Nokta | null = null;
  let kipirdadi = false;
  let onceki: Nokta | null = null;
  return {
    indi(x, y, t) {
      bas = { x, y, t };
      kipirdadi = false;
    },
    oynadi(x, y) {
      if (bas && Math.hypot(x - bas.x, y - bas.y) > DOKUNUS_KIPIRDAMA_PX) kipirdadi = true;
    },
    ikinciParmak() {
      kipirdadi = true;
    },
    kalkti(t) {
      const b = bas;
      bas = null;
      if (!b || kipirdadi || t - b.t > DOKUNUS_EN_UZUN_MS) {
        onceki = null;
        return false;
      }
      if (
        onceki &&
        b.t - onceki.t < CIFT_DOKUNUS_ARALIK_MS &&
        Math.hypot(b.x - onceki.x, b.y - onceki.y) < CIFT_DOKUNUS_MESAFE_PX
      ) {
        onceki = null;
        return true;
      }
      onceki = { x: b.x, y: b.y, t };
      return false;
    },
    iptal() {
      bas = null;
      onceki = null;
    },
  };
}
