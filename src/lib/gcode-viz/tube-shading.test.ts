/**
 * TÜP IŞIKLANDIRMASI — modelin "dilimleyicideki gibi" görünmesini sağlayan yama.
 *
 * NEDEN TEST: yama, three'nin `LineMaterial` fragment şaderindeki BİR SATIRA (çapa) dayanıyor.
 * three sürüm yükseltince o satır değişirse `String.replace` sessizce hiçbir şey yapmaz —
 * hata çıkmaz, test kırılmaz, yalnız model bir gün eski düz görünümüne döner. Bu dosya çapanın
 * hâlâ tuttuğunu ve yamanın gerçekten uygulandığını kilitler.
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
    expect(sonra).toContain("delta / mlLen");
  });

  /**
   * SIFIR UZUNLUK KORUMASI — macOS için önemli. Fragment tam tüp ekseninin üstüne düşerse
   * `delta` sıfır olur; çıplak `normalize` NaN üretir. Windows'ta (D3D) genelde siyah piksel
   * demektir ama macOS WebGL'i Metal üzerinden ANGLE ile çalışıyor ve NaN davranışı aynı
   * olmak zorunda değil. Bu test korumanın kaldırılmasını engeller.
   */
  it("sıfır uzunlukta NaN üretmez (macOS/Metal koruması)", () => {
    const { sonra } = yamala();
    expect(sonra).toContain("mlLen > 1e-6");
    expect(sonra).not.toMatch(/vec3 mlN = normalize\( delta \)/);
  });

  it("ışıklandırma YALNIZ dünya-birimli kipte devreye girer", () => {
    // Ekran-birimli kipte `delta` tanımsızdır; yama WORLD_UNITS koruması içinde olmalı,
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

  it("program önbellek anahtarı DEĞİŞİYOR — three eski programı geri vermesin", () => {
    const m = new LineMaterial({ worldUnits: true });
    const oncekiAnahtar = m.customProgramCacheKey();
    tupGibiIsiklandir(m);
    expect(m.customProgramCacheKey()).not.toBe(oncekiAnahtar);
  });
});
