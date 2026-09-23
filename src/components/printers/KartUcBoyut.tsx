"use client";
/**
 * YAZICI KARTINDA CANLI 3B — basılan model yavaşça döner, basılan kısım ışıklı, kalanı silik cam,
 * nozul yazıcının gerçek konumunda akar. Görünüm 3B izleyiciyle aynı (boncuk-ortak.ts); sahne
 * gün boyu açık panoya göre hafif (kart-sahne.ts).
 *
 * KAYNAK TÜKETİMİ: pano saatlerce açık kalıyor ve birden çok kart aynı anda dönüyor.
 *  • En fazla ~30 kare/sn; kart ekranda değilken ya da pencere gizliyken HİÇ çizilmez
 *    (Electron'da `backgroundThrottling: false`, tarayıcının doğal freni yok).
 *  • Gölge haritası saniyede en fazla iki kez tazelenir; kamera dönerken hiç.
 *  • Hareket azaltma isteyen kullanıcıda kart dönmez, yalnız ilerleme değişince çizilir.
 */
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { VizPack, YolZamani } from "@/lib/gcode-viz/viz-pack";
import { buildKartSahnesi, paketOkuyucu } from "@/lib/gcode-viz/kart-sahne";
import { CanliTakipci, katmanSonSegment, type CanliOrnek } from "@/lib/gcode-viz/canli-konum";
import { HALE_KAPASITE } from "@/lib/gcode-viz/boncuk-ortak";

export interface KartUcBoyutProps {
  pack: VizPack;
  yz: YolZamani;
  /** Yazıcıdan gelen son ölçüm (yoklama başına yeni nesne). null → canlı veri yok. */
  ornek: CanliOrnek | null;
  /** Ölçüm takip edilemiyorsa (eski paket) kilitlenecek katman — 0 tabanlı. */
  katmanIdx: number | null;
  /** Baskı bitti ya da basılmıyor → tam model. */
  bitti: boolean;
  /** Kafa başına gerçek filament rengi. */
  toolColors?: (string | null | undefined)[];
  reduceMotion: boolean;
  /** İlk kare çizildi — kart yedek görseli söndürebilir. */
  onHazir?: () => void;
  /** WebGL yok ya da bağlam kaybedildi — kart yedek görsele döner. */
  onHata?: () => void;
}

/** Kartın kendi dönüşü (radyan/sn) — 30 sn'de bir tur. */
const DONUS_HIZI = (Math.PI * 2) / 30;
/** Kareler arası en az süre (ms) — ~30 kare/sn. */
const KARE_ARALIGI = 33;
/** Gölge tazeleme aralığı (ms). */
const GOLGE_ARALIGI = 500;

