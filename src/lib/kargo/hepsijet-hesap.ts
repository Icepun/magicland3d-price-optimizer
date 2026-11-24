import { remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { hesapSabitleriniCoz, type HepsijetHesapSabitleri } from "./hepsijet-govde";

/**
 * HEPSIJET HESAP SABİTLERİ — şirket kodu, aktarma merkezi, barkod ön eki, gönderici/iade deposu.
 * HepsiJet'in hesaba tanımladığı bilgiler; REPODA TUTULMAZ, `AppSetting` içinde durur (Mac ve
 * Windows aynı değeri görsün). Gizli değil → yedeğe de girer.
 */
export const HEPSIJET_HESAP_ANAHTARI = "hepsijet.hesap";

export async function hepsijetHesabiOku(): Promise<HepsijetHesapSabitleri | null> {
  await ensureRuntimeSchema();
  const kayit = await remotePrisma.appSetting.findUnique({ where: { key: HEPSIJET_HESAP_ANAHTARI } });
  return hesapSabitleriniCoz(kayit?.value);
}

/** Doğrula ve kaydet; eksik/yanlışsa kullanıcıya gösterilecek hata fırlatır. */
export async function hepsijetHesabiKaydet(girdi: HepsijetHesapSabitleri): Promise<HepsijetHesapSabitleri> {
  const temiz = hesapSabitleriniCoz(JSON.stringify(girdi));
  if (!temiz) throw new HepsijetHesapHatasi("Tüm alanları doldur. Barkod ön eki 3 karakter olmalı.");
  const tel = temiz.depo.telefon?.replace(/\D/g, "");
  if (tel != null && tel !== "") {
    const norm = tel.length === 10 && tel.startsWith("5") ? `0${tel}` : tel;
    if (!/^0\d{10}$/.test(norm)) throw new HepsijetHesapHatasi("Depo telefonu 05xx xxx xx xx biçiminde olmalı.");
    temiz.depo.telefon = norm;
  } else {
    temiz.depo.telefon = undefined;
  }
  await ensureRuntimeSchema();
  const value = JSON.stringify(temiz);
  await remotePrisma.appSetting.upsert({
    where: { key: HEPSIJET_HESAP_ANAHTARI },
    create: { key: HEPSIJET_HESAP_ANAHTARI, value },
    update: { value },
  });
  return temiz;
}

export class HepsijetHesapHatasi extends Error {
  constructor(mesaj: string) {
    super(mesaj);
    this.name = "HepsijetHesapHatasi";
  }
}
