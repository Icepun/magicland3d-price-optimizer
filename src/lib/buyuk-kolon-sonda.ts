/**
 * BÜYÜK İÇERİKLİ KOLON, TABLODA FİZİKSEL OLARAK **SON** KOLON OLMALI.
 *
 * ── 19 Kas 2026 ÖLÇÜMÜ: "hiçbir şey açılmıyor" ───────────────────────────────────────────────
 * `ProductModelFile.thumbnail` dilimleyicinin gömdüğü önizleme görselini (data URL) tutuyor:
 * 647 görsel, toplam 24 MB. Kolon tabloya SONRADAN eklendiği için satırın ORTASINDA kalmıştı;
 * ondan sonra eklenen `contentMd5` ve `mesh*` kolonları görselin ARKASINDAYDI.
 *
 * SQLite bir satırın N'inci kolonunu okumak için ondan önceki bütün baytları geçer; büyük
 * değerler taşma sayfalarında zincir halinde durur. Yani `contentMd5` okuyan her sorgu, baktığı
 * HER satırda görselin tamamını okuyordu — yanıtta görsel olmasa bile. Sonuç (Turso'nun kendi
 * dökümü, tek gün): basılan dosyayı eşleştirme sorgusu ortalama **40 sn**, "Baskı Başlat" listesi
 * ortalama **46 sn**, toplam 1,8 saat sunucu zamanı. Uygulama 6 saniyede kesip yeniden denediği
 * için sunucuda süren sorgular üst üste bindi ve EN BASİT sorgu bile saniyelerce bekledi.
 * Uygulama kapatılınca sunucu anında düzeldi (basit sorgu 113 ms → 0-2 ms): veritabanı değil,
 * kendi yükümüzdü.
 *
 * Görsel sona taşındıktan sonra aynı iki sorgu **1-9 ms**.
 *
 * ── NEDEN OTOMATİK ───────────────────────────────────────────────────────────────────────────
 * `ALTER TABLE … ADD COLUMN` yeni kolonu HER ZAMAN sona ekler. Bu tabloya ileride bir kolon
 * eklendiği gün o kolon yine görselin arkasında kalır ve aynı arıza sessizce geri gelir
 * (tsc, test, derleme — hiçbiri fark etmez; yalnız canlı veritabanında, veri büyüdükçe görünür).
 * Bu yüzden açılışta tek hafif bir denetim yapılır; görsel sonda değilse yeniden sona taşınır.
 *
 * Taşıma tek işlemdir (ya hepsi ya hiçbiri), veri değişmez — yalnız satır içindeki yeri değişir.
 */

export interface SemaCalistirici {
  /** Salt-okunur sorgu. */
  sorgu(sql: string): Promise<Array<Record<string, unknown>>>;
  /** İfadeleri TEK işlemde çalıştırır: biri başarısız olursa hiçbiri uygulanmaz. */
  islem(ifadeler: string[]): Promise<void>;
}

export type SonaTasimaSonucu =
  | "zaten-sonda"
  | "tasindi"
  | "tablo-yok"
  | "kolon-yok"
  /** Kolon NOT NULL ya da yarım kalmış bir taşıma izi var — dokunulmaz. */
  | "atlandi";

interface KolonBilgisi {
  name: string;
  type: string;
  notnull: number;
}

const tirnak = (ad: string) => `"${ad.replace(/"/g, '""')}"`;

async function kolonlar(c: SemaCalistirici, tablo: string): Promise<KolonBilgisi[]> {
  const satirlar = await c.sorgu(`PRAGMA table_info(${tirnak(tablo)})`);
  return satirlar.map((s) => ({
    name: String(s.name),
    type: String(s.type ?? ""),
    notnull: Number(s.notnull ?? 0),
  }));
}

/**
 * Satır ve dolu-kolon sayısı. `typeof()` içeriği OKUMADAN yalnız türe bakar — `IS NOT NULL`
 * ya da `COUNT(kolon)` yazılsaydı bu sayım bile görsellerin tamamını okurdu.
 */
async function sayim(c: SemaCalistirici, tablo: string, kolon: string): Promise<{ satir: number; dolu: number }> {
  const [s] = await c.sorgu(
    `SELECT COUNT(*) AS satir, COALESCE(SUM(typeof(${tirnak(kolon)}) <> 'null'), 0) AS dolu FROM ${tirnak(tablo)}`
  );
  return { satir: Number(s?.satir ?? 0), dolu: Number(s?.dolu ?? 0) };
}

/**
 * `kolon`u `tablo`nun son kolonu yapar. Zaten sondaysa hiçbir şey yazmaz.
 * Tekrar çalıştırmak güvenlidir.
 */
