import fs from "node:fs/promises";
import path from "node:path";
import { encryptSecret, tryDecryptSecret } from "@/lib/crypto";
import type { HepsijetKimligi, HepsijetOrtami } from "./hepsijet-client";

/**
 * HepsiJet giriş bilgileri — diğer platformlarla aynı düzen: bu bilgisayarda, kullanıcı klasöründe,
 * şifre AES ile şifreli. Test ve canlı ortamın bilgileri AYRI saklanır (HepsiJet ikisine farklı
 * kullanıcı veriyor); ortam değiştirince öbürününki silinmez.
 */
interface OrtamKaydi {
  kullaniciAdi?: string;
  sifre?: string; // şifreli
}

interface KayitliAyarlar {
  ortam?: HepsijetOrtami;
  test?: OrtamKaydi;
  prod?: OrtamKaydi;
}

function dosyaYolu() {
  return (
    process.env.HEPSIJET_SETTINGS_FILE ||
    path.join(/* turbopackIgnore: true */ process.cwd(), "data", "hepsijet-settings.json")
  );
}

async function oku(): Promise<KayitliAyarlar> {
  try {
    const j = JSON.parse(await fs.readFile(dosyaYolu(), "utf8"));
    return typeof j === "object" && j ? j : {};
  } catch {
    return {};
  }
}

async function yaz(a: KayitliAyarlar) {
  const yol = dosyaYolu();
  await fs.mkdir(path.dirname(yol), { recursive: true });
  await fs.writeFile(yol, `${JSON.stringify(a, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

const ortamOku = (v: unknown): HepsijetOrtami => (v === "prod" ? "prod" : "test");

export interface HepsijetAcikAyarlar {
  ortam: HepsijetOrtami;
  /** Ortam başına: kullanıcı adı + şifre girilmiş mi (şifrenin kendisi asla dönmez). */
  test: { kullaniciAdi: string; sifreVar: boolean };
  prod: { kullaniciAdi: string; sifreVar: boolean };
}

export async function hepsijetAcikAyarlar(): Promise<HepsijetAcikAyarlar> {
  const a = await oku();
  const ozet = (k: OrtamKaydi | undefined) => ({
    kullaniciAdi: k?.kullaniciAdi?.trim() ?? "",
    sifreVar: Boolean(tryDecryptSecret(k?.sifre)),
  });
  return { ortam: ortamOku(a.ortam), test: ozet(a.test), prod: ozet(a.prod) };
}

/** Seçili ortamın giriş bilgisi; eksikse kullanıcıya gösterilebilir hata. */
export async function hepsijetKimligi(): Promise<HepsijetKimligi> {
  const a = await oku();
  const ortam = ortamOku(a.ortam);
  const k = a[ortam];
  const kullaniciAdi = k?.kullaniciAdi?.trim() ?? "";
  const sifre = tryDecryptSecret(k?.sifre) ?? "";
  if (!kullaniciAdi || !sifre) throw new Error("HepsiJet kullanıcı adı ve şifresi girilmedi.");
  return { ortam, kullaniciAdi, sifre };
}

export async function hepsijetAyarlariniKaydet(girdi: {
  ortam: HepsijetOrtami;
  kullaniciAdi: string;
  /** Boş bırakılırsa kayıtlı şifre korunur. */
  sifre?: string;
}) {
  const a = await oku();
  const ortam = ortamOku(girdi.ortam);
  const onceki = a[ortam] ?? {};
  const sonraki: OrtamKaydi = { ...onceki, kullaniciAdi: girdi.kullaniciAdi.trim() };
  // Kullanıcı adı değiştiyse eski şifre o kullanıcıya ait değildir → yeniden girilmeli.
  if (onceki.kullaniciAdi && onceki.kullaniciAdi.trim() !== sonraki.kullaniciAdi) delete sonraki.sifre;
  if (girdi.sifre?.trim()) sonraki.sifre = encryptSecret(girdi.sifre.trim());
  await yaz({ ...a, ortam, [ortam]: sonraki });
}
