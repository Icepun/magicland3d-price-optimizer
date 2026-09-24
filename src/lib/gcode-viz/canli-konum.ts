/**
 * CANLI KONUM — yazıcının bildirdiği konumu modeldeki şeride çevirir ve iki yoklama arasını
 * akıcı doldurur. Kart ve 3B izleyici AYNI hesabı kullanır.
 *
 * Kaynaklar (23 Eyl 2026'da canlı ölçüldü):
 *  • Moonraker (iki U1): `virtual_sdcard.file_position` (dosyada okunan bayt) + `motion_report
 *    .live_position` (nozulun GERÇEK XY'si). Bayt konumu hareket kuyruğu yüzünden gerçekte
 *    basılanın biraz önündedir; gerçek XY geriye doğru en yakın şeride oturtularak düzeltilir.
 *  • Bambu A1: raporda `mc_print_line_number` alanı var ama değeri hep "0". Tek güvenilir çapa
 *    KATMAN değişimi: yeni katman görüldüğü an nozul katmanın başına oturur, katman içinde
 *    dilimleyicinin süre tahminiyle ilerler ve katman bitmeden sonrakine geçmez.
 *
 * Yazıcı arayüze ~2 saniyede bir yoklanıyor. Aradaki boşluğu, paketteki yol başına süre
 * tahmini (F hızları) ve ölçülen hız oranı doldurur; yeni ölçüm gelince görüntü sıçramadan
 * ona yaklaşır.
 */
import type { YolZamani } from "./viz-pack";

export interface CanliOrnek {
  /** Moonraker: dosyada okunan bayt (virtual_sdcard.file_position). */
  dosyaKonumu?: number | null;
  /** Nozulun gerçek konumu (Moonraker motion_report) — mm, yazıcı koordinatı. */
  nozulX?: number | null;
  nozulY?: number | null;
  nozulZ?: number | null;
  /** Basılan katman — paketteki 0 tabanlı katman indeksi. */
  katmanIdx?: number | null;
  /** Duraklatılmış baskıda nozul yerinde durur. */
  duraklatildi?: boolean;
  /** Ölçümün yazıcıdan alındığı an (ms, Date.now()). */
  an: number;
}

/**
 * Görselleştirme paketindeki 0 TABANLI katman indeksi.
 * `layerCurrent` (1 tabanlı) TERCİH EDİLİR: `file_position` hareket kuyruğu yüzünden gerçekte
 * basılanın birkaç KB önündedir ve katmanı bir ileri gösterebilir. Katman yoksa bayt konumundan
 * çözülen indekse düşülür.
 */
export function resolvePackLayerIndex(p: {
  layerCurrent: number | null;
  byteLayer: number | null;
  layerCount: number;
}): number | null {
  if (p.layerCount <= 0) return null;
  const fromLayer = p.layerCurrent != null && p.layerCurrent > 0 ? Math.round(p.layerCurrent) - 1 : null;
  const idx = fromLayer ?? (p.byteLayer != null && p.byteLayer >= 0 ? p.byteLayer : null);
  if (idx == null) return null;
  return Math.min(p.layerCount - 1, Math.max(0, idx));
}

/** Artan dizide `deger`e eşit ya da küçük SON elemanın indeksi; yoksa -1. */
export function sonKucukEsit(dizi: ArrayLike<number>, deger: number, bas = 0, son = dizi.length): number {
  let lo = bas;
  let hi = son - 1;
  let sonuc = -1;
  while (lo <= hi) {
    const orta = (lo + hi) >> 1;
    if (dizi[orta] <= deger) { sonuc = orta; lo = orta + 1; } else hi = orta - 1;
  }
  return sonuc;
}

