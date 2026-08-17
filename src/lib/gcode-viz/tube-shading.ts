/**
 * TÜP GİBİ IŞIKLANDIRMA — modelin "dilimleyicideki gibi" görünmesini sağlayan şey.
 *
 * SORUN: çizgi geometrisinin NORMALİ yoktur, dolayısıyla ışık alamaz. Kalın çizgiye geçmek
 * kalınlık verdi ama gölge vermedi; model hâlâ düz renkli bir leke gibi duruyordu.
 * Dilimleyiciler her ekstrüzyonu ışıklandırılmış KATI geometri olarak çizer; hacim hissini
 * veren tek şey budur.
 *
 * ÇÖZÜM: three'nin `LineMaterial` şaderi, dünya-birimli kipte fragmentin tüp EKSENİNE olan
 * en kısa vektörünü zaten hesaplıyor. Bundan gerçek silindir yüzey normali kurulabiliyor —
 * ek geometri ya da ek bellek olmadan, milyonlarca segmentte de bedava.
 *
 * ⚠️ ÖNCEKİ SÜRÜMÜN HATASI (16 Ağu 2026'da bulundu): `delta` yüzey normali sanılıyordu.
 * Oysa `delta = p1 - p2`, yani eksen ile BAKIŞ IŞINI arasındaki ortak dikme — tanımı gereği
 * daima kameraya diktir. Onu normal saymak her fragmenti yana baktırıyor, hiçbiri kameraya
 * dönmüyordu; ışık her yere neredeyse aynı açıyla vurduğu için model düz bir leke gibi
 * çıkıyordu. Doğrusu, merkeze yaklaştıkça kameraya, silüete yaklaştıkça dışarı bakan normal:
 *
 *   mlD  = 0 (tüpün ortası) …… 1 (silüet)
 *   mlN  = dışarı * mlD + kameraya * √(1 - mlD²)
 *
 * Koordinatlar GÖRÜŞ uzayında (şader "world" diyor ama kamera orijinde). Bu iyi: ışık kamerayla
 * birlikte döner, model hangi açıdan bakılırsa bakılsın okunur kalır — dilimleyicilerin yaptığı
 * da budur.
 */
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

/** Işık yönü (görüş uzayı) — sol üstten, hafif önden. */
const ISIK = "vec3(-0.35, 0.62, 0.70)";
/**
 * Gölgede kalan yüzeyin taban aydınlığı. Eskiden 0.46'ydı; dilimleyicilerin tabanı bunun
 * epey altında ve yüksek taban tek başına modeli yassılaştırıyor (normal düzelse bile).
 */
const ORTAM = "0.30";
/** Ana ışığın gücü. */
const ANA = "0.82";
/** Parlama (keskin vurgu) — plastik hissi verir, fazlası oyuncak gibi gösterir. */
const PARLAMA = "0.18";

export function tupGibiIsiklandir(materyal: LineMaterial): void {
  materyal.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "gl_FragColor = vec4( diffuseColor.rgb, alpha );",
      /* glsl */ `
      #ifdef WORLD_UNITS
        // Fragmentin tüp merkezinden uzaklığı: 0 = tam orta, 1 = silüet kenarı.
        // \`clamp\` ŞART: three yalnız \`norm > 0.5\` iken atıyor; biri MSAA için
        // \`alphaToCoverage\`'ı açarsa \`sqrt(1 - d*d)\` NaN olur ve macOS'ta (Metal/ANGLE)
        // davranış Windows'takiyle aynı olmak zorunda değildir.
        float mlR = linewidth * 0.5;
        float mlD = clamp( len / mlR, 0.0, 1.0 );

        // Eksenden DIŞARI bakan yön. (\`delta\` bunun tersi; işaret önemli, yoksa ışık
        // modelin yanlış tarafından vurur.)
        vec3 mlOut = normalize( p2 - p1 );
        vec3 mlCam = -normalize( worldPos.xyz );

        // Segmentin UÇLARINDA yüzey silindir değil KÜREDİR; orada eksen bileşenini atmak
        // yanlış olur. \`params.x\` 0/1'e kırpıldıysa uçtayız.
        float mlBody = step( 1e-5, params.x ) * step( params.x, 1.0 - 1e-5 );
        vec3 mlAxis = normalize( lineDir );
        vec3 mlTan = mlCam - mlAxis * ( dot( mlCam, mlAxis ) * mlBody );
        float mlTanL = length( mlTan );
        mlTan = mlTanL > 1e-4 ? mlTan / mlTanL : mlCam;

        vec3 mlN = normalize( mlOut * mlD + mlTan * sqrt( max( 0.0, 1.0 - mlD * mlD ) ) );

        vec3 mlL = normalize( ${ISIK} );
        float mlDiff = max( dot( mlN, mlL ), 0.0 );
        // Yarım-Lambert: gölge tarafı da tamamen ölmesin, hacim okunmaya devam etsin.
        float mlWrap = mlDiff * 0.78 + 0.22;
        vec3 mlH = normalize( mlL + vec3( 0.0, 0.0, 1.0 ) );
        float mlSpec = pow( max( dot( mlN, mlH ), 0.0 ), 26.0 ) * ${PARLAMA};
        diffuseColor.rgb = diffuseColor.rgb * ( ${ORTAM} + ${ANA} * mlWrap ) + mlSpec;
      #endif
      gl_FragColor = vec4( diffuseColor.rgb, alpha );`,
    );
  };
  // Şader anahtarı DEĞİŞMELİ — aksi hâlde three aynı programı önbellekten verip yamayı atlar
  // ve iyileştirme ekrana hiç ulaşmaz (tsc/eslint/test üçü de tertemiz geçerken).
  materyal.customProgramCacheKey = () => "mlhub-tup-isik-v2";
}
