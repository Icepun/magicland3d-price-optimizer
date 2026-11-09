/**
 * PARÇA İPTALİNİ ÇALIŞIR HÂLE GETİR — dilimleyici ayarından bağımsız.
 *
 * Klipper'ın parça iptali (`exclude_object`) g-code içindeki KOMUTLARA dayanır:
 *   EXCLUDE_OBJECT_DEFINE NAME=… CENTER=… POLYGON=…
 *   EXCLUDE_OBJECT_START NAME=…  …  EXCLUDE_OBJECT_END
 *
 * Oysa dilimleyiciler iki ayrı seçenek sunuyor ve ikisi karıştırılıyor:
 *   • "Label objects"  → yalnız `; printing object …` YORUMU yazar (OctoPrint eklentisi için)
 *   • "Exclude objects" → yukarıdaki KOMUTLARI yazar (Klipper'ın istediği bu)
 *
 * ÖLÇÜLDÜ (25 Ağu 2026, kullanıcının U1'inde basılan gerçek dosya): `gcode_label_objects = 1`
 * ama `exclude_object = 0`. Dosyada 2 parça yorumla etiketlenmişti, EXCLUDE_OBJECT komutu
 * SIFIRDI — bu yüzden panelde parça iptali hiç açılamıyordu. Aynı durum Neptune 4 Pro'da da
 * vardı; "sadece bir yazıcıda çalışıyor" görüntüsü buradan geliyordu.
 *
 * Bu modül eksik komutları yüklemeden hemen önce EKLER. Yorumlar korunur (insan okunurluğu
 * ve OctoPrint uyumu için), dosyanın kalanı BAYT BAYT aynı kalır — yalnız ekleme yapılır.
 *
 * MALİYET ÖLÇÜLDÜ (81 MB'lık dosya): tek geçişte ~700 ms, dosya %0,9 büyüyor. Dakikalarca
 * süren aktarımın yanında görünmez.
 */

/**
 * Klipper parametre değerini GÜVENLE kaçışla.
 *
 * ⚠️ ÖLÇÜLDÜ: Klipper parametreleri shlex ile (posix, commenters="#;") ayrıştırıyor.
 *   NAME=part#1        → sessizce "part"a KIRPILIR → YANLIŞ NESNE iptal edilir, hata YOK
 *   NAME=Max's Shroud  → "Malformed command" (OrcaSlicer #2027 tam bu)
 * Bu yüzden ad, boşluk/kesme/tırnak/kare/noktalı virgül/eşittir/ters bölü içeriyorsa
 * çift tırnağa alınır; ters bölü ve çift tırnak ayrıca kaçırılır.
 *
 * ⚠️ Ad ASLA büyütülmez, kırpılmaz, boşlukları değiştirilmez — Moonraker'ın verdiği dizge
 * neyse o gider. (Büyütme ayrıca Türkçe tuzağı taşır: toLocaleUpperCase("tr") "Çiçeği"yi
 * "ÇİÇEĞİ" yapar, Python upper() ise "ÇIÇEĞI" — eşleşme kaybolur.)
 */