function sinirla(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/** Genel segment `k`yı içeren yol. */
export function yolBul(yz: YolZamani, k: number): number {
  const i = sonKucukEsit(yz.segBas, Math.max(0, Math.floor(k)));
  return Math.max(0, i);
}

/** Paket bayt konumu taşıyor mu (v3)? Eski paketlerde hepsi sıfır. */
export function baytVar(yz: YolZamani): boolean {
  const n = yz.baytSon.length;
  return n > 0 && yz.baytSon[n - 1] > 0;
}

/** Paket süre taşıyor mu (v3)? */
export function zamanVar(yz: YolZamani): boolean {
  const n = yz.zamanSon.length;
  return n > 0 && yz.zamanSon[n - 1] > 0;
}

/** Katmanın ilk segmenti (genel). Boş katmanda bir sonraki katmanın başı. */
export function katmanBasSegment(yz: YolZamani, li: number): number {
  const n = yz.katmanYolBas.length;
  if (n === 0) return 0;
  const k = sinirla(li, 0, n - 1);
  const yol = yz.katmanYolBas[k];
  if (yol < yz.segBas.length) return yz.segBas[yol];
  return yz.toplamSegment;
}

/** Katmanın son segmentinin BİTİŞİ (genel, dışlayıcı). */
export function katmanSonSegment(yz: YolZamani, li: number): number {
  const n = yz.katmanYolSon.length;
  if (n === 0) return 0;
  const k = sinirla(li, 0, n - 1);
  const bas = yz.katmanYolBas[k];
  const son = yz.katmanYolSon[k];
  if (son <= bas) return katmanBasSegment(yz, k);
  const yol = son - 1;
  return yz.segBas[yol] + yz.segSay[yol];
}

/** Genel segment ilerlemesinin (kesirli) katmanı. */
export function ilerlemeninKatmani(yz: YolZamani, p: number): number {
  const n = yz.katmanYolBas.length;
  if (n === 0) return -1;
  const k = Math.max(0, Math.ceil(p) - 1);
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const orta = (lo + hi) >> 1;
    if (katmanSonSegment(yz, orta) > k) hi = orta;
    else lo = orta + 1;
  }
  return lo;
}

/**
 * Bayt konumu → segment ilerlemesi (kesirli). Yolun içindeyse bayt oranıyla; iki yol arasında
 * (seyahat, geri çekme) önceki yolun SONU. Paket bayt taşımıyorsa null.
 */
export function bayttanIlerleme(yz: YolZamani, bayt: number): number | null {
  if (!baytVar(yz) || !Number.isFinite(bayt)) return null;
  const i = sonKucukEsit(yz.baytBas, bayt);
  if (i < 0) return 0;
  const b0 = yz.baytBas[i];
  const b1 = yz.baytSon[i];
  const oran = b1 > b0 ? sinirla((bayt - b0) / (b1 - b0), 0, 1) : 1;
  return yz.segBas[i] + oran * yz.segSay[i];
}

/** Segment ilerlemesi → tahmini baskı süresi (sn, dosya başından). */
export function ilerlemedenZaman(yz: YolZamani, p: number): number {
  if (yz.segBas.length === 0) return 0;
  const i = yolBul(yz, Math.max(0, Math.ceil(p) - 1));
  const k = yz.segSay[i];
  const oran = k > 0 ? sinirla((p - yz.segBas[i]) / k, 0, 1) : 1;
  return yz.zamanBas[i] + oran * (yz.zamanSon[i] - yz.zamanBas[i]);
}

/** Süre → segment ilerlemesi. İki yol arasında (seyahat) önceki yolun sonu. */
export function zamandanIlerleme(yz: YolZamani, t: number): number {
  if (yz.segBas.length === 0) return 0;
  const i = sonKucukEsit(yz.zamanBas, t);
  if (i < 0) return 0;
  const t0 = yz.zamanBas[i];
  const t1 = yz.zamanSon[i];
  const oran = t1 > t0 ? sinirla((t - t0) / (t1 - t0), 0, 1) : 1;
  return yz.segBas[i] + oran * yz.segSay[i];
}

/** Genel segment i'nin uçları [x1, y1, x2, y2, z] — kaynağa göre (paket ya da açılmış geometri). */
export type SegmentOkuyucu = (i: number, cikti: Float64Array) => void;

/**
 * Gerçek nozul XY'sini en yakın şeride oturt. Bayt konumu gerçek hareketin ÖNÜNDE olduğu için
 * arama `p`'den GERİYE doğru yapılır (biraz da ileri, ölçüm gürültüsüne karşı). Z verilirse
 * yalnız aynı yükseklikteki şeritlere bakılır — üst üste katmanlar XY'de çakışır.
 */
