/**
 * TÜP GİBİ IŞIKLANDIRMA — modelin "dilimleyicideki gibi" görünmesini sağlayan şey.
 *
 * SORUN: çizgi geometrisinin NORMALİ yoktur, dolayısıyla ışık alamaz. Kalın çizgiye geçmek
 * kalınlık verdi ama gölge vermedi; model hâlâ düz renkli şerit yumağı gibi duruyordu
 * ("slicerdaki gibi görünmüyorlar"). Dilimleyiciler her ekstrüzyonu ışıklandırılmış KATI
 * geometri olarak çizer; hacim hissini veren tek şey budur.
 *
 * ÇÖZÜM: three'nin `LineMaterial` şaderi, dünya-birimli kipte fragmentin tüp EKSENİNE olan
 * uzaklık vektörünü zaten hesaplıyor (`delta`). Bu vektör normalize edilince fragmentin
 * silindirik YÜZEY NORMALİ olur — yani ışıklandırmak için gereken her şey elimizde, ek
 * geometri ya da ek bellek olmadan. Milyonlarca segmentte de bedava çalışır.
 *
 * Koordinatlar GÖRÜŞ uzayında (şader "world" diyor ama kamera orijinde). Bu iyi: ışık kamerayla
 * birlikte döner, model hangi açıdan bakılırsa bakılsın okunur kalır — dilimleyicilerin yaptığı
 * da budur.
 */
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

/** Işık yönü (görüş uzayı) — sol üstten, hafif önden. */
const ISIK = "vec3(-0.35, 0.62, 0.70)";
/** Gölgede kalan yüzeyin taban aydınlığı: 0 olsaydı alt taraf tamamen siyah olurdu. */
const ORTAM = "0.46";
/** Ana ışığın gücü. */
const ANA = "0.62";
/** Parlama (keskin vurgu) — plastik hissi verir, fazlası oyuncak gibi gösterir. */
const PARLAMA = "0.16";

export function tupGibiIsiklandir(materyal: LineMaterial): void {
  materyal.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "gl_FragColor = vec4( diffuseColor.rgb, alpha );",
      /* glsl */ `
      #ifdef WORLD_UNITS
        // \`delta\` = fragmentin tüp ekseninden dışarı bakan vektörü → silindirik normal.
        vec3 mlN = normalize( delta );
        vec3 mlL = normalize( ${ISIK} );
        float mlDiff = max( dot( mlN, mlL ), 0.0 );
        // Yarım-Lambert: gölge tarafı da tamamen ölmesin, hacim okunmaya devam etsin.
        float mlWrap = mlDiff * 0.5 + 0.5;
        vec3 mlH = normalize( mlL + vec3( 0.0, 0.0, 1.0 ) );
        float mlSpec = pow( max( dot( mlN, mlH ), 0.0 ), 24.0 ) * ${PARLAMA};
        diffuseColor.rgb = diffuseColor.rgb * ( ${ORTAM} + ${ANA} * mlWrap ) + mlSpec;
      #endif
      gl_FragColor = vec4( diffuseColor.rgb, alpha );`,
    );
  };
  // Şader anahtarı DEĞİŞMELİ — aksi hâlde three aynı programı önbellekten verip yamayı atlar.
  materyal.customProgramCacheKey = () => "mlhub-tup-isik-v1";
}
