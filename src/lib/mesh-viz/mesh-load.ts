"use client";
/**
 * KAYNAK MODEL YÜKLEME — parçaya bağlanan gerçek 3B model (STL / OBJ / proje .3mf).
 *
 * NEDEN AYRI BİR DOSYA: yazıcıya gönderdiğimiz baskı dosyaları DİLİMLENMİŞ ve içlerinde
 * geometri yok (ölçüldü: 157/157 Bambu dosyasında sıfır üçgen). Baskı yollarını çizerek
 * dilimleyicideki görüntüyü elde etmek de mümkün değil: model ölçeğinde bir şerit 1 pikselden
 * ince kalıyor, tüm yüzey aynı açıyla ışık alıyor ve düz bir leke çıkıyor. Gerçek yüzeyi
 * görmek için gerçek model gerekiyor.
 *
 * AYRIŞTIRMA MALİYETİ (ölçüldü, 17 Ağu 2026):
 *   STL 43,6 MB / 913 bin üçgen → 17 ms      (ikili biçim, doğrudan typed array)
 *   3MF 3,0 MB / 334 bin üçgen  → 368 ms     (zip + XML)
 *   3MF 2,2 MB / 223 bin üçgen  → 850 ms
 * 3MF pahalı olduğu için sonuç IndexedDB'ye yazılıyor; aynı model ikinci açılışta anında gelir.
 * (3MF ayrıştırıcısı `DOMParser` istiyor, o da Web Worker'da yok — bu yüzden ana iş parçacığında
 * çalışır ve maliyeti önbellekle bir kereye indirilir.)
 */
import * as THREE from "three";

export type MeshTuru = "stl" | "obj" | "3mf";

export interface YuklenenMesh {
  geometri: THREE.BufferGeometry;
  ucgen: number;
  /** Modelin gerçek ölçüsü (mm) — kart/izleyici bilgi satırı için. */
  olcu: THREE.Vector3;
}

export interface MeshIlerleme {
  asama: "indir" | "ayristir" | "hazirla";
  /** 0..1 */
  oran: number;
}

// ── IndexedDB: ayrıştırılmış konum dizisi ────────────────────────────────────────────────
const DB_ADI = "mlhub-mesh";
const DEPO = "geo";
const DB_SURUM = 1;
/** Çizim/ayrıştırma davranışı değişirse ARTIR — yoksa eski önbellek sonsuza dek kalır. */
const GEO_SURUMU = 1;

function dbAc(): Promise<IDBDatabase | null> {
  return new Promise((cozum) => {
    try {
      const istek = indexedDB.open(DB_ADI, DB_SURUM);
      istek.onupgradeneeded = () => {
        const db = istek.result;
        if (!db.objectStoreNames.contains(DEPO)) db.createObjectStore(DEPO, { keyPath: "anahtar" });
      };
      istek.onsuccess = () => cozum(istek.result);
      istek.onerror = () => cozum(null);
    } catch {
      cozum(null);
    }
  });
}

interface Kayit {
  anahtar: string;
  konum: ArrayBuffer;
  yazildi: number;
}

async function onbellektenAl(anahtar: string): Promise<Float32Array | null> {
  const db = await dbAc();
  if (!db) return null;
  return new Promise((cozum) => {
    try {
      const t = db.transaction(DEPO, "readonly").objectStore(DEPO).get(anahtar);
      t.onsuccess = () => {
        const k = t.result as Kayit | undefined;
        cozum(k?.konum ? new Float32Array(k.konum) : null);
      };
      t.onerror = () => cozum(null);
    } catch {
      cozum(null);
    }
  });
}

async function onbellegeYaz(anahtar: string, konum: Float32Array): Promise<void> {
  const db = await dbAc();
  if (!db) return;
  try {
    const kopya = konum.slice().buffer; // transfer edilmiş tamponu saklama
    db.transaction(DEPO, "readwrite").objectStore(DEPO).put({ anahtar, konum: kopya, yazildi: Date.now() } satisfies Kayit);
  } catch {
    /* kota — kritik değil, bir dahaki sefere yeniden ayrıştırılır */
  }
}

// ── Ayrıştırma ───────────────────────────────────────────────────────────────────────────

/** Yükleyicileri yalnız gerektiğinde getir — ana paket şişmesin. */
async function konumlariCikar(veri: ArrayBuffer, tur: MeshTuru): Promise<Float32Array> {
  if (tur === "stl") {
    const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
    const g = new STLLoader().parse(veri);
    return duzlestir(g);
  }
  if (tur === "obj") {
    const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
    const metin = new TextDecoder().decode(veri);
    return grubuBirlestir(new OBJLoader().parse(metin));
  }
  const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
  return grubuBirlestir(new ThreeMFLoader().parse(veri));
}