export async function buyukKolonuSonaTasi(
  c: SemaCalistirici,
  tablo: string,
  kolon: string
): Promise<SonaTasimaSonucu> {
  const mevcut = await kolonlar(c, tablo);
  if (mevcut.length === 0) return "tablo-yok";
  const hedef = mevcut.find((k) => k.name === kolon);
  if (!hedef) return "kolon-yok";

  const gecici = `${kolon}__son`;
  const eski = `${kolon}__eski`;
  const adlar = mevcut.map((k) => k.name);
  // İşlem atomik olduğu için geçici kolon yalnız elle müdahaleyle kalabilir; üstüne yazma.
  if (adlar.includes(gecici)) return "atlandi";

  const sonda = adlar[adlar.length - 1] === kolon;
  if (sonda && !adlar.includes(eski)) return "zaten-sonda";
  if (hedef.notnull) return "atlandi"; // taşıma sırasında eski kolon boşaltılıyor

  const once = await sayim(c, tablo, kolon);

  if (!sonda) {
    // Eski bir denemeden boş `__eski` kolonu kalmışsa adı çakışır; önce onu kaldır.
    if (adlar.includes(eski)) await eskiyiKaldir(c, tablo, eski);
    const tur = hedef.type ? ` ${hedef.type}` : "";
    await c.islem([
      `ALTER TABLE ${tirnak(tablo)} ADD COLUMN ${tirnak(gecici)}${tur}`,
      // SET'in sağ tarafı satırın ESKİ değerlerini okur: taşıma ve boşaltma tek ifadede güvenli.
      `UPDATE ${tirnak(tablo)} SET ${tirnak(gecici)} = ${tirnak(kolon)}, ${tirnak(kolon)} = NULL WHERE typeof(${tirnak(kolon)}) <> 'null'`,
      `ALTER TABLE ${tirnak(tablo)} RENAME COLUMN ${tirnak(kolon)} TO ${tirnak(eski)}`,
      `ALTER TABLE ${tirnak(tablo)} RENAME COLUMN ${tirnak(gecici)} TO ${tirnak(kolon)}`,
    ]);
    const sonra = await sayim(c, tablo, kolon);
    if (sonra.satir !== once.satir || sonra.dolu !== once.dolu) {
      throw new Error(
        `${tablo}.${kolon} sona taşınırken sayım tutmadı: ${once.satir}/${once.dolu} → ${sonra.satir}/${sonra.dolu}`
      );
    }
  }

  await eskiyiKaldir(c, tablo, eski);
  return "tasindi";
}

/** Boşaltılmış eski kolonu kaldırır. İçinde veri varsa DOKUNMAZ; kaldıramazsa sessizce bırakır. */
async function eskiyiKaldir(c: SemaCalistirici, tablo: string, eski: string): Promise<void> {
  try {
    const [s] = await c.sorgu(
      `SELECT COALESCE(SUM(typeof(${tirnak(eski)}) <> 'null'), 0) AS dolu FROM ${tirnak(tablo)}`
    );
    if (Number(s?.dolu ?? 0) !== 0) return;
    await c.islem([`ALTER TABLE ${tirnak(tablo)} DROP COLUMN ${tirnak(eski)}`]);
  } catch {
    /* boş bir kolonun kalması zararsız; sonraki açılış yeniden dener */
  }
}

/** Sonda tutulacak kolonlar. Yeni bir büyük kolon (görsel, uzun JSON) eklersen buraya da ekle. */
export const SONDA_TUTULAN_KOLONLAR: ReadonlyArray<readonly [tablo: string, kolon: string]> = [
  ["ProductModelFile", "thumbnail"],
];

/**
 * Açılış bakımı: listedeki kolonlar sonda mı? Değilse taşı. Hata uygulamayı ASLA etkilemez
 * (bir sonraki açılış yeniden dener). Normalde tablo başına tek hafif sorgudur.
 */
export async function buyukKolonlariSondaTut(c: SemaCalistirici): Promise<Array<{ tablo: string; kolon: string; sonuc: SonaTasimaSonucu | "hata" }>> {
  const sonuclar: Array<{ tablo: string; kolon: string; sonuc: SonaTasimaSonucu | "hata" }> = [];
  for (const [tablo, kolon] of SONDA_TUTULAN_KOLONLAR) {
    try {
      sonuclar.push({ tablo, kolon, sonuc: await buyukKolonuSonaTasi(c, tablo, kolon) });
    } catch {
      sonuclar.push({ tablo, kolon, sonuc: "hata" });
    }
  }
  return sonuclar;
}
