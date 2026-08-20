import { NextResponse } from "next/server";
import { dbOlaylari, dbFetchTimeoutMs, dbYavasEsikMs } from "@/lib/db-fetch-timeout";

export const dynamic = "force-dynamic";

/**
 * VERİTABANI SAĞLIK TANISI — "sayfa neden yavaş açıldı" sorusunun cevabı.
 *
 * 20 Ağu 2026 ölçümü, tavana ÇARPMAYAN takılmaların hiçbir yerde kayıtlı olmadığını gösterdi:
 * günlük yalnız iptal edilen istekleri yazıyordu, oysa kanarya p90'ı 2,1 sn / p99'u 9,8 sn.
 * Yani asıl yavaşlık görünmezdi. Bu uç, yavaş/iptal/yeniden-denenmiş istekleri sayar.
 *
 * Salt okunur ve sorgu ATMAZ — teşhis için çağrıldığında sorunu büyütmesin.
 */
export async function GET() {
  const { olaylar, ozet } = dbOlaylari();
  const yavaslar = olaylar.filter((o) => o.tur === "yavas").map((o) => o.ms).sort((a, b) => a - b);
  const yuzdelik = (p: number) =>
    yavaslar.length ? yavaslar[Math.min(yavaslar.length - 1, Math.floor((yavaslar.length - 1) * p))] : null;

  return NextResponse.json({
    zamanAsimiMs: dbFetchTimeoutMs(),
    yavasEsikMs: dbYavasEsikMs(),
    ozet,
    yavasIstek: {
      adet: yavaslar.length,
      p50: yuzdelik(0.5),
      p90: yuzdelik(0.9),
      enUzun: yavaslar.at(-1) ?? null,
    },
    // Son 20 olay — zaman damgasıyla, hangi ana denk geldiği görülsün.
    sonOlaylar: olaylar.slice(-20),
  });
}
