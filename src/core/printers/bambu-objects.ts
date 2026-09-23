/**
 * BAMBU PARÇA ATLAMA — 3MF'ten tabladaki parçaların kimliği ve yeri.
 *
 * Bambu (A1 yazılımı 01.08 dahil) baskı sürerken tek bir parçayı atlayabiliyor: MQTT
 * `print.command = "skip_objects"`, `obj_list = [identify_id…]`; atlananlar raporda `s_obj`
 * olarak geri geliyor. Kimlik ve konum iki ayrı dosyada:
 *
 *   Metadata/slice_info.config → <object identify_id="3446" name="Conveyors.stl_1" skipped="false"/>
 *                                 <metadata key="label_object_enabled" value="true"/>  (dilimlenmiş plaka)
 *   Metadata/plate_<n>.json     → bbox_objects: [{ id: 3671, name: "Conveyors.stl_1", bbox: [x0,y0,x1,y1] }]
 *
 * ⚠️ ÖLÇÜLDÜ (23 Eyl 2026, kullanıcının gerçek dosyaları): plate json'daki `id` identify_id
 * DEĞİL (3100 ≠ 3065, 463 ≠ 291). İkisi AD ve SIRA ile eşlenir; ad tekrar edebildiği için
 * ("Orange lights" ×7) aynı adın n. geçişi n. geçişle eşleşir.
 *
 * Dilimleyicide "parçaları etiketle" kapalıysa (`label_object_enabled=false`) yazıcı parçayı
 * atlayamaz — gcode'da parça sınırları yok. Tek parçalı dosyalarda Bambu Studio bunu kapatıyor.
 */

export interface BambuNesne {
  /** Yazıcıya gönderilecek kimlik (identify_id). */
  id: number;
  ad: string;
  /** Tabla üzerindeki kutu (mm): [x0, y0, x1, y1]; bilinmiyorsa null. */
  bbox: [number, number, number, number] | null;
}

export interface BambuNesneBilgisi {
  /** Parça etiketleme açık mı (atlama mümkün mü)? */
  etiketli: boolean;
  /** Dilimlenmiş plaka numarası (slice_info `index`). */
  plaka: number | null;
  nesneler: BambuNesne[];
}

function xmlAttr(etiket: string, ad: string): string | null {
  const m = new RegExp(`\\b${ad}="([^"]*)"`).exec(etiket);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null;
}

/**
 * `slice_info.config` + plate json'ları → parça listesi.
 * `plakaJsonlari`: dosya adı → içerik (ör. "Metadata/plate_12.json").
 */
export function bambuNesneleriniCoz(
  sliceInfo: string | null,
  plakaJsonlari: Record<string, string>,
): BambuNesneBilgisi {
  const bos: BambuNesneBilgisi = { etiketli: false, plaka: null, nesneler: [] };
  if (!sliceInfo) return bos;

  // İlk (dilimlenmiş) plaka bloğu.
  const plakaBlogu = /<plate>([\s\S]*?)<\/plate>/i.exec(sliceInfo)?.[1] ?? sliceInfo;
  const plakaNo = Number(/key="index"\s+value="(\d+)"/i.exec(plakaBlogu)?.[1]);
  const etiketli = /key="label_object_enabled"\s+value="true"/i.test(plakaBlogu);

  const ham: Array<{ id: number; ad: string }> = [];
  for (const m of plakaBlogu.matchAll(/<object\b[^>]*>/gi)) {
    const id = Number(xmlAttr(m[0], "identify_id"));
    const ad = xmlAttr(m[0], "name") ?? "";
    if (Number.isFinite(id) && id > 0) ham.push({ id, ad });
  }

  // Konumlar: bu plakanın json'u (yoksa tek json varsa o).
  const jsonAdlari = Object.keys(plakaJsonlari);
  const jsonAdi =
    (Number.isFinite(plakaNo) ? jsonAdlari.find((a) => new RegExp(`plate_${plakaNo}\\.json$`, "i").test(a)) : undefined) ??
    (jsonAdlari.length === 1 ? jsonAdlari[0] : undefined);
  const kutular = new Map<string, Array<[number, number, number, number]>>();
  if (jsonAdi) {
    try {
      const j = JSON.parse(plakaJsonlari[jsonAdi]) as { bbox_objects?: Array<{ name?: unknown; bbox?: unknown }> };
      for (const o of j.bbox_objects ?? []) {
        const ad = typeof o.name === "string" ? o.name : "";
        const b = Array.isArray(o.bbox) ? o.bbox.map(Number) : [];
        if (b.length !== 4 || b.some((n) => !Number.isFinite(n))) continue;
        const liste = kutular.get(ad) ?? [];
        liste.push([b[0], b[1], b[2], b[3]]);
        kutular.set(ad, liste);
      }
    } catch { /* bozuk json → konumsuz parçalar */ }
  }

  const kullanilan = new Map<string, number>();
  const nesneler = ham.map(({ id, ad }) => {
    const n = kullanilan.get(ad) ?? 0;
    kullanilan.set(ad, n + 1);
    return { id, ad, bbox: kutular.get(ad)?.[n] ?? null };
  });

  return { etiketli, plaka: Number.isFinite(plakaNo) ? plakaNo : null, nesneler };
}

/** Parça seçme haritası için: kutu → merkez + dikdörtgen poligon (tabla mm). */
export function bambuNesnePoligonlari(
  nesneler: BambuNesne[],
): Array<{ name: string; center: [number, number]; polygon: [number, number][] }> {
  return nesneler
    .filter((n) => n.bbox)
    .map((n) => {
      const [x0, y0, x1, y1] = n.bbox!;
      return {
        // Ekranda ham ad hiç gösterilmez (parçalar tabladaki yerine göre numaralanıyor); yazıcıya
        // giden kimlik doğrudan budur.
        name: String(n.id),
        center: [(x0 + x1) / 2, (y0 + y1) / 2] as [number, number],
        polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [number, number][],
      };
    });
}
