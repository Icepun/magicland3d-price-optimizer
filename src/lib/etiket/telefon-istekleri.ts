import os from "node:os";
import { remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { etiketIstegiBayat } from "@/core/etiket-uygunluk";
import { yaziciDurumu } from "@/lib/etiket/ham-yazici";
import { EtiketBasilamadi, hbEtiketiBas, trendyolEtiketiBas } from "@/lib/etiket/bas";
import { takipNoTemizle } from "@/lib/etiket/kayit";

/**
 * TELEFONDAN KARGO ETİKETİ — masaüstü tarafı.
 *
 * Telefon termal yazıcıya basamaz (iOS'ta ham yazdırma yok; native modül OTA'yı keser). Telefon
 * isteği `LabelPrintRequest`'e yazar; bu dinleyici birkaç saniyede bir bakar ve etiketi Siparişler
 * ekranındaki düğmeyle AYNI yoldan basar (`bas.ts`).
 *
 * • Yalnız etiket yazıcısı seçili/bulunan masaüstü alır. Berke hem Mac'te hem Windows'ta çalışıyor:
 *   istek koşullu güncellemeyle SAHİPLENİR (pending → running), kapamayan makine dokunmaz → çift
 *   baskı olmaz (relay'deki PrintCommand kalıbı).
 * • `ETIKET_ISTEGI_OMRU_MS`'den eski bekleyen istek basılmaz: masaüstü kapalıyken birikip saatler
 *   sonra kimse beklemiyorken basılmasın.
 * • Masaüstünden basılan etiket de buraya "done" yazılır (`basildiBulutaYaz`) → telefon "basıldı"
 *   işaretini görür. 60 günden eski kayıtlar süpürülür (yerel kopyalarla aynı süre).
 */

const ARALIK_MS = 5_000;
const SUPURME_ARALIGI_MS = 60 * 60_000;
const SAKLAMA_MS = 60 * 24 * 60 * 60_000;

const g = globalThis as unknown as { __MLHUB_ETIKET_ISTEKLERI__?: boolean };
let calisiyor = false;
let sonSupurme = 0;

export function startEtiketIstekleri(): void {
  if (g.__MLHUB_ETIKET_ISTEKLERI__) return;
  g.__MLHUB_ETIKET_ISTEKLERI__ = true;
  const zamanlayici = setInterval(() => void tur(), ARALIK_MS);
  zamanlayici.unref?.();
}

async function tur(): Promise<void> {
  if (calisiyor) return;
  calisiyor = true;
  try {
    await ensureRuntimeSchema();
    await bekleyenleriIsle();
    if (Date.now() - sonSupurme > SUPURME_ARALIGI_MS) {
      sonSupurme = Date.now();
      await remotePrisma.labelPrintRequest.deleteMany({ where: { createdAtMs: { lt: Date.now() - SAKLAMA_MS } } });
    }
  } catch {
    /* ağ/veritabanı anlık hatası — sonraki tur dener */
  } finally {
    calisiyor = false;
  }
}

/** Bekleyen telefon isteklerini işle (dışa açık yalnız test için; normalde `tur` çağırır). */
export async function bekleyenleriIsle(): Promise<void> {
  const bekleyenler = await remotePrisma.labelPrintRequest.findMany({
    where: { status: "pending" },
    orderBy: { createdAtMs: "asc" },
    take: 10,
  });
  if (bekleyenler.length === 0) return;

  // Yazıcı listesi işletim sistemine sorulur (pahalı) → yalnız bekleyen istek varsa, turda bir kez.
  let yazici: string | null | undefined;
  for (const istek of bekleyenler) {
    if (etiketIstegiBayat(istek.createdAtMs, Date.now())) {
      await remotePrisma.labelPrintRequest.updateMany({
        where: { id: istek.id, status: "pending" },
        data: {
          status: "error",
          error: "Masaüstü o sırada kapalıydı, etiket basılmadı.",
          processedAtMs: Date.now(),
        },
      });
      continue;
    }
    if (yazici === undefined) yazici = (await yaziciDurumu().catch(() => null))?.secili ?? null;
    // Bu bilgisayarda etiket yazıcısı yok → isteği yazıcısı olan masaüstüne bırak.
    if (!yazici) return;

    const kapildi = await remotePrisma.labelPrintRequest.updateMany({
      where: { id: istek.id, status: "pending" },
      data: { status: "running", printedBy: os.hostname() },
    });
    if (kapildi.count !== 1) continue; // başka masaüstü aldı ya da telefon vazgeçti

    try {
      if (istek.platform === "trendyol") {
        const takipNo = takipNoTemizle(istek.trackingNumber);
        if (!takipNo) throw new EtiketBasilamadi("Bu siparişin takip numarası yok.");
        await trendyolEtiketiBas(takipNo);
      } else if (istek.platform === "hepsiburada") {
        const paketNo = takipNoTemizle(istek.packageNumber);
        if (!paketNo) throw new EtiketBasilamadi("Sipariş henüz paketlenmemiş.");
        await hbEtiketiBas(paketNo, takipNoTemizle(istek.trackingNumber));
      } else {
        throw new EtiketBasilamadi("Bu platformun etiketi uygulamadan basılamıyor.");
      }
      await remotePrisma.labelPrintRequest.update({
        where: { id: istek.id },
        data: { status: "done", error: null, processedAtMs: Date.now() },
      });
    } catch (error) {
      await remotePrisma.labelPrintRequest
        .update({
          where: { id: istek.id },
          data: {
            status: "error",
            error: error instanceof EtiketBasilamadi ? error.message : "Etiket basılamadı. Tekrar dene.",
            processedAtMs: Date.now(),
          },
        })
        .catch(() => {});
    }
  }
}

/**
 * Masaüstünden basılan etiketi buluta "basıldı" olarak yaz → telefon da görsün. İsteğe bağlı:
 * yazılamazsa baskı yine başarılıdır (yerel işaret ayrıca tutuluyor).
 */
export async function basildiBulutaYaz(kayit: {
  platform: "trendyol" | "hepsiburada";
  orderNumber: string | null;
  labelKey: string;
  trackingNumber: string | null;
  packageNumber: string | null;
}): Promise<void> {
  try {
    await ensureRuntimeSchema();
    const simdi = Date.now();
    await remotePrisma.labelPrintRequest.create({
      data: {
        platform: kayit.platform,
        orderNumber: kayit.orderNumber ?? "",
        labelKey: kayit.labelKey,
        trackingNumber: kayit.trackingNumber,
        packageNumber: kayit.packageNumber,
        status: "done",
        source: "desktop",
        printedBy: os.hostname(),
        createdAtMs: simdi,
        processedAtMs: simdi,
      },
    });
  } catch {
    /* işaret isteğe bağlı */
  }
}
