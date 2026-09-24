/**
 * TELEFONDAKİ 3B İZLEYİCİ — masaüstü kartındaki canlı 3B'nin (`components/printers/KartUcBoyut`)
 * React'sız hâli. Sahne kodu masaüstüyle AYNI modüller (kart-sahne, boncuk-ortak, canli-konum,
 * viz-pack): telefondaki model masaüstündekinin birebir aynısı.
 *
 * NASIL TELEFONA GİDER: `scripts/mobil-3b-paketle.mjs` bu dosyayı three.js dahil TEK bir betiğe
 * paketler ve `mobile/src/lib/izleyici3b/paket.generated.ts` içine metin olarak yazar. Telefon onu
 * yerel bir HTML dosyasına koyup derlemede zaten bulunan WebView'da (`@expo/dom-webview`) açar.
 * Expo'nun DOM bileşenleri OTA ile gelmediği için (yalnız native derlemeye gömülür) bu yol seçildi.
 * ⚠️ Bu dosya ya da içe aktardığı sahne modülleri değişirse paketi YENİDEN ÜRET — kök testi
 * (`src/lib/mobile-izleyici3b.test.ts`) kaynak özeti tutmayınca kırmızıya döner.
 *
 * Telefonla konuşma:
 *  • telefon → sayfa: `window.__mlhub.durum(<json>)` (WebView `injectJavaScript`)
 *  • sayfa → telefon: `window.ReactNativeWebView.postMessage(<json>)` — {tur, mesaj?}
 *
 * KAYNAK: kart yalnız görünürken çizer, en fazla ~30 kare/sn; dokunup sürükleyince model elle
 * döner, bırakınca birkaç saniye sonra kendi dönüşüne devam eder.
 */
import * as THREE from "three";
import { HALE_KAPASITE } from "./boncuk-ortak";
import { CanliTakipci, katmanSonSegment, resolvePackLayerIndex, type CanliOrnek } from "./canli-konum";
import { buildKartSahnesi, paketOkuyucu, type KartSahnesi } from "./kart-sahne";
import { decodeVizPack, layerAtBytePosition, yolZamaniKur, type VizPack, type YolZamani } from "./viz-pack";

/** Telefonun gönderdiği durum. */
export interface IzleyiciDurumu {
  paketUrl: string | null;
  /** Paketin içerik anahtarı — adres tazelense de aynı paket yeniden indirilmez. */
  paketKey: string | null;
  /** Yazıcının bildirdiği katman (1 tabanlı). */
  katman: number | null;
  dosyaKonumu: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  /** Ölçümün alındığı an (ms). */
  an: number;
  /** Baskı sürüyor ya da duraklatılmış (nozul çizilir). */
  basiliyor: boolean;
  duraklatildi: boolean;
  /** Takım başına gerçek filament rengi. */
  renkler: (string | null)[];
  hareketAzalt: boolean;
}

type Mesaj = { tur: "sayfa-hazir" } | { tur: "yukleniyor" } | { tur: "cizildi" } | { tur: "hata"; mesaj: string };

const DONUS_HIZI = (Math.PI * 2) / 30; // 30 sn'de bir tur (masaüstü kartıyla aynı)
const KARE_ARALIGI = 33;
const GOLGE_ARALIGI = 500;
/** Elle çevirdikten sonra kendi dönüşüne bu kadar sonra döner. */
const EL_BEKLEME_MS = 4000;

function gonder(m: Mesaj): void {
  try {
    (window as unknown as { ReactNativeWebView?: { postMessage: (s: string) => void } }).ReactNativeWebView?.postMessage(
      JSON.stringify(m),
    );
  } catch {
    /* köprü yoksa (tarayıcıda deneme) sessiz */
  }
}

interface Yuklu {
  key: string;
  pack: VizPack;
  yz: YolZamani;
  sahne: KartSahnesi;
  takipci: CanliTakipci;
  okuyucu: ReturnType<typeof paketOkuyucu>;
}