export function xyIleDuzelt(
  yz: YolZamani,
  oku: SegmentOkuyucu,
  p: number,
  x: number,
  y: number,
  z?: number | null,
  geri = 2500,
  ileri = 60,
): number {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return p;
  const k0 = Math.max(0, Math.ceil(p) - 1);
  const bas = Math.max(0, k0 - geri);
  const son = Math.min(yz.toplamSegment - 1, k0 + ileri);
  const s = new Float64Array(5);
  const ara = (zFiltresi: boolean): { i: number; t: number; d: number } => {
    let enIyi = -1;
    let enIyiT = 0;
    let enIyiD = Infinity;
    for (let i = son; i >= bas; i--) {
      oku(i, s);
      // Katmanlar 0,2 mm arayla üst üste: tolerans katman yüksekliğinden küçük olmalı.
      if (zFiltresi && Math.abs(s[4] - (z as number)) > 0.15) continue;
      const dx = s[2] - s[0];
      const dy = s[3] - s[1];
      const l2 = dx * dx + dy * dy;
      const t = l2 > 1e-12 ? sinirla(((x - s[0]) * dx + (y - s[1]) * dy) / l2, 0, 1) : 0;
      const px = s[0] + dx * t - x;
      const py = s[1] + dy * t - y;
      // Bayt konumunun ÖNÜNDEKİ şerit ancak belirgin şekilde daha yakınsa seçilir: nozul
      // okunan satırın gerisindedir, önünde olması gürültüdür.
      const d = px * px + py * py + (i > k0 ? 0.04 : 0);
      if (d < enIyiD - 1e-9) { enIyiD = d; enIyi = i; enIyiT = t; }
    }
    return { i: enIyi, t: enIyiT, d: enIyiD };
  };
  const zVar = z != null && Number.isFinite(z);
  let r = ara(zVar);
  // O yükseklikte aday yoksa (seyahatte Z kalkması) yüksekliğe bakmadan ara.
  if (zVar && r.i < 0) r = ara(false);
  // 3 mm'den uzak eşleşme güvenilmez (seyahat hareketi, başka parça) → bayt konumu kalsın.
  if (r.i < 0 || r.d > 9) return p;
  return r.i + r.t;
}

/** İki yoklama arasında ölçüm gelmezse en fazla bu kadar (baskı süresi, sn) ilerlenir. */
const ILERI_SINIR_SN = 6;
/** Görüntü bu kadar gerideyse/ilerideyse kaydırmak yerine atlar (sn). */
const ATLAMA_SN = 30;
/** Yeni ölçüme yaklaşma hızı (sn) — küçük sapmalar sıçramadan kapanır. */
const YAKINSAMA_SN = 0.35;

/**
 * CANLI TAKİPÇİ — ölçümleri alır, her karede gösterilecek ilerlemeyi verir.
 *
 * İçeride her şey "baskı süresi" (paketteki tahmin) cinsinden tutulur: yazıcının gerçek hızıyla
 * tahmin arasındaki oran (`oran`) ardışık ölçümlerden öğrenilir. Böylece ölçümler arasında nozul
 * doğru hızda akar; ölçüm gelince görüntü ona yumuşakça yaklaşır.
 */
export class CanliTakipci {
  private readonly yz: YolZamani;
  private readonly bayt: boolean;
  private olcumT: number | null = null;
  private olcumAn = 0;
  private gosterilenT: number | null = null;
  private sonAn = 0;
  /** Baskı süresi / gerçek süre. İvme yok sayıldığı için gerçekte biraz yavaş: 0,8 ile başla. */
  private oran = 0.8;
  private duraklatildi = false;
  /** Son iki ölçümde konum hiç değişmedi (ısınma, tabla ölçümü, bekleme): nozul yerinde durur. */
  private durgun = false;
  /** Yalnız katman bilinirken nozul katmanın sonunu geçmez. */
  private tavan = Infinity;
  private sonKatman: number | null = null;
  private katmanCapaAn = 0;
  private katmanCapaT = 0;

  constructor(yz: YolZamani) {
    this.yz = yz;
    this.bayt = baytVar(yz);
  }

  /** Takip edilebilir mi (paket v3, süre bilgisi var)? */
  get kullanilabilir(): boolean {
    return zamanVar(this.yz);
  }