export function klipperParamKacisla(deger: string): string {
  if (!/[\s'"#;=\\]/.test(deger)) return deger;
  return `"${deger.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const NL = 0x0a;
const BAS_YORUM = "; printing object ";
const SON_YORUM = "; stop printing object";

export interface ParcaKutu {
  ad: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Dosyadaki bir parça tanımı (`EXCLUDE_OBJECT_DEFINE`). */
export interface ExcludeTanim {
  /** Dosyada yazdığı gibi (Klipper yazıcıda BÜYÜK harfe çevirir — eşleme harf duyarsız yapılır). */
  name: string;
  center: [number, number];
  polygon: [number, number][];
}

/**
 * Dosyanın başındaki parça tanımlarını oku — baskı BAŞLAMADAN parça seçebilmek için.
 *
 * Orca/Snapmaker Orca tanımları dosya gövdesinin en başına, başlangıç makrosunun hemen önüne
 * yazıyor (U1'de doğrulandı: 211 MB'lık dosyada 354. satır, `PRINT_START` 361.). Ad tırnaklı
 * olabilir (`klipperParamKacisla` boşluklu/özel karakterli adı öyle yazar) → kaçışlar çözülür.
 * Poligon yoksa merkezin çevresine küçük bir kare çizilir; ikisi de yoksa parça atlanır.
 */
export function excludeTanimlariniOku(metin: string): ExcludeTanim[] {
  const sonuc: ExcludeTanim[] = [];
  const gorulen = new Set<string>();
  let i = metin.indexOf("EXCLUDE_OBJECT_DEFINE");
  while (i >= 0) {
    const son = metin.indexOf("\n", i);
    const satir = metin.slice(i, son < 0 ? metin.length : son);
    // Komut satırın BAŞINDA olmalı — yorumun içindeki geçiş ("; EXCLUDE_OBJECT_DEFINE …") komut değildir.
    const satirBasi = metin.lastIndexOf("\n", i - 1) + 1;
    const onunde = metin.slice(satirBasi, i);
    i = son < 0 ? -1 : metin.indexOf("EXCLUDE_OBJECT_DEFINE", son);
    if (onunde.trim()) continue;

    const adEs = /\bNAME=("(?:[^"\\]|\\.)*"|\S+)/.exec(satir);
    if (!adEs) continue;
    const name = adEs[1].startsWith('"')
      ? adEs[1].slice(1, -1).replace(/\\(["\\])/g, "$1")
      : adEs[1];
    if (!name || gorulen.has(name.toUpperCase())) continue;

    let polygon: [number, number][] = [];
    const polEs = /\bPOLYGON=(\[\[[^\s]*\]\])/.exec(satir);
    if (polEs) {
      try {
        const ham = JSON.parse(polEs[1]) as unknown;
        if (Array.isArray(ham)) {
          polygon = ham
            .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
            .map((p) => [Number(p[0]), Number(p[1])] as [number, number]);
        }
      } catch { /* bozuk poligon → merkezden kare */ }
    }
    const merEs = /\bCENTER=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(satir);
    let center: [number, number] | null = merEs ? [Number(merEs[1]), Number(merEs[2])] : null;
    if (!center && polygon.length) {
      const xs = polygon.map((p) => p[0]), ys = polygon.map((p) => p[1]);
      center = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    }
    if (!center) continue;
    if (polygon.length < 3) {
      const [cx, cy] = center;
      polygon = [[cx - 5, cy - 5], [cx + 5, cy - 5], [cx + 5, cy + 5], [cx - 5, cy + 5]];
    }
    gorulen.add(name.toUpperCase());
    sonuc.push({ name, center, polygon });
  }
  return sonuc;
}

/** Dosyada zaten EXCLUDE_OBJECT komutları var mı? (varsa DOKUNMA) */
export function excludeObjectKomutuVar(buf: Buffer): boolean {
  // Yalnız baştaki birkaç MB'a bak: komutlar varsa DEFINE en başta olur.
  const bakilacak = buf.subarray(0, Math.min(buf.length, 4 * 1024 * 1024));
  return bakilacak.includes("EXCLUDE_OBJECT_DEFINE") || bakilacak.includes("EXCLUDE_OBJECT_START");
}

function sayiOku(satir: string, harf: string): number | null {
  const i = satir.indexOf(harf);
  if (i < 0) return null;
  const v = parseFloat(satir.slice(i + harf.length));
  return Number.isFinite(v) ? v : null;
}

/**
 * Yorumları komutlara çevir.
 *
 * Dönüş `null` ise dosyaya DOKUNULMAZ: ya etiket yok, ya komutlar zaten var, ya da
 * beklenmedik bir şey gördük. Şüphede kalınca dosyayı olduğu gibi bırakmak, yanlış
 * dönüştürülmüş bir dosyayı yazıcıya göndermekten iyidir.
 */
export function excludeObjectEkle(buf: Buffer): { cikti: Buffer; parcalar: ParcaKutu[] } | null {
  if (excludeObjectKomutuVar(buf)) return null;
  if (!buf.includes(BAS_YORUM)) return null;

  const kutular = new Map<string, ParcaKutu>();
  const sira: string[] = [];
  /** Çıktı parçaları: özgün dilimler + araya giren komutlar. */
  const parcalar: Buffer[] = [];
  let kopyalandi = 0;
  let aktif: ParcaKutu | null = null;

  let satirBas = 0;
  while (satirBas < buf.length) {
    let satirSon = buf.indexOf(NL, satirBas);
    if (satirSon < 0) satirSon = buf.length;
    const ilk = buf[satirBas];

    if (ilk === 0x3b /* ; */) {
      const satir = buf.toString("latin1", satirBas, satirSon);
      if (satir.startsWith(BAS_YORUM)) {
        const ad = satir.slice(BAS_YORUM.length).trim();
        if (ad) {
          let k = kutular.get(ad);
          if (!k) {
            k = { ad, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
            kutular.set(ad, k);
            sira.push(ad);
          }
          aktif = k;
          // Yorumu KORU, hemen ardına komutu ekle.
          parcalar.push(buf.subarray(kopyalandi, satirSon));
          parcalar.push(Buffer.from(`\nEXCLUDE_OBJECT_START NAME=${klipperParamKacisla(ad)}`, "latin1"));
          kopyalandi = satirSon;
        }
      } else if (satir.startsWith(SON_YORUM)) {
        if (aktif) {
          parcalar.push(buf.subarray(kopyalandi, satirSon));
          parcalar.push(Buffer.from("\nEXCLUDE_OBJECT_END", "latin1"));
          kopyalandi = satirSon;
          aktif = null;
        }
      }
    } else if (aktif && ilk === 0x47 /* G */) {
      const ikinci = buf[satirBas + 1];
      if (ikinci === 0x30 /* 0 */ || ikinci === 0x31 /* 1 */) {
        const satir = buf.toString("latin1", satirBas, satirSon);
        const x = sayiOku(satir, " X");
        if (x != null) {
          if (x < aktif.minX) aktif.minX = x;
          if (x > aktif.maxX) aktif.maxX = x;
        }
        const y = sayiOku(satir, " Y");
        if (y != null) {
          if (y < aktif.minY) aktif.minY = y;
          if (y > aktif.maxY) aktif.maxY = y;
        }
      }
    }
    satirBas = satirSon + 1;
  }

  if (!sira.length) return null;
  parcalar.push(buf.subarray(kopyalandi));

  // Ölçüsü çıkarılamayan parça (hiç hareket görülmedi) → dönüşümü yapma; yarım bilgiyle
  // çizilen bir seçici kullanıcıyı yanlış parçayı iptal etmeye götürebilir.
  const liste: ParcaKutu[] = [];
  for (const ad of sira) {
    const k = kutular.get(ad)!;
    if (!Number.isFinite(k.minX) || !Number.isFinite(k.minY)) return null;
    liste.push(k);
  }

  const tanimlar = liste
    .map((k) => {
      const mx = ((k.minX + k.maxX) / 2).toFixed(3);
      const my = ((k.minY + k.maxY) / 2).toFixed(3);
      const p = `[[${k.minX},${k.minY}],[${k.maxX},${k.minY}],[${k.maxX},${k.maxY}],[${k.minX},${k.maxY}]]`;
      return `EXCLUDE_OBJECT_DEFINE NAME=${klipperParamKacisla(k.ad)} CENTER=${mx},${my} POLYGON=${p}`;
    })
    .join("\n");

  return {
    cikti: Buffer.concat([Buffer.from(`${tanimlar}\n`, "latin1"), ...parcalar]),
    parcalar: liste,
  };
}
