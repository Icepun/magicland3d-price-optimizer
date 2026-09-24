"use client";
/**
 * PARÇA SEÇİCİ (3B) — "Hangi parça bozuldu?" penceresinde tablanın 3B görünümü.
 *
 * Parçalar gerçek biçimleriyle çizilir; imlecin altındaki parça parlar, tıklayınca seçilir.
 * Numaralar listedekiyle AYNI (tabladaki yere göre) — liste ile 3B birbirini doğrular.
 * Seçim GPU'dan: görünen neyse o seçilir (bkz. lib/gcode-viz/parca-sahne).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { ParsedGcode } from "@/lib/gcode-viz/viz-pack";
import { buildParcaSahnesi, parcaCapalari, type ParcaSahnesi } from "@/lib/gcode-viz/parca-sahne";
import { parcalariEsle } from "@/lib/gcode-viz/parca-esle";
import type { MappedPart } from "@/app/printers/part-map";
import { cn } from "@/lib/utils";

export interface ParcaSecici3BProps {
  geom: ParsedGcode;
  parcalar: MappedPart[];
  /** İptal edilmiş parçaların ham adları. */
  iptaller: string[];
  secili: string | null;
  /** Şu an basılan parçanın ham adı. */
  basilan: string | null;
  /** Listeden gelen vurgu (parça düğmesinin üstüne gelindi). */
  disVurgu?: string | null;
  /** Basılan kısım (segment ilerlemesi); null = tamamı. */
  ilerleme: number | null;
  toolColors?: (string | null)[];
  reduceMotion: boolean;
  onSec: (name: string) => void;
  onUzerinde?: (name: string | null) => void;
  onHazir?: () => void;
  onHata?: () => void;
}

const BASLANGIC_AZ = Math.PI / 4;
const BASLANGIC_EL = 0.62;
const TIK_ESIGI_PX = 5;

