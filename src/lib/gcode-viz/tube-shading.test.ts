/**
 * TÜP IŞIKLANDIRMASI — modelin "dilimleyicideki gibi" görünmesini sağlayan yama.
 *
 * NEDEN TEST: yama, three'nin `LineMaterial` fragment şaderindeki ÇAPALARA dayanıyor —
 * hem değiştirilen satıra hem de kullandığı değişken adlarına (`p1`, `p2`, `len`, `params`,
 * `lineDir`, `linewidth`, `worldPos`). three sürüm yükseltince bunlardan biri değişirse ya
 * `String.replace` sessizce hiçbir şey yapmaz ya da şader derlenmez ve model HİÇ çizilmez.
 * Bu dosya çapaların hâlâ tuttuğunu ve yamanın gerçekten uygulandığını kilitler.
 */
import { describe, expect, it } from "vitest";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { tupGibiIsiklandir } from "./tube-shading";

/** three'nin gerçek şaderini alıp yamayı uygular; sonucu döndürür. */
function yamala(): { once: string; sonra: string } {
  const m = new LineMaterial({ worldUnits: true, linewidth: 0.42, vertexColors: true });
  const once = m.fragmentShader;
  tupGibiIsiklandir(m);
  const shader = { fragmentShader: m.fragmentShader, vertexShader: m.vertexShader, uniforms: m.uniforms };
  // three, programı derlerken bunu çağırır.
  (m.onBeforeCompile as (s: typeof shader) => void)(shader);
  return { once, sonra: shader.fragmentShader };
}

describe("tüp ışıklandırması", () => {
  it("ÇAPA hâlâ tutuyor — three'nin şaderinde beklenen satır var", () => {
    const m = new LineMaterial({ worldUnits: true });
    expect(m.fragmentShader).toContain("gl_FragColor = vec4( diffuseColor.rgb, alpha );");
  });

  it("yama GERÇEKTEN uygulanıyor (sessizce atlanmıyor)", () => {
    const { once, sonra } = yamala();
    expect(once).not.toContain("mlN");
    expect(sonra).toContain("mlN");
  });

  /**
   * KULLANDIĞIMIZ HER DEĞİŞKEN three'nin şaderinde GERÇEKTEN VAR MI?
   * Biri yeniden adlandırılırsa şader derlenmez ve model hiç çizilmez — bu, çalışma anında
   * fark edilen ama testte görünmeyen bir kırılmadır. Burada kilitleniyor.
   */
  it("dayandığımız değişkenler three'nin şaderinde duruyor", () => {
    const m = new LineMaterial({ worldUnits: true });
    for (const ad of ["vec3 p1", "vec3 p2", "float len", "vec2 params", "vec3 lineDir", "worldPos"]) {
      expect(m.fragmentShader).toContain(ad);
    }
  });

  /**
   * NORMALİN YÖNÜ — bu sınıf hatanın ta kendisi.
   * `delta` (= p1 - p2) eksen ile bakış ışını arasındaki ortak dikmedir, tanımı gereği
   * kameraya diktir. Onu normal saymak modeli düz bir leke yapıyordu. Doğru normal
   * eksenden DIŞARI bakan yönle (p2 - p1) kurulur.
   */
  it("normal DIŞARI bakan yönden kuruluyor, delta'dan değil", () => {
    const { sonra } = yamala();
    expect(sonra).toContain("normalize( p2 - p1 )");
    expect(sonra).not.toMatch(/vec3 mlN = \w*\s*delta/);
    expect(sonra).not.toContain("delta / mlLen");
  });

  it("merkezde kameraya, silüette dışarı bakıyor", () => {
    // mlD: 0 = tüpün ortası, 1 = kenar. Karışım bu orandan kuruluyor.
    const { sonra } = yamala();
    expect(sonra).toContain("mlOut * mlD");
    expect(sonra).toContain("sqrt( max( 0.0, 1.0 - mlD * mlD ) )");
  });

  /**
   * NaN KORUMASI — macOS için önemli. `alphaToCoverage` açılırsa `len` yarıçapı aşabilir ve
   * `sqrt(1 - d*d)` NaN üretir; Windows'ta (D3D) genelde siyah piksel demektir ama macOS
   * WebGL'i Metal üzerinden ANGLE ile çalışıyor ve davranış aynı olmak zorunda değil.
   */
  it("NaN üretmez — clamp ve sıfır uzunluk korumaları duruyor", () => {
    const { sonra } = yamala();
    expect(sonra).toContain("clamp( len / mlR, 0.0, 1.0 )");
    expect(sonra).toContain("mlTanL > 1e-4");
  });

  /** Segment uçlarında yüzey silindir değil küredir; eksen bileşeni orada atılmamalı. */
  it("segment UÇLARI ayrı ele alınıyor", () => {
    const { sonra } = yamala();
    expect(sonra).toContain("step( 1e-5, params.x )");
  });

  it("ışıklandırma YALNIZ dünya-birimli kipte devreye girer", () => {
    // Ekran-birimli kipte `p1`/`p2` tanımsızdır; yama WORLD_UNITS koruması içinde olmalı,
    // yoksa şader derlenmez ve model HİÇ çizilmez.
    const { sonra } = yamala();
    const i = sonra.indexOf("mlN");
    const oncesi = sonra.slice(0, i);
    expect(oncesi.lastIndexOf("#ifdef WORLD_UNITS")).toBeGreaterThan(oncesi.lastIndexOf("#endif"));
  });

  it("son atama korunuyor — renk yazılmadan kalmıyor", () => {
    const { sonra } = yamala();
    expect(sonra).toContain("gl_FragColor = vec4( diffuseColor.rgb, alpha );");
  });

  /**
   * ANAHTAR ARTMALI. Şader gövdesi değişip anahtar aynı kalırsa three önbellekteki ESKİ
   * programı verir; iyileştirme ekrana hiç ulaşmaz ve tsc/eslint/test üçü de temiz geçer.
   */
  it("program önbellek anahtarı DEĞİŞİYOR — three eski programı geri vermesin", () => {
    const m = new LineMaterial({ worldUnits: true });
    const oncekiAnahtar = m.customProgramCacheKey();
    tupGibiIsiklandir(m);
    expect(m.customProgramCacheKey()).not.toBe(oncekiAnahtar);
  });

  it("anahtar, şader gövdesi değişince ELDE artırılmış olmalı (v1 kaldı mı?)", () => {
    const m = new LineMaterial({ worldUnits: true });
    tupGibiIsiklandir(m);
    // v1 eski (hatalı) gövdeye aitti; yeni gövdeyle aynı anahtarı paylaşamaz.
    expect(m.customProgramCacheKey()).not.toBe("mlhub-tup-isik-v1");
  });
});