export function izleyiciyiBaslat(kutu: HTMLElement): void {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    gonder({ tur: "hata", mesaj: "Bu cihazda 3B çizim açılamadı." });
    return;
  }
  // Telefon ekranı yoğun; 3 kat çizim pili ve ısıyı boşa harcar, 2 kat yeterince keskin.
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  const tuval = renderer.domElement;
  tuval.style.width = "100%";
  tuval.style.height = "100%";
  tuval.style.display = "block";
  tuval.style.touchAction = "none";
  kutu.appendChild(tuval);
  tuval.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    gonder({ tur: "hata", mesaj: "3B çizim durdu (cihaz belleği)." });
  });

  let durum: IzleyiciDurumu | null = null;
  let yuklu: Yuklu | null = null;
  let yukleniyor: string | null = null;
  let hazirBildirildi = false;

  const boyutla = () => {
    const w = kutu.clientWidth;
    const h = kutu.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    if (yuklu) {
      yuklu.sahne.camera.aspect = w / h;
      yuklu.sahne.camera.updateProjectionMatrix();
    }
  };
  window.addEventListener("resize", boyutla);

  const paketiYukle = async (url: string, key: string) => {
    yukleniyor = key;
    gonder({ tur: "yukleniyor" });
    try {
      // R2 nesnesi `Content-Encoding: gzip` ile duruyor → WebView kendiliğinden açar.
      const yanit = await fetch(url);
      if (!yanit.ok) throw new Error(`HTTP ${yanit.status}`);
      const pack = decodeVizPack(await yanit.arrayBuffer());
      if (yukleniyor !== key) return; // bu arada başka paket istendi
      const yz = yolZamaniKur(pack);
      yuklu?.sahne.dispose();
      const sahne = buildKartSahnesi(pack, yz);
      renderer.shadowMap.enabled = sahne.golgeli;
      yuklu = { key, pack, yz, sahne, takipci: new CanliTakipci(yz), okuyucu: paketOkuyucu(pack, yz) };
      hazirBildirildi = false;
      boyutla();
      renklendir();
      olc();
    } catch (e) {
      if (yukleniyor === key) {
        gonder({ tur: "hata", mesaj: `3B model indirilemedi (${e instanceof Error ? e.message : "bağlantı"}).` });
      }
    } finally {
      if (yukleniyor === key) yukleniyor = null;
    }
  };

  const renklendir = () => {
    if (!yuklu || !durum?.renkler.some(Boolean)) return;
    yuklu.sahne.setPalette({ toolColors: durum.renkler });
  };

  /** Masaüstü sayfasındaki `canliOrnek` ile AYNI kurulum (printers/page.tsx). */
  const olc = () => {
    if (!yuklu || !durum || !durum.basiliyor) return;
    const { pack } = yuklu;
    const bytKatman = durum.dosyaKonumu != null ? layerAtBytePosition(pack.layerByteOffset, durum.dosyaKonumu) : null;
    const katmanIdx = resolvePackLayerIndex({
      layerCurrent: durum.katman,
      byteLayer: bytKatman,
      layerCount: pack.layerZ.length,
    });
    const ornek: CanliOrnek = {
      dosyaKonumu: durum.dosyaKonumu,
      nozulX: durum.x,
      nozulY: durum.y,
      nozulZ: durum.z,
      katmanIdx,
      duraklatildi: durum.duraklatildi,
      an: durum.an,
    };
    yuklu.takipci.olc(ornek, yuklu.okuyucu);
  };

  // ── Elle çevirme ──
  let aci = Math.PI / 4;
  let surukleX: number | null = null;
  let elZamani = 0;
  tuval.addEventListener("pointerdown", (e) => {
    surukleX = e.clientX;
    elZamani = performance.now();
    tuval.setPointerCapture(e.pointerId);
  });
  tuval.addEventListener("pointermove", (e) => {
    if (surukleX == null) return;
    aci -= ((e.clientX - surukleX) / Math.max(1, kutu.clientWidth)) * Math.PI * 1.5;
    surukleX = e.clientX;
    elZamani = performance.now();
    if (yuklu) yuklu.sahne.setAci(aci);
  });
  const birak = () => {
    surukleX = null;
    elZamani = performance.now();
  };
  tuval.addEventListener("pointerup", birak);
  tuval.addEventListener("pointercancel", birak);

  // ── Çizim döngüsü (KartUcBoyut ile aynı adımlar) ──
  let sonCizim = 0;
  let sonT = performance.now();
  let sonGolge = -Infinity;
  let golgeBekliyor = true;
  const dongu = (t: number) => {
    requestAnimationFrame(dongu);
    if (document.hidden || !yuklu || !durum) {
      sonT = t;
      return;
    }
    if (t - sonCizim < KARE_ARALIGI) return;
    const dt = Math.min(0.1, (t - sonT) / 1000);
    sonT = t;
    sonCizim = t;
    const { sahne, takipci, yz } = yuklu;

    let p: number | null = null;
    let iz = 120;
    if (durum.basiliyor) {
      const canli = takipci.kullanilabilir ? takipci.ilerle(Date.now()) : null;
      if (canli != null) {
        p = canli;
        iz = Math.max(60, Math.min(HALE_KAPASITE, takipci.sonSaniyelerdekiSegment(p, 3)));
      } else if (durum.katman != null) {
        const li = resolvePackLayerIndex({ layerCurrent: durum.katman, byteLayer: null, layerCount: yuklu.pack.layerZ.length });
        if (li != null) p = katmanSonSegment(yz, li);
      }
    }
    sahne.setProgress(p, iz);
    const elde = surukleX != null || t - elZamani < EL_BEKLEME_MS;
    if (!durum.hareketAzalt && !elde) {
      aci += dt * DONUS_HIZI;
      sahne.setAci(aci);
    }
    if (sahne.golgeKirliMi()) golgeBekliyor = true;
    let golgeTazelendi = false;
    if (sahne.golgeli && golgeBekliyor && !elde && t - sonGolge > GOLGE_ARALIGI) {
      renderer.shadowMap.needsUpdate = true;
      golgeBekliyor = false;
      golgeTazelendi = true;
      sonGolge = t;
    }
    if (hazirBildirildi && !sahne.kirliMi() && !golgeTazelendi) return;
    renderer.render(sahne.scene, sahne.camera);
    if (!hazirBildirildi) {
      hazirBildirildi = true;
      gonder({ tur: "cizildi" });
    }
  };
  requestAnimationFrame(dongu);

  (window as unknown as { __mlhub: { durum: (d: IzleyiciDurumu) => void } }).__mlhub = {
    durum: (d) => {
      const oncekiRenk = durum?.renkler.join("|");
      durum = d;
      if (d.paketUrl && d.paketKey && d.paketKey !== yuklu?.key && d.paketKey !== yukleniyor) {
        void paketiYukle(d.paketUrl, d.paketKey);
      }
      if (d.renkler.join("|") !== oncekiRenk) renklendir();
      olc();
    },
  };
  gonder({ tur: "sayfa-hazir" });
}
