"use client";
/**
 * KAYNAK MODEL SAHNESİ — dilimleyicideki görüntünün ta kendisi.
 *
 * Gcode sahnesinden AYRI tutuldu (bilinçli): o sahne baskı yollarını çiziyor, ışığını
 * `tube-shading` şader yamasından üretiyor ve hiç `Light` içermiyor. Buraya standart bir
 * materyal koymak orada modeli SİMSİYAH gösterirdi.
 *
 * İKİ SESSİZ TUZAK (ikisi de burada kapatıldı):
 *  • `renderer.localClippingEnabled` açılmazsa `material.clippingPlanes` HİÇBİR ŞEY yapmaz —
 *    ilerleme kırpması sessizce çalışmaz. Depoda bu bayrak hiçbir yerde açık değildi.
 *  • Koordinat uzayı: gcode TABLA-MUTLAK (X≈128, Y≈128), STL/OBJ ise model uzayında. Mesh
 *    kendi sınır kutusundan hizalanır (XY merkez → 0, taban → 0); gcode sahnesinin dönüşümü
 *    buraya uygulanamaz.
 *
 * Kesit kapatılmıyor: kırpılan yüzey açık kalıyor ve baskının içi görünüyor — FDM parçası
 * gerçekten içi boş olduğu için bu yanlış değil, doğru.
 */
import * as THREE from "three";

export interface MeshSahne {
  sahne: THREE.Scene;
  mesh: THREE.Mesh;
  /** Modelin yüksekliği (mm) — ilerleme kırpması bunu kullanır. */
  yukseklik: number;
  /** Kamerayı modele oturtan uzaklık. */
  yaricap: number;
  /** 0..1 — baskının tamamlanan kısmı; model alttan yukarı açılır. */
  ilerlemeAyarla: (oran: number) => void;
  serbestBirak: () => void;
}

/** Filament rengi "#RRGGBB" → materyal rengi. Verilmezse dilimleyicinin nötr grisi. */
function modelRengi(renk?: string | null): THREE.Color {
  const c = new THREE.Color(0xd9dde4);
  if (renk && /^#?[0-9a-f]{6}$/i.test(renk.trim())) {
    c.set(renk.trim().startsWith("#") ? renk.trim() : `#${renk.trim()}`);
    // Çok koyu filament (siyah) koyu zeminde kaybolur — okunur bir tabana çek.
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    if (hsl.l < 0.28) c.setHSL(hsl.h, hsl.s * 0.8, 0.34);
  }
  return c;
}

/**
 * Sahneyi kurar. `geometri` merkezlenmiş gelmeli (mesh-load bunu yapıyor).
 * Model Z ekseni yukarı olacak şekilde döndürülür — STL/3MF baskı dünyasında Z yukarıdır.
 */
export function buildMeshSahne(
  geometri: THREE.BufferGeometry,
  secenek: { renk?: string | null } = {},
): MeshSahne {
  const sahne = new THREE.Scene();

  // ── Işık: dilimleyicinin okunur stüdyo düzeni ────────────────────────────────
  // Yönler GÖRÜŞ uzayında değil dünya uzayında; kamera döndükçe model gerçekçi döner.
  sahne.add(new THREE.HemisphereLight(0xdfe6f2, 0x161b26, 1.05));
  const anahtar = new THREE.DirectionalLight(0xffffff, 2.0);
  anahtar.position.set(-1.1, 1.5, 1.4);
  sahne.add(anahtar);
  const dolgu = new THREE.DirectionalLight(0xbfd0e8, 0.7);
  dolgu.position.set(1.4, -0.5, 0.7);
  sahne.add(dolgu);

  geometri.computeBoundingBox();
  const kutu = geometri.boundingBox ?? new THREE.Box3();
  const olcu = kutu.getSize(new THREE.Vector3());
  const yukseklik = Math.max(1e-3, olcu.z);

  /**
   * Kırpma düzlemi: normal -Z, yani düzlemin ALTINDA kalan kısım görünür.
   * `constant` tabandan tepeye yürütülür.
   */
  const kirpma = new THREE.Plane(new THREE.Vector3(0, 0, -1), yukseklik);

  const materyal = new THREE.MeshStandardMaterial({
    color: modelRengi(secenek.renk),
    roughness: 0.62,
    metalness: 0.02,
    // Kesitten içeri bakınca arka yüzler görünsün — parça içi boş olduğu için doğru olan bu.
    side: THREE.DoubleSide,
    clippingPlanes: [kirpma],
  });

  const mesh = new THREE.Mesh(geometri, materyal);
  // Model uzayında Z yukarı; sahneyi de öyle kurup kameranın `up`'ını Z yapıyoruz.
  mesh.frustumCulled = false;
  sahne.add(mesh);

  const yaricap = Math.max(olcu.x, olcu.y, olcu.z) * 0.5 || 1;

  return {
    sahne,
    mesh,
    yukseklik,
    yaricap,
    ilerlemeAyarla: (oran: number) => {
      const o = Math.max(0, Math.min(1, oran));
      // Geometri merkezlendiği için taban -h/2'de.
      kirpma.constant = -yukseklik / 2 + yukseklik * o;
    },
    serbestBirak: () => {
      geometri.dispose();
      materyal.dispose();
    },
  };
}

/** Kamerayı modele oturtur (Z yukarı, hafif üstten üç-çeyrek görünüm). */
export function meshKamerasi(yaricap: number, en: number, boy: number): THREE.PerspectiveCamera {
  const kam = new THREE.PerspectiveCamera(40, Math.max(0.0001, en / Math.max(1, boy)), yaricap / 100, yaricap * 60);
  kam.up.set(0, 0, 1);
  const d = (yaricap / Math.sin((40 * Math.PI) / 360)) * 1.15;
  kam.position.set(d * 0.42, -d * 0.72, d * 0.5);
  kam.lookAt(0, 0, 0);
  return kam;
}
