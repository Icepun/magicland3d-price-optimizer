import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { KullaniciHatasi } from "@/lib/etiket/kullanici-hatasi";
import { HepsijetHesapHatasi } from "./hepsijet-hesap";

/** Kargo uçlarının ortak hata yanıtı: kullanıcıya gösterilebilen mesaj olduğu gibi, gerisi genel. */
export function kargoHataYaniti(error: unknown) {
  if (error instanceof KullaniciHatasi || error instanceof HepsijetHesapHatasi) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: error.issues[0]?.message ?? "Bilgiler eksik." }, { status: 400 });
  }
  // Müşteri verisi hata mesajlarına girmez; yalnız teknik özet günlüğe.
  console.error("[kargo] beklenmeyen hata:", error instanceof Error ? error.message : error);
  return NextResponse.json({ error: "Bir sorun oldu. Tekrar dene." }, { status: 500 });
}