function duzlestir(g: THREE.BufferGeometry): Float32Array {
  const d = g.index ? g.toNonIndexed() : g;
  const p = d.attributes.position;
  return p.array instanceof Float32Array ? p.array : new Float32Array(p.array as ArrayLike<number>);
}

/**
 * Bir sahne grubundaki TÜM mesh'leri tek konum dizisinde birleştirir; her parçanın kendi
 * dünya dönüşümü uygulanır. Bambu proje dosyalarında plakadaki nesnelerin yerleşimi bu
 * dönüşümlerde duruyor — uygulanmazsa parçalar üst üste yığılır.
 */
function grubuBirlestir(grup: THREE.Object3D): Float32Array {
  grup.updateMatrixWorld(true);
  const parcalar: THREE.Mesh[] = [];
  grup.traverse((n) => {
    if ((n as THREE.Mesh).isMesh) parcalar.push(n as THREE.Mesh);
  });
  if (!parcalar.length) return new Float32Array(0);

  let toplam = 0;
  const hazir: { dizi: ArrayLike<number>; m: THREE.Matrix4 }[] = [];
  for (const p of parcalar) {
    const g = p.geometry.index ? p.geometry.toNonIndexed() : p.geometry;
    const a = g.attributes.position?.array;
    if (!a) continue;
    hazir.push({ dizi: a, m: p.matrixWorld });
    toplam += a.length;
  }

  const cikti = new Float32Array(toplam);
  const v = new THREE.Vector3();
  let j = 0;
  for (const { dizi, m } of hazir) {
    for (let i = 0; i < dizi.length; i += 3) {
      v.set(dizi[i], dizi[i + 1], dizi[i + 2]).applyMatrix4(m);
      cikti[j++] = v.x;
      cikti[j++] = v.y;
      cikti[j++] = v.z;
    }
  }
  return cikti;
}

// ── Genel giriş ──────────────────────────────────────────────────────────────────────────

/**
 * Parçanın kaynak modelini getirir ve çizime hazır geometri döndürür.
 * Model bağlı değilse `null` — çağıran bugünkü (dilimleyici görseli) yola düşer.
 */
export async function kaynakModeliYukle(
  fileId: string,
  onIlerleme?: (p: MeshIlerleme) => void,
): Promise<YuklenenMesh | null> {
  const bilgiYanit = await fetch(`/api/models/${fileId}/mesh?bilgi=1`).catch(() => null);
  if (!bilgiYanit || !bilgiYanit.ok) return null;
  const bilgi = (await bilgiYanit.json().catch(() => null)) as
    | { var: boolean; tur?: MeshTuru; boyut?: number; anahtar?: string }
    | null;
  if (!bilgi?.var || !bilgi.tur || !bilgi.anahtar) return null;

  const onbellekAnahtari = `g${GEO_SURUMU}:${bilgi.anahtar}`;
  let konum = await onbellektenAl(onbellekAnahtari);

  if (!konum) {
    onIlerleme?.({ asama: "indir", oran: 0 });
    const yanit = await fetch(`/api/models/${fileId}/mesh`);
    if (!yanit.ok) return null;

    // Belirli ilerleme: dosya büyük olabilir, kullanıcı boş ekrana bakmasın.
    const toplam = Number(yanit.headers.get("content-length") || bilgi.boyut || 0);
    let veri: ArrayBuffer;
    if (yanit.body && toplam > 0) {
      const okuyucu = yanit.body.getReader();
      const parcalar: Uint8Array[] = [];
      let alinan = 0;
      for (;;) {
        const { done, value } = await okuyucu.read();
        if (done) break;
        parcalar.push(value);
        alinan += value.length;
        onIlerleme?.({ asama: "indir", oran: Math.min(1, alinan / toplam) });
      }
      const hepsi = new Uint8Array(alinan);
      let o = 0;
      for (const p of parcalar) { hepsi.set(p, o); o += p.length; }
      veri = hepsi.buffer;
    } else {
      veri = await yanit.arrayBuffer();
    }

    onIlerleme?.({ asama: "ayristir", oran: 0 });
    konum = await konumlariCikar(veri, bilgi.tur);
    if (!konum.length) return null;
    void onbellegeYaz(onbellekAnahtari, konum);
  }

  onIlerleme?.({ asama: "hazirla", oran: 0.5 });
  const geometri = new THREE.BufferGeometry();
  geometri.setAttribute("position", new THREE.BufferAttribute(konum, 3));
  geometri.computeVertexNormals();
  geometri.computeBoundingBox();
  const kutu = geometri.boundingBox!;
  const olcu = kutu.getSize(new THREE.Vector3());
  // Modeli kendi merkezine al — kamera yerleştirmesi basitleşir.
  const merkez = kutu.getCenter(new THREE.Vector3());
  geometri.translate(-merkez.x, -merkez.y, -merkez.z);
  onIlerleme?.({ asama: "hazirla", oran: 1 });

  return { geometri, ucgen: Math.round(konum.length / 9), olcu };
}
