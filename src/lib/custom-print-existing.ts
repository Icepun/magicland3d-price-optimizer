/**
 * Özel baskı kitaplığında aynı dosyanın (ad + boyut) yazıcı ailesinde zaten olup olmadığı.
 *
 * İki yerden kullanılır: yükleme ekranının ön kontrolü (`/api/custom-print/find`) ve yükleme
 * ucunun kendisi (ön kontrol atlansa bile ikinci satır açılmasın). Yanıt, yükleme ucunun
 * döndürdüğü özetle AYNI biçimdedir — ekran hangisinden geldiğini ayırt etmeden kullanır.
 */
import { prisma } from "./prisma";

const CUSTOM_PID = "__custom__";

export interface OzelBaskiOzeti {
  fileId: string;
  originalName: string;
  fileKind: "gcode" | "3mf" | "other";
  sizeBytes: number;
  grams: number | null;
  estPrintMin: number | null;
  thumbnail: string | null;
  colorCount: number;
  /** Bu kayıt önceden vardı (yeni yükleme yapılmadı). */
  mevcut: true;
}

export async function mevcutOzelBaskiOzeti(
  aile: string[],
  originalName: string,
  sizeBytes: number,
): Promise<OzelBaskiOzeti | null> {
  const satir = await prisma.productModelFile.findFirst({
    where: { productId: CUSTOM_PID, printerConfigId: { in: aile }, originalName, sizeBytes },
    orderBy: { createdAt: "desc" },
    select: { id: true, originalName: true, fileType: true, sizeBytes: true, gramaj: true, estPrintMin: true, colorsJson: true },
  });
  if (!satir) return null;
  // Önizleme görseli satırda data URL olarak duruyor ve yüzlerce KB — burada taşınmaz, kalıcı
  // önbellekli önizleme ucunun adresi verilir. Görsel yoksa uç 404 döner, ekran yedek simgeyi çizer.
  const gorselVar = await prisma.$queryRaw<{ var_mi: number }[]>`
    SELECT (thumbnail IS NOT NULL AND thumbnail != '') AS var_mi FROM ProductModelFile WHERE id = ${satir.id} LIMIT 1
  `;
  let renkSayisi = 0;
  try {
    const renk = satir.colorsJson ? (JSON.parse(satir.colorsJson) as { colors?: unknown[] }) : null;
    renkSayisi = Array.isArray(renk?.colors) ? renk!.colors!.length : 0;
  } catch { /* bozuk renk tablosu → 0 */ }
  const tur = (satir.fileType || "").toLowerCase();
  return {
    fileId: satir.id,
    originalName: satir.originalName,
    fileKind: tur === "3mf" ? "3mf" : ["gcode", "gco", "g"].includes(tur) ? "gcode" : "other",
    sizeBytes: satir.sizeBytes,
    grams: satir.gramaj,
    estPrintMin: satir.estPrintMin,
    thumbnail: Number(gorselVar?.[0]?.var_mi ?? 0) === 1 ? `/api/models/${satir.id}/preview` : null,
    colorCount: renkSayisi,
    mevcut: true,
  };
}
