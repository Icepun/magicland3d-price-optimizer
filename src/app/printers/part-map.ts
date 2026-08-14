/**
 * PARÇA HARİTASI — tablanın tepeden görünüşünün SAF matematiği.
 *
 * NEDEN KONUM: tabladaki kopyaların adları birbirinin aynı olabiliyor
 * (UNDERBODY.STL_ID_0_COPY_0 / _ID_1_ / _ID_2_ — insan gözüyle ayırt edilemez). Salt isim
 * listesi gösteren bir arayüz, kullanıcıyı yanlış parçayı iptal etmeye fiilen davet eder.
 * Ham ad ekranda HİÇ görünmez; parçalar TABLADAKİ YERLERİNE göre numaralanır.
 *
 * ⚠️ ÖLÇEK `toolhead.axis_maximum`'DAN KURULMAZ. O, tabla değil kafa doklarını da içeren
 * HAREKET alanıdır (U1'de 271×335, tabla 270×270). Ölçek `bedFrameFor` ile gelir — aynı
 * çerçeve nozul noktasında da kullanılıyor, ikisi birbirini doğruluyor.
 */

export interface PartPolygon {
  name: string;
  center: [number, number];
  polygon: [number, number][];
}

export interface MappedPart {
  /** Yazıcıya gidecek HAM ad — ekranda gösterilmez. */
  name: string;
  /** Kullanıcının gördüğü sıra numarası (1 tabanlı), TABLADAKİ yere göre. */
  no: number;
  center: [number, number];
  polygon: [number, number][];
  /** Poligonun kapladığı alan (mm²) — çizim sırası buna göre. */
  alan: number;
}

/** Kapalı poligonun alanı (shoelace, işaretsiz). */
export function poligonAlani(p: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
  }
  return Math.abs(a) / 2;
}

/** Nokta poligonun içinde mi (even-odd). Sınır davranışı belirsiz — seçim için yeterli. */
export function noktaIcinde(x: number, y: number, p: [number, number][]): boolean {
  let icinde = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) icinde = !icinde;
  }
  return icinde;
}

/**
 * Parçaları TABLADAKİ yerlerine göre numaralandır: önce satırlar (ön → arka), satır içinde
 * sol → sağ.
 *
 * ⚠️ SATIR KÜMELEMESİ TOLERANSLI. Y'si tam eşit olan parçaları arayan bir kural bugünkü
 * veride şans eseri çalışır; yerleştirici mikro farklar (0,02 mm) üretince sıralama karışır
 * ve kullanıcı yanlış parçayı seçer. Tolerans, parçaların medyan derinliğinin üçte biridir.
 */
export function parcalariSirala(parcalar: PartPolygon[]): MappedPart[] {
  if (parcalar.length === 0) return [];

  const kutu = (p: [number, number][]) => {
    let minY = Infinity, maxY = -Infinity;
    for (const [, y] of p) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
    return maxY - minY;
  };
  const derinlikler = parcalar.map((p) => kutu(p.polygon)).sort((a, b) => a - b);
  const medyan = derinlikler[Math.floor(derinlikler.length / 2)] || 1;
  const tolerans = Math.max(1, medyan / 3);

  // Ön → arka: tablada Y ARTTIKÇA arkaya gidilir, yani küçük Y önde.
  const sirali = [...parcalar].sort((a, b) => a.center[1] - b.center[1]);
  const satirlar: PartPolygon[][] = [];
  for (const p of sirali) {
    const son = satirlar[satirlar.length - 1];
    if (son && Math.abs(p.center[1] - son[son.length - 1].center[1]) <= tolerans) son.push(p);
    else satirlar.push([p]);
  }

  const out: MappedPart[] = [];
  let no = 1;
  for (const satir of satirlar) {
    satir.sort((a, b) => a.center[0] - b.center[0]); // sol → sağ
    for (const p of satir) {
      out.push({ name: p.name, no: no++, center: p.center, polygon: p.polygon, alan: poligonAlani(p.polygon) });
    }
  }
  return out;
}

/** Çizim sırası: alanı BÜYÜK olan ÖNCE — küçük parça üstte kalır ve tıklanabilir olur. */
export function cizimSirasi(parcalar: MappedPart[]): MappedPart[] {
  return [...parcalar].sort((a, b) => b.alan - a.alan);
}

export interface Cerceve { minX: number; maxX: number; minY: number; maxY: number }

/**
 * mm → 0..1 ekran oranı.
 *
 * ⚠️ Y TERS ÇEVRİLİR: ekranda Y aşağı, tablada arkaya büyür. Bu işaret ters olursa harita
 * AYNALANIR ve kullanıcı tam bir güvenle YANLIŞ parçayı iptal eder — üstelik kopyalar
 * birbirinin aynı olduğu için hatayı fark etmesi imkânsızdır. Formül `nozzleDot` ile BİREBİR
 * aynıdır (panel-view.ts); ikisi birbirinin denetimidir.
 */
export function mmToOran(x: number, y: number, c: Cerceve): { left: number; top: number } {
  const w = Math.max(1e-6, c.maxX - c.minX);
  const h = Math.max(1e-6, c.maxY - c.minY);
  return { left: (x - c.minX) / w, top: (c.maxY - y) / h };
}

/** Poligonu SVG `points` dizesine çevir (0..100 kullanıcı birimi — viewBox ile eşleşir). */
export function poligonSvg(p: [number, number][], c: Cerceve): string {
  return p
    .map(([x, y]) => {
      const o = mmToOran(x, y, c);
      return `${(o.left * 100).toFixed(2)},${(o.top * 100).toFixed(2)}`;
    })
    .join(" ");
}