export function KartUcBoyut({
  pack, yz, ornek, katmanIdx, bitti, toolColors, reduceMotion, onHazir, onHata,
}: KartUcBoyutProps) {
  const kutuRef = useRef<HTMLDivElement | null>(null);
  const takipciRef = useRef<CanliTakipci | null>(null);
  const okuyucuRef = useRef<ReturnType<typeof paketOkuyucu> | null>(null);
  const setPaletRef = useRef<((renkler: (string | null | undefined)[]) => void) | null>(null);
  // Döngü React durumunu değil bu ref'i okur: her yoklamada sahne yeniden kurulmasın.
  const girdiRef = useRef({ katmanIdx, bitti, reduceMotion });
  const geriRef = useRef({ onHazir, onHata });
  useEffect(() => { girdiRef.current = { katmanIdx, bitti, reduceMotion }; }, [katmanIdx, bitti, reduceMotion]);
  useEffect(() => { geriRef.current = { onHazir, onHata }; }, [onHazir, onHata]);

  // Renk dizisi her render'da yeni bir referans olabilir → içeriğinden kararlı anahtar.
  const renkAnahtari = useMemo(() => (toolColors ?? []).map((c) => c ?? "").join("|"), [toolColors]);

  // ── Sahne ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const kutu = kutuRef.current;
    if (!kutu) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      geriRef.current.onHata?.();
      return;
    }
    const sahne = buildKartSahnesi(pack, yz);
    // Küçük kartta da iki kat çizim: uzaktan katmanlar pikselden ince, tek örnekte kumlanıyor.
    renderer.setPixelRatio(Math.min(2.5, Math.max(2, window.devicePixelRatio || 1)));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = sahne.golgeli;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    const tuval = renderer.domElement;
    tuval.style.width = "100%";
    tuval.style.height = "100%";
    tuval.style.display = "block";
    kutu.appendChild(tuval);

    const takipci = new CanliTakipci(yz);
    takipciRef.current = takipci;
    okuyucuRef.current = paketOkuyucu(pack, yz);
    setPaletRef.current = (renkler) => sahne.setPalette({ toolColors: renkler });

    const boyutla = () => {
      const w = kutu.clientWidth;
      const h = kutu.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      sahne.camera.aspect = w / h;
      sahne.camera.updateProjectionMatrix();
    };
    boyutla();
    const ro = new ResizeObserver(boyutla);
    ro.observe(kutu);

    let gorunur = true;
    const io = new IntersectionObserver((e) => { gorunur = e.some((x) => x.isIntersecting); }, { threshold: 0.01 });
    io.observe(kutu);

    const kayboldu = (e: Event) => {
      e.preventDefault();
      geriRef.current.onHata?.();
    };
    tuval.addEventListener("webglcontextlost", kayboldu);

    let raf = 0;
    let sonCizim = 0;
    let sonT = performance.now();
    let sonGolge = -Infinity;
    let golgeBekliyor = true;
    let aci = Math.PI / 4;
    let hazir = false;
    const dongu = (t: number) => {
      raf = requestAnimationFrame(dongu);
      if (document.hidden || !gorunur) { sonT = t; return; }
      if (t - sonCizim < KARE_ARALIGI) return;
      const dt = Math.min(0.1, (t - sonT) / 1000);
      sonT = t;
      sonCizim = t;
      const g = girdiRef.current;

      // İlerleme: canlı ölçüm → akan nozul; yoksa katman kilidi; bittiyse tam model.
      let p: number | null = null;
      let iz = 120;
      if (!g.bitti) {
        const canli = takipci.kullanilabilir ? takipci.ilerle(Date.now()) : null;
        if (canli != null) {
          p = canli;
          iz = Math.max(60, Math.min(HALE_KAPASITE, takipci.sonSaniyelerdekiSegment(p, 3)));
        } else if (g.katmanIdx != null) {
          p = katmanSonSegment(yz, g.katmanIdx);
        }
      }
      sahne.setProgress(p, iz);
      if (!g.reduceMotion) {
        aci += dt * DONUS_HIZI;
        sahne.setAci(aci);
      }
      if (sahne.golgeKirliMi()) golgeBekliyor = true;
      let golgeTazelendi = false;
      if (sahne.golgeli && golgeBekliyor && t - sonGolge > GOLGE_ARALIGI) {
        renderer.shadowMap.needsUpdate = true;
        golgeBekliyor = false;
        golgeTazelendi = true;
        sonGolge = t;
      }
      const kirli = sahne.kirliMi();
      if (hazir && !kirli && !golgeTazelendi) return;
      renderer.render(sahne.scene, sahne.camera);
      if (!hazir) {
        hazir = true;
        geriRef.current.onHazir?.();
      }
    };
    raf = requestAnimationFrame(dongu);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      tuval.removeEventListener("webglcontextlost", kayboldu);
      sahne.dispose();
      renderer.dispose();
      if (tuval.parentNode === kutu) kutu.removeChild(tuval);
      takipciRef.current = null;
      okuyucuRef.current = null;
      setPaletRef.current = null;
    };
  }, [pack, yz]);

  // Yeni ölçüm → takipçiye (sahneyi yeniden kurmadan).
  useEffect(() => {
    if (!ornek) return;
    takipciRef.current?.olc(ornek, okuyucuRef.current ?? undefined);
  }, [ornek]);

  // Gerçek filament renkleri (sonradan da gelebilir) — sahne yeniden kurulmaz.
  useEffect(() => {
    if (!renkAnahtari) return;
    setPaletRef.current?.(renkAnahtari.split("|").map((c) => c || null));
  }, [renkAnahtari, pack]);

  return <div ref={kutuRef} className="absolute inset-0" aria-hidden />;
}
