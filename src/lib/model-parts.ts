/**
 * BASKIDAN ÖNCE PARÇA LİSTESİ — "bazı parçaları hiç basma" seçimi için, sunucu tarafı.
 *
 * Baskı sürerken parçalar yazıcıdan okunuyor (api/printers/[id]/parts). Baskı başlamadan ise
 * yazıcıda henüz bir şey yok; liste DOSYANIN KENDİSİNDEN çıkarılır ve adlar yazıcının baskı
 * sırasında göreceği adlarla AYNI olur:
 *   • Bambu (.3mf): `slice_info` + plaka json'ları → identify_id (yazıcıya giden kimlik).
 *   • Klipper/U1 (.gcode): dosyanın başındaki `EXCLUDE_OBJECT_DEFINE` satırları. Dosyada yalnız
 *     `; printing object` yorumları varsa yükleme sırasında `excludeObjectEkle` komutları ekliyor
 *     → aynı fonksiyon burada da çalıştırılır, adlar birebir aynı çıkar.
 *
 * Bulut dosyasında yalnız gereken kısım okunur (Bambu: zip dizini + iki küçük girdi; gcode:
 * ilk 4 MB). Sonuç dosya içeriğine bağlı olduğu için süreç boyunca önbellekte tutulur.
 */
import fs from "node:fs";
import { getR2Config, getObjectBytes, getObjectRange } from "./r2";
import { processSingleton } from "@/core/printers/process-singleton";
import { bambuNesneleriniCoz, bambuNesnePoligonlari } from "@/core/printers/bambu-objects";
import { bambuNesneGirdileri, bambuNesneGirdileriAralikli } from "@/core/printers/model-colors";
import { excludeObjectEkle, excludeTanimlariniOku } from "@/core/printers/exclude-object";
import type { PartPolygon } from "@/app/printers/part-map";

const BAS_OKUMA = 4 * 1024 * 1024;
const TTL_MS = 6 * 60 * 60_000;

export interface DosyaParcalari {
  parts: PartPolygon[];
  /** Parça seçilemiyorsa kullanıcıya tek satır neden. */
  neden?: string;
}

interface ModelDosyasi {
  id: string;
  originalName: string;
  fileType: string | null;
  sizeBytes: number;
  contentMd5: string | null;
  r2Key: string | null;
  storedPath: string;
}

const onbellek = processSingleton(
  "modelDosyaParcalari",
  () => new Map<string, { at: number; sonuc: DosyaParcalari }>(),
);

const ETIKETSIZ = "Bu dosyada parçalar ayrı ayrı işaretlenmemiş.";

function is3mf(mf: ModelDosyasi): boolean {
  return (mf.fileType ?? "").toLowerCase() === "3mf" || /\.3mf$/i.test(mf.originalName);
}

async function basiOku(mf: ModelDosyasi): Promise<Buffer | null> {
  const son = Math.min(mf.sizeBytes, BAS_OKUMA) - 1;
  if (son < 0) return null;
  if (mf.r2Key) {
    const cfg = await getR2Config();
    return cfg ? getObjectRange(mf.r2Key, cfg, 0, son) : null;
  }
  if (!mf.storedPath || !fs.existsSync(mf.storedPath)) return null;
  const fh = await fs.promises.open(mf.storedPath, "r");
  try {
    const buf = Buffer.alloc(son + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function tamaminiOku(mf: ModelDosyasi): Promise<Buffer | null> {
  if (mf.r2Key) {
    const cfg = await getR2Config();
    return cfg ? getObjectBytes(mf.r2Key, cfg) : null;
  }
  if (!mf.storedPath || !fs.existsSync(mf.storedPath)) return null;
  return fs.promises.readFile(mf.storedPath);
}

async function bambuParcalari(mf: ModelDosyasi): Promise<DosyaParcalari> {
  let girdiler = null;
  if (mf.r2Key) {
    const cfg = await getR2Config();
    if (cfg) {
      const key = mf.r2Key;
      girdiler = await bambuNesneGirdileriAralikli((a, b) => getObjectRange(key, cfg, a, b), mf.sizeBytes);
    }
  } else {
    const buf = await tamaminiOku(mf);
    if (buf) girdiler = bambuNesneGirdileri(buf);
  }
  if (!girdiler) return { parts: [], neden: "Dosya okunamadı." };
  const bilgi = bambuNesneleriniCoz(girdiler.sliceInfo, girdiler.plakaJsonlari);
  if (!bilgi.etiketli) return { parts: [], neden: ETIKETSIZ };
  return { parts: bambuNesnePoligonlari(bilgi.nesneler) };
}

async function gcodeParcalari(mf: ModelDosyasi): Promise<DosyaParcalari> {
  const bas = await basiOku(mf);
  if (!bas) return { parts: [], neden: "Dosya okunamadı." };
  const tanimlar = excludeTanimlariniOku(bas.toString("utf8"));
  if (tanimlar.length) return { parts: tanimlar };
  // Komut yok ama yorum varsa yükleme komutları ekleyecek — aynı adları burada da üret.
  // Yorumlar dosyanın her yerinde olduğu için bu yolda dosyanın tamamı gerekir.
  if (!bas.includes("; printing object ")) return { parts: [], neden: ETIKETSIZ };
  const tam = await tamaminiOku(mf);
  const eklenen = tam ? excludeObjectEkle(tam) : null;
  if (!eklenen) return { parts: [], neden: ETIKETSIZ };
  return {
    parts: eklenen.parcalar.map((k) => ({
      // excludeObjectEkle adı latin1 okuyup aynı baytları yazar; yazıcı UTF-8 okur.
      name: Buffer.from(k.ad, "latin1").toString("utf8"),
      center: [(k.minX + k.maxX) / 2, (k.minY + k.maxY) / 2] as [number, number],
      polygon: [[k.minX, k.minY], [k.maxX, k.minY], [k.maxX, k.maxY], [k.minX, k.maxY]] as [number, number][],
    })),
  };
}

/** Dosyanın parçaları. `bambuHedef`: dosya bir Bambu yazıcıya mı gidecek. */
export async function modelDosyaParcalari(mf: ModelDosyasi, bambuHedef: boolean): Promise<DosyaParcalari> {
  const anahtar = `${mf.id}|${mf.contentMd5 ?? ""}|${mf.sizeBytes}|${bambuHedef ? "b" : "k"}`;
  const hit = onbellek.get(anahtar);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.sonuc;

  // Kimlikler dosya türü + yazıcı türü eşleşince güvenilir: Bambu ↔ 3MF, Klipper ↔ G-code.
  // Çapraz durumlarda (Bambu'ya ham G-code, U1'e 3MF) yazıcının göreceği adlar bilinemez.
  let sonuc: DosyaParcalari;
  if (is3mf(mf) !== bambuHedef) sonuc = { parts: [], neden: "Bu dosyada parça seçimi yapılamıyor." };
  else if (bambuHedef) sonuc = await bambuParcalari(mf);
  else sonuc = await gcodeParcalari(mf);

  onbellek.set(anahtar, { at: Date.now(), sonuc });
  return sonuc;
}
