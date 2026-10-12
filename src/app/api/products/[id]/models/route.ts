import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getModelsDir } from "@/lib/storage";
import { createModelRows } from "@/lib/model-files";
import { getR2Config, isValidModelKey, headObjectSize, getObjectRange } from "@/lib/r2";
import { readModelBundle, readModelBundleAralikli } from "@/core/printers/model-colors";
import { saklanabilirGorsel } from "@/lib/model-gramaj";
import { renkleriCoz } from "@/lib/model-dosya-gorunum";

export const dynamic = "force-dynamic";

const ALLOWED = ["gcode", "gco", "g", "3mf"];

/** Dosyadan okunan pozitif sayı; değilse null (BİLİNMEYEN ≠ SIFIR). */
const olcum = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/**
 * Yeni satırı ekranın beklediği HAFİF biçime indirger: önizleme görseli (ortalama 61 KB) ve
 * renk tablosu satırla birlikte gönderilmez; "görsel var mı" ve çizilecek renkler yeter.
 */
function hafifYanit<T extends { thumbnail?: string | null; colorsJson?: string | null; plateJson?: string | null }>(row: T) {
  const { thumbnail, colorsJson, plateJson: _plateJson, ...kalan } = row;
  void _plateJson;
  return { ...kalan, hasThumbnail: !!thumbnail, renkler: renkleriCoz(colorsJson) };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    // KOLONLAR TEK TEK. `thumbnail` kolonunda gömülü önizleme görselleri duruyor; ÖLÇÜLDÜ
    // (14 Ağu 2026): en ağır üründe 24 satır = 2,08 MB. Kart görseli artık satır içinde
    // gelmiyor, `/api/models/<id>/preview` ucundan (kalıcı önbellekli) çekiliyor.
    const files = await prisma.productModelFile.findMany({
      where: { productId: id },
      select: {
        id: true, productId: true, printerConfigId: true, label: true,
        originalName: true, storedPath: true, r2Key: true, fileType: true,
        sizeBytes: true, gramaj: true, estPrintMin: true, sliced: true,
        contentMd5: true, sortOrder: true, createdAt: true,
        // Renk tablosu küçük (birkaç yüz bayt); ekrana yalnız çizilecek renkler gider.
        colorsJson: true,
        // Kaynak model — ürün ekranı "model bağlı mı" işaretini bundan çiziyor.
        // Aynı sorgudan geliyor: uzak-HTTP libSQL'de her ek sorgu ~96 ms ve SIRALI.
        meshR2Key: true, meshName: true, meshSizeBytes: true,
      },
      orderBy: [{ printerConfigId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    });
    const thumbIds = new Set(
      (
        await prisma.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM ProductModelFile WHERE productId = ? AND thumbnail IS NOT NULL AND thumbnail <> ''`,
          id,
        )
      ).map((r) => r.id),
    );
    return NextResponse.json(
      files.map(({ colorsJson, ...f }) => ({ ...f, hasThumbnail: thumbIds.has(f.id), renkler: renkleriCoz(colorsJson) })),
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const ct = req.headers.get("content-type") || "";

    // ── R2 CONFIRM: dosya tarayıcıdan zaten R2'ye yüklendi → sadece metadata satırı oluştur ──
    if (ct.includes("application/json")) {
      const b = (await req.json()) as {
        r2Key?: string;
        originalName?: string;
        printerConfigId?: string;
        sizeBytes?: number;
        applyToVariants?: boolean;
        label?: string | null;
        gramaj?: number | null;
        estPrintMin?: number | null;
      };
      const r2Key = String(b.r2Key || "");
      const printerConfigId = String(b.printerConfigId || "");
      const originalName = String(b.originalName || "");
      if (!r2Key) return NextResponse.json({ error: "r2Key gerekli" }, { status: 400 });
      if (!printerConfigId) return NextResponse.json({ error: "Yazıcı seçilmedi" }, { status: 400 });
      const ext = (originalName.split(".").pop() || "gcode").toLowerCase();
      if (!ALLOWED.includes(ext)) {
        return NextResponse.json({ error: `Desteklenmeyen tür: .${ext} (gcode / 3mf)` }, { status: 400 });
      }
      // CONFIRM DOĞRULAMASI: key bizim ürettiğimiz şekilde mi + nesne GERÇEKTEN R2'de mi?
      // Eskiden keyfi bir key kabul edilip hayalet satır oluşabiliyor (baskı anında 502) ve
      // sizeBytes istemci beyanına kalıyordu.
      if (!isValidModelKey(r2Key)) return NextResponse.json({ error: "Geçersiz dosya anahtarı" }, { status: 400 });
      const r2cfg = await getR2Config();
      if (!r2cfg) return NextResponse.json({ error: "Bulut depolama ayarlı değil" }, { status: 400 });
      const realSize = await headObjectSize(r2Key, r2cfg);
      if (realSize == null) return NextResponse.json({ error: "Dosya buluta ulaşmamış — yüklemeyi tekrar dene" }, { status: 400 });
      /**
       * Renkler, "dilimlenmiş mi", süre, gramaj ve önizleme görseli TEK aralıklı okumadan
       * çıkar (birkaç yüz KB) — dosya geri indirilmez. Kart bunları yükler yüklemez gösterir;
       * renk-eşleme ekranı ve baskı yolu da dosyayı yeniden açmak zorunda kalmaz.
       *
       * ⚠️ Süre/gramaj DOSYANIN değerleridir, yalnız gösterim içindir: ürün maliyetindeki
       * elle girilen değerlere dokunmaz (`src/lib/model-gramaj.ts`).
       */
      let colorsJson: string | null = null;
      let sliced: boolean | null = null;
      let dosyaGram: number | null = null;
      let dosyaSure: number | null = null;
      let gorsel: string | null = null;
      try {
        const paket = await readModelBundleAralikli(
          (a, c) => getObjectRange(r2Key, r2cfg, a, c),
          realSize,
          ext,
        );
        colorsJson = JSON.stringify(paket.colors);
        sliced = ext === "3mf" ? paket.sliced : true;
        dosyaGram = olcum(paket.meta.grams);
        dosyaSure = olcum(paket.meta.estPrintMin);
        gorsel = saklanabilirGorsel(paket.meta.thumbnail);
      } catch { /* okunamazsa eski (tembel) yol devrede kalır */ }

      const mine = await createModelRows({
        productId: id,
        applyToVariants: b.applyToVariants === true,
        colorsJson,
        sliced,
        printerConfigId,
        originalName,
        fileType: ext,
        sizeBytes: realSize, // istemci beyanı değil, R2'nin doğruladığı gerçek boyut
        label: b.label != null && String(b.label).trim() !== "" ? String(b.label).trim() : null,
        gramaj: b.gramaj != null ? Number(b.gramaj) : dosyaGram,
        estPrintMin: b.estPrintMin != null ? Math.round(Number(b.estPrintMin)) : dosyaSure != null ? Math.round(dosyaSure) : null,
        thumbnail: gorsel,
        r2Key,
        storedPath: "",
      });
      return NextResponse.json(hafifYanit(mine), { status: 201 });
    }

    // ── YEREL (R2 kapalı / fallback): multipart upload → diske yaz ──
    const form = await req.formData();
    const file = form.get("file");
    const printerConfigId = String(form.get("printerConfigId") || "");
    const labelRaw = form.get("label");
    const gramajRaw = form.get("gramaj");
    const estRaw = form.get("estPrintMin");
    const applyToVariants = String(form.get("applyToVariants") || "") === "true";

    if (!(file instanceof File)) return NextResponse.json({ error: "Dosya gerekli" }, { status: 400 });
    if (!printerConfigId) return NextResponse.json({ error: "Yazıcı seçilmedi" }, { status: 400 });

    const ext = (file.name.split(".").pop() || "gcode").toLowerCase();
    if (!ALLOWED.includes(ext)) {
      return NextResponse.json({ error: `Desteklenmeyen tür: .${ext} (gcode / 3mf)` }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const dir = getModelsDir();
    const storedPath = path.join(dir, `${crypto.randomUUID()}.${ext}`);
    await fs.promises.writeFile(storedPath, buf); // sync yazma büyük dosyada ana süreci donduruyordu

    // Meta'yı YÜKLEMEDE bir kez parse et + sakla → renk-eşleme/baskı dosyayı yeniden açmaz.
    // TEK açma: renkler, dilimlenmişlik, süre, gramaj ve önizleme aynı okumadan çıkar.
    let colorsJson: string | null = null;
    let sliced: boolean | null = null;
    let dosyaGram: number | null = null;
    let dosyaSure: number | null = null;
    let gorsel: string | null = null;
    try {
      const paket = readModelBundle(storedPath);
      colorsJson = JSON.stringify(paket.colors);
      sliced = ext === "3mf" ? paket.sliced : true;
      dosyaGram = olcum(paket.meta.grams);
      dosyaSure = olcum(paket.meta.estPrintMin);
      gorsel = saklanabilirGorsel(paket.meta.thumbnail);
    } catch { /* parse edilemezse eski (lazy) yol devrede kalır */ }

    const mine = await createModelRows({
      productId: id,
      applyToVariants,
      printerConfigId,
      originalName: file.name,
      fileType: ext,
      sizeBytes: buf.length,
      label: labelRaw != null && String(labelRaw).trim() !== "" ? String(labelRaw).trim() : null,
      gramaj: gramajRaw != null && String(gramajRaw).trim() !== "" ? Number(gramajRaw) : dosyaGram,
      estPrintMin:
        estRaw != null && String(estRaw).trim() !== "" ? Math.round(Number(estRaw)) : dosyaSure != null ? Math.round(dosyaSure) : null,
      storedPath,
      colorsJson,
      sliced,
      thumbnail: gorsel,
    });
    return NextResponse.json(hafifYanit(mine), { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
