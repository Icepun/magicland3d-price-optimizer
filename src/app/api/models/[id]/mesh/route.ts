import { NextRequest, NextResponse } from "next/server";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { prisma } from "@/lib/prisma";
import { getR2Config, getObjectBytes, deleteObject, isValidMeshKey, headObjectSize } from "@/lib/r2";
import { jsonError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/**
 * PARÇANIN KAYNAK MODELİ — görüntüleme için, baskıya gönderilmez.
 *
 * Baskı dosyaları dilimlenmiş olduğu için içlerinde geometri yok (ölçüldü: 157/157 Bambu
 * dosyasında sıfır üçgen). Modeli dilimleyicideki gibi gölgeli çizebilmek için kullanıcı
 * parçaya ayrı bir STL / OBJ / proje .3mf bağlıyor; bu rota onu servis eder.
 *
 *   GET  ?bilgi=1  → { var, tur, boyut, ad, anahtar }  (baytları indirmeden yoklama)
 *   GET            → dosyanın baytları (uzun önbellekli; anahtar içerik başına benzersiz)
 *   PUT            → { key, name, sizeBytes } ile bağla (dosya R2'ye imzalı URL'le yüklenmiş olur)
 *   DELETE         → bağlantıyı kaldır + nesneyi sil
 */

type Params = { params: Promise<{ id: string }> };

/**
 * Nesneyi YALNIZ başka satır referans vermiyorsa siler.
 *
 * Aynı kaynak model birden çok satırda paylaşılabiliyor (varyantlar aynı baskı dosyasını
 * paylaştığında modeli de paylaşıyor). Sayım yapılmadan silinirse diğer varyantların modeli
 * sessizce kaybolur ve kimse hata görmez.
 */
async function silKullanilmiyorsa(
  key: string,
  cfg: Awaited<ReturnType<typeof getR2Config>>,
): Promise<void> {
  if (!cfg) return;
  const kalan = await prisma.productModelFile.count({ where: { meshR2Key: key } });
  if (kalan > 0) return;
  await deleteObject(key, cfg).catch(() => {});
}

export async function GET(req: NextRequest, { params }: Params) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const mf = await prisma.productModelFile.findUnique({
      where: { id },
      select: { meshR2Key: true, meshName: true, meshType: true, meshSizeBytes: true },
    });

    const bilgiIstendi = req.nextUrl.searchParams.get("bilgi") === "1";
    if (!mf?.meshR2Key) {
      return bilgiIstendi
        ? NextResponse.json({ var: false })
        : new NextResponse("Kaynak model yok", { status: 404 });
    }

    if (bilgiIstendi) {
      return NextResponse.json({
        var: true,
        tur: mf.meshType ?? "stl",
        boyut: mf.meshSizeBytes ?? 0,
        ad: mf.meshName ?? "",
        anahtar: mf.meshR2Key,
      });
    }

    const cfg = await getR2Config();
    if (!cfg) return new NextResponse("Depolama yapılandırılmamış", { status: 503 });
    const bytes = await getObjectBytes(mf.meshR2Key, cfg);

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.length),
        // Anahtar dosya başına benzersiz (uuid) → içerik asla değişmez, kalıcı önbellek güvenli.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(req: NextRequest, { params }: Params) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      key?: string;
      name?: string;
      sizeBytes?: number;
    };

    const key = String(body.key || "").trim();
    if (!isValidMeshKey(key)) {
      return NextResponse.json({ error: "Geçersiz dosya anahtarı" }, { status: 400 });
    }
    const ad = String(body.name || "").trim();
    const tur = (ad.split(".").pop() || "").toLowerCase();
    if (!["stl", "obj", "3mf"].includes(tur)) {
      return NextResponse.json({ error: `Desteklenmeyen tür: .${tur}` }, { status: 400 });
    }

    const cfg = await getR2Config();
    if (!cfg) return NextResponse.json({ error: "Depolama yapılandırılmamış" }, { status: 503 });

    // Yükleme gerçekten indi mi? (İmzalı PUT tarayıcıdan yapılıyor; sessizce düşmüş olabilir.)
    const gercekBoyut = await headObjectSize(key, cfg);
    if (gercekBoyut == null) {
      return NextResponse.json({ error: "Dosya yüklenemedi, tekrar deneyin" }, { status: 400 });
    }

    const mevcut = await prisma.productModelFile.findUnique({
      where: { id },
      select: { meshR2Key: true },
    });
    if (!mevcut) return NextResponse.json({ error: "Parça bulunamadı" }, { status: 404 });

    await prisma.productModelFile.update({
      where: { id },
      data: { meshR2Key: key, meshName: ad, meshType: tur, meshSizeBytes: gercekBoyut },
    });

    // Değiştirme: eskisini silmeden ÖNCE referans say. Aynı mesh birden çok varyant satırında
    // paylaşılabiliyor; koşulsuz silmek diğer varyantların modelini yok ederdi.
    if (mevcut.meshR2Key && mevcut.meshR2Key !== key) {
      await silKullanilmiyorsa(mevcut.meshR2Key, cfg);
    }

    return NextResponse.json({ ok: true, boyut: gercekBoyut, tur });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const mf = await prisma.productModelFile.findUnique({
      where: { id },
      select: { meshR2Key: true },
    });
    if (!mf?.meshR2Key) return NextResponse.json({ ok: true });

    await prisma.productModelFile.update({
      where: { id },
      data: { meshR2Key: null, meshName: null, meshType: null, meshSizeBytes: null },
    });
    // Sayım BAĞ KOPARILDIKTAN sonra yapılır — bu satır artık referans vermiyor.
    await silKullanilmiyorsa(mf.meshR2Key, await getR2Config());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