  /** Yeni ölçüm. `oku` verilirse gerçek nozul XY'siyle düzeltme yapılır. */
  olc(o: CanliOrnek, oku?: SegmentOkuyucu): void {
    if (!this.kullanilabilir) return;
    this.duraklatildi = o.duraklatildi === true;

    if (this.bayt && o.dosyaKonumu != null && Number.isFinite(o.dosyaKonumu)) {
      let p = bayttanIlerleme(this.yz, o.dosyaKonumu);
      if (p == null) return;
      if (oku && o.nozulX != null && o.nozulY != null) {
        p = xyIleDuzelt(this.yz, oku, p, o.nozulX, o.nozulY, o.nozulZ);
      }
      this.tavan = Infinity;
      this.yeniOlcum(ilerlemedenZaman(this.yz, p), o.an);
      return;
    }

    if (o.katmanIdx != null && Number.isFinite(o.katmanIdx)) {
      const li = sinirla(Math.round(o.katmanIdx), 0, Math.max(0, this.yz.katmanYolBas.length - 1));
      const t0 = ilerlemedenZaman(this.yz, katmanBasSegment(this.yz, li));
      const t1 = ilerlemedenZaman(this.yz, katmanSonSegment(this.yz, li));
      this.tavan = t1;
      if (this.sonKatman === li) {
        // Aynı katman: yeni çapa yok. Görüntü katmanın başından gerideyse (ör. açılışta eski
        // katmanda kaldıysa) başa çek.
        if (this.gosterilenT != null && this.gosterilenT < t0) this.gosterilenT = t0;
        return;
      }
      const ilk = this.sonKatman == null;
      if (!ilk && li > (this.sonKatman ?? 0)) {
        // Katman süresinden hız oranı: iki katman başı arası baskı süresi / gerçek süre.
        const dtGercek = (o.an - this.katmanCapaAn) / 1000;
        if (dtGercek > 1) this.oranGuncelle((t0 - this.katmanCapaT) / dtGercek, 0.5);
      }
      this.sonKatman = li;
      this.katmanCapaAn = o.an;
      this.katmanCapaT = t0;
      this.olcumT = t0;
      this.olcumAn = o.an;
      if (ilk || this.gosterilenT == null || Math.abs(this.gosterilenT - t0) > ATLAMA_SN) this.gosterilenT = t0;
    }
  }

  private yeniOlcum(t: number, an: number): void {
    if (this.olcumT != null) {
      const dtGercek = (an - this.olcumAn) / 1000;
      const dT = t - this.olcumT;
      if (dtGercek >= 0.8 && dT >= 0 && !this.duraklatildi) this.oranGuncelle(dT / dtGercek, 0.35);
      // Aynı konum tekrar geldiyse ölçümler arası tahmin yürütülmez: aksi hâlde ısınırken nozul
      // her yoklamada birkaç saniye ileri gidip geri sıçrıyordu.
      this.durgun = dtGercek >= 0.8 && Math.abs(dT) < 1e-3;
    }
    this.olcumT = t;
    this.olcumAn = an;
    if (this.gosterilenT == null || Math.abs(this.gosterilenT - t) > ATLAMA_SN) this.gosterilenT = t;
  }

  private oranGuncelle(yeni: number, agirlik: number): void {
    if (!Number.isFinite(yeni) || yeni <= 0) return;
    this.oran = sinirla(this.oran * (1 - agirlik) + sinirla(yeni, 0.05, 5) * agirlik, 0.05, 5);
  }

  /** Şu an gösterilecek ilerleme (segment, kesirli). Ölçüm yoksa null. */
  ilerle(simdi: number): number | null {
    if (this.olcumT == null || this.gosterilenT == null) return null;
    const dt = this.sonAn > 0 ? sinirla((simdi - this.sonAn) / 1000, 0, 0.25) : 0;
    this.sonAn = simdi;
    const gecen = Math.max(0, (simdi - this.olcumAn) / 1000);
    const tahmin = this.duraklatildi || this.durgun
      ? this.olcumT
      : Math.min(this.olcumT + Math.min(ILERI_SINIR_SN, this.oran * gecen), this.tavan);
    if (Math.abs(tahmin - this.gosterilenT) > ATLAMA_SN) this.gosterilenT = tahmin;
    else this.gosterilenT += (tahmin - this.gosterilenT) * (1 - Math.exp(-dt / YAKINSAMA_SN));
    return zamandanIlerleme(this.yz, this.gosterilenT);
  }

  /** Son `sn` saniyede basılan segment sayısı — sıcak izin uzunluğu. */
  sonSaniyelerdekiSegment(p: number, sn: number): number {
    const t = ilerlemedenZaman(this.yz, p);
    return Math.max(0, p - zamandanIlerleme(this.yz, t - sn));
  }

  /** Test ve tanı için. */
  get hizOrani(): number {
    return this.oran;
  }
}