export function ParcaSecici3B({
  geom, parcalar, iptaller, secili, basilan, disVurgu, ilerleme, toolColors, reduceMotion,
  onSec, onUzerinde, onHazir, onHata,
}: ParcaSecici3BProps) {
  const kutuRef = useRef<HTMLDivElement | null>(null);
  const sahneRef = useRef<ParcaSahnesi | null>(null);
  const etiketRef = useRef<(HTMLDivElement | null)[]>([]);
  const [hazir, setHazir] = useState(false);
  const [uzerinde, setUzerinde] = useState<string | null>(null);
  const [ipucu, setIpucu] = useState(true);

  // Parça k (1 tabanlı, paket) → yazıcı parçası (eşlenemezse null)
  const capalar = useMemo(() => parcaCapalari(geom), [geom]);
  const kdenParca = useMemo<(MappedPart | null)[]>(() => {
    const esle = parcalariEsle(
      capalar.map((c) => ({ anahtar: c.anahtar, merkez: c.merkez })),
      parcalar.map((p) => ({ name: p.name, center: p.center })),
    );
    return [null, ...esle.map((j) => (j >= 0 ? parcalar[j] : null))];
  }, [capalar, parcalar]);

  // Geri çağrılar döngüde ref'ten okunur (sahne her render'da yeniden kurulmasın).
  const geriRef = useRef({ onSec, onUzerinde, onHazir, onHata });
  useEffect(() => { geriRef.current = { onSec, onUzerinde, onHazir, onHata }; }, [onSec, onUzerinde, onHazir, onHata]);
  const durumRef = useRef({ iptaller, kdenParca });
  useEffect(() => { durumRef.current = { iptaller, kdenParca }; }, [iptaller, kdenParca]);

  // ── Sahne ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const kutu = kutuRef.current;
    if (!kutu) return;
    let renderer: THREE.WebGLRenderer;
    let sahne: ParcaSahnesi;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      sahne = buildParcaSahnesi(geom);
    } catch {
      geriRef.current.onHata?.();
      return;
    }
    sahneRef.current = sahne;
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
    tuval.style.touchAction = "none";
    kutu.prepend(tuval);

    let gen = 1, yuk = 1;
    const boyutla = () => {
      gen = kutu.clientWidth;
      yuk = kutu.clientHeight;
      if (!gen || !yuk) return;
      renderer.setSize(gen, yuk, false);
      sahne.camera.aspect = gen / yuk;
      sahne.camera.updateProjectionMatrix();
      kirliDis = true;
    };
    let kirliDis = true;
    boyutla();
    const ro = new ResizeObserver(boyutla);
    ro.observe(kutu);

    // Kamera durumu
    let az = BASLANGIC_AZ - (reduceMotion ? 0 : 0.55);
    let el = BASLANGIC_EL;
    let yakin = reduceMotion ? 1 : 0.86;
    const girisBas = performance.now();
    const girisSure = reduceMotion ? 0 : 900;
    let giriste = girisSure > 0;

    // İşaretçi
    let basili: { x: number; y: number; az: number; el: number; surukledi: boolean } | null = null;
    let secimIstek: { x: number; y: number } | null = null;
    let sonSecim = 0;
    let uzerindeK = 0;

    const konum = (e: PointerEvent | WheelEvent) => {
      const r = kutu.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const asagi = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const p = konum(e);
      basili = { x: p.x, y: p.y, az, el, surukledi: false };
      tuval.setPointerCapture(e.pointerId);
      giriste = false;
    };
    const hareket = (e: PointerEvent) => {
      const p = konum(e);
      if (basili) {
        const dx = p.x - basili.x, dy = p.y - basili.y;
        if (!basili.surukledi && Math.hypot(dx, dy) > TIK_ESIGI_PX) {
          basili.surukledi = true;
          setIpucu(false);
        }
        if (basili.surukledi) {
          az = basili.az - dx * 0.008;
          el = Math.min(1.45, Math.max(0.08, basili.el + dy * 0.006));
          kirliDis = true;
        }
        return;
      }
      secimIstek = p;
    };
    const yukari = (e: PointerEvent) => {
      if (!basili) return;
      const b = basili;
      basili = null;
      try { tuval.releasePointerCapture(e.pointerId); } catch { /* bırakılmış */ }
      if (b.surukledi) return;
      const p = konum(e);
      const k = sahne.sec(renderer, p.x, p.y, gen, yuk);
      const parca = durumRef.current.kdenParca[k] ?? null;
      if (parca && !durumRef.current.iptaller.includes(parca.name)) {
        setIpucu(false);
        geriRef.current.onSec(parca.name);
      }
    };
    const ayrildi = () => {
      secimIstek = null;
      if (uzerindeK !== 0) {
        uzerindeK = 0;
        setUzerinde(null);
        geriRef.current.onUzerinde?.(null);
      }
    };
    const teker = (e: WheelEvent) => {
      e.preventDefault();
      yakin = Math.min(3, Math.max(0.6, yakin * Math.exp(-e.deltaY * 0.0012)));
      giriste = false;
      kirliDis = true;
    };
    tuval.addEventListener("pointerdown", asagi);
    tuval.addEventListener("pointermove", hareket);
    tuval.addEventListener("pointerup", yukari);
    tuval.addEventListener("pointerleave", ayrildi);
    tuval.addEventListener("wheel", teker, { passive: false });

    const kayboldu = (e: Event) => { e.preventDefault(); geriRef.current.onHata?.(); };
    tuval.addEventListener("webglcontextlost", kayboldu);

    const v = new THREE.Vector3();
    let raf = 0;
    let sonT = performance.now();
    let ilk = true;
    const dongu = (t: number) => {
      raf = requestAnimationFrame(dongu);
      if (document.hidden) { sonT = t; return; }
      const dt = Math.min(0.1, (t - sonT) / 1000);
      sonT = t;

      if (giriste) {
        const u = Math.min(1, (t - girisBas) / girisSure);
        const e = 1 - Math.pow(1 - u, 3);
        az = BASLANGIC_AZ - 0.55 * (1 - e);
        yakin = 0.86 + 0.14 * e;
        kirliDis = true;
        if (u >= 1) giriste = false;
      }
      if (kirliDis) sahne.setKamera(az, el, yakin);

      // Üzerinde: imleç hareket ettikçe en fazla ~22 kez/sn seçim geçişi
      if (secimIstek && t - sonSecim > 45) {
        const p = secimIstek;
        secimIstek = null;
        sonSecim = t;
        const k = sahne.sec(renderer, p.x, p.y, gen, yuk);
        const parca = durumRef.current.kdenParca[k] ?? null;
        const secilebilir = parca && !durumRef.current.iptaller.includes(parca.name) ? k : 0;
        tuval.style.cursor = secilebilir ? "pointer" : "grab";
        if (secilebilir !== uzerindeK) {
          uzerindeK = secilebilir;
          const ad = secilebilir ? durumRef.current.kdenParca[secilebilir]?.name ?? null : null;
          setUzerinde(ad);
          geriRef.current.onUzerinde?.(ad);
        }
      }

      sahne.adim(dt);
      if (sahne.golgeli && sahne.golgeKirliMi()) renderer.shadowMap.needsUpdate = true;
      const kirli = sahne.kirliMi() || kirliDis;
      kirliDis = false;
      if (!kirli && !ilk) return;
      renderer.render(sahne.scene, sahne.camera);

      // Etiketler: parça çapası ekrana izdüşürülür (React render'ı olmadan).
      const etiketler = etiketRef.current;
      for (let k = 1; k < etiketler.length; k++) {
        const el_ = etiketler[k];
        if (!el_) continue;
        sahne.capaDunya(k, v).project(sahne.camera);
        const gorunur = v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1;
        el_.style.opacity = gorunur ? "" : "0";
        el_.style.transform = `translate(${((v.x + 1) / 2) * gen}px, ${((1 - v.y) / 2) * yuk}px) translate(-50%, -135%)`;
      }
      if (ilk) {
        ilk = false;
        setHazir(true);
        geriRef.current.onHazir?.();
      }
    };
    raf = requestAnimationFrame(dongu);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      tuval.removeEventListener("pointerdown", asagi);
      tuval.removeEventListener("pointermove", hareket);
      tuval.removeEventListener("pointerup", yukari);
      tuval.removeEventListener("pointerleave", ayrildi);
      tuval.removeEventListener("wheel", teker);
      tuval.removeEventListener("webglcontextlost", kayboldu);
      sahne.dispose();
      renderer.dispose();
      if (tuval.parentNode === kutu) kutu.removeChild(tuval);
      sahneRef.current = null;
    };
    // Hareket azaltma tercihi yalnız açılış animasyonunu etkiler; sahne onun için yeniden kurulmaz.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geom]);

  // Durumlar → sahne (yumuşak geçişle)
  useEffect(() => {
    const sahne = sahneRef.current;
    if (!sahne) return;
    for (let k = 1; k < kdenParca.length; k++) {
      const p = kdenParca[k];
      if (!p) continue;
      sahne.setDurum(k, {
        secili: p.name === secili,
        uzerinde: p.name === uzerinde || p.name === disVurgu,
        iptal: iptaller.includes(p.name),
      });
    }
    sahne.setSoluk(secili ? 0.3 : 0);
  }, [kdenParca, secili, uzerinde, disVurgu, iptaller]);

  useEffect(() => { sahneRef.current?.setIlerleme(ilerleme); }, [ilerleme, kdenParca]);

  const renkAnahtari = (toolColors ?? []).map((c) => c ?? "").join("|");
  useEffect(() => {
    if (!renkAnahtari) return;
    sahneRef.current?.setPalette({ toolColors: renkAnahtari.split("|").map((c) => c || null) });
  }, [renkAnahtari, kdenParca]);

  return (
    <div
      ref={kutuRef}
      className={cn("absolute inset-0 overflow-hidden", !reduceMotion && "transition-opacity duration-500", hazir ? "opacity-100" : "opacity-0")}
    >
      {/* Parça numaraları — konumları döngüde yazılır */}
      <div className="pointer-events-none absolute inset-0">
        {kdenParca.map((p, k) => {
          if (!p) return null;
          const iptal = iptaller.includes(p.name);
          const sec = p.name === secili;
          const ust = !sec && (p.name === uzerinde || p.name === disVurgu);
          return (
            <div
              key={p.name}
              ref={(el) => { etiketRef.current[k] = el; }}
              className="absolute left-0 top-0 will-change-transform"
            >
              <span
                className={cn(
                  "flex h-6 min-w-6 items-center justify-center rounded-full border px-1.5 text-[11px] font-bold tabular-nums shadow-md backdrop-blur-sm",
                  !reduceMotion && "transition-[background-color,color,border-color,transform] duration-200 motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:fade-in",
                  sec
                    ? "scale-110 border-[#ff5a4a] bg-[#ff5a4a] text-white"
                    : ust
                      ? "scale-105 border-[#3fd0ff] bg-[#3fd0ff] text-[#06222c]"
                      : iptal
                        ? "border-border bg-background/60 text-muted-foreground line-through"
                        : "border-white/20 bg-background/80 text-foreground",
                  p.name === basilan && !iptal && !sec && "ring-2 ring-[oklch(0.75_0.16_155)]",
                )}
                style={{ animationDelay: reduceMotion ? undefined : `${Math.min(12, k) * 35}ms` }}
              >
                {p.no}
              </span>
            </div>
          );
        })}
      </div>

      {hazir && ipucu && (
        <p className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background/75 px-3 py-1 text-[11px] text-muted-foreground backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in duration-500">
          Sürükleyerek çevir · parçaya tıklayarak seç
        </p>
      )}
    </div>
  );
}
