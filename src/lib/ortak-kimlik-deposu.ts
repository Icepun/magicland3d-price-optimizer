import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { encryptSecret, tryDecryptSecret } from "@/lib/crypto";
import { ayarDosyasiOku } from "@/lib/ayar-dosyasi";
import { kimlikCoz, kimlikPaketle, ortakAnahtar, type OrtakEntegrasyon } from "@/core/ortak-kimlik";

/**
 * ORTAK ENTEGRASYON BİLGİLERİ — masaüstü tarafı (şifreleme: `@/core/ortak-kimlik`).
 *
 * Her ayar modülü (trendyol-settings, hepsiburada-settings, …) dosyasını eskisi gibi okur/yazar;
 * bu katman araya girer:
 *  • OKURKEN ortak kayıt varsa yerel kaydın üstüne konur (gizli alanlar bu bilgisayarın anahtarıyla
 *    yeniden şifrelenir → modülün geri kalanı değişmeden çalışır). Ortak kayıt TEK DOĞRU: orada
 *    olmayan tanımlı alan sonuçtan da çıkar. Veritabanına ulaşılamazsa yerel dosya kullanılır.
 *  • YAZARKEN yerel dosyadan sonra ortak kayıt da güncellenir.
 *  • AÇILIŞTA yerel bilgi ortak kayıtta yoksa yüklenir; iki bilgisayarda farklıysa EN SON KAYDEDİLEN
 *    kazanır (yerel dosyanın değişme anı ↔ ortak kaydın `updatedAtMs`'i). Yüklemeden önce bilgi
 *    pazaryerinde SALT OKUNUR denenir: eskimiş anahtar (ölçüldü: Mac'teki Trendyol anahtarı Mayıs
 *    tarihli ve telefondakinden farklı) ortak kayda girip çalışan cihazları bozmasın. Başarısız
 *    deneme dosya değişene kadar tekrarlanmaz (HepsiJet reddedilen girişte hesabı askıya alabiliyor).
 * Turso kullanılmıyorsa (yerel veritabanı) katman devre dışıdır.
 */

export interface KimlikTanimi {
  ad: OrtakEntegrasyon;
  dosyaYolu: () => string;
  /** Yerelde bu bilgisayarın anahtarıyla şifreli tutulan alanlar (noktalı yol: "test.sifre"). */
  gizli: readonly string[];
  /** Düz tutulan alanlar. */
  acik: readonly string[];
}

const OKUMA_OMRU_MS = 30_000;
const onbellek = new Map<OrtakEntegrasyon, { at: number; deger: Record<string, string> | null }>();

function anahtar(): Uint8Array | null {
  const t = process.env.TURSO_AUTH_TOKEN?.trim();
  return t ? ortakAnahtar(t) : null;
}

function al(o: unknown, yol: string): unknown {
  let x = o;
  for (const p of yol.split(".")) {
    if (!x || typeof x !== "object") return undefined;
    x = (x as Record<string, unknown>)[p];
  }
  return x;
}

function koy(o: Record<string, unknown>, yol: string, deger: string | undefined): void {
  const parcalar = yol.split(".");
  let x = o;
  for (const p of parcalar.slice(0, -1)) {
    const ic = x[p];
    if (!ic || typeof ic !== "object") {
      if (deger === undefined) return;
      x[p] = {};
    }
    x = x[p] as Record<string, unknown>;
  }
  const son = parcalar[parcalar.length - 1];
  if (deger === undefined) delete x[son];
  else x[son] = deger;
}

/** Yerel (şifreli) kayıt → düz metin alan haritası. Boş alan haritaya girmez. */
export function duzMetinHaritasi(tanim: KimlikTanimi, kayit: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const yol of tanim.gizli) {
    const v = al(kayit, yol);
    const d = typeof v === "string" ? tryDecryptSecret(v) : null;
    if (d) out[yol] = d;
  }
  for (const yol of tanim.acik) {
    const v = al(kayit, yol);
    if (typeof v === "string" && v.trim() !== "") out[yol] = v;
  }
  return out;
}

/** Ortak haritayı yerel kaydın yerine koy (tanımlı alanlarda ortak kayıt tek doğru). */
export function ortakIleBirlestir<T extends object>(tanim: KimlikTanimi, yerel: T, ortak: Record<string, string>): T {
  const sonuc = JSON.parse(JSON.stringify(yerel ?? {})) as Record<string, unknown>;
  for (const yol of tanim.gizli) koy(sonuc, yol, ortak[yol] != null ? encryptSecret(ortak[yol]) : undefined);
  for (const yol of tanim.acik) koy(sonuc, yol, ortak[yol] ?? undefined);
  return sonuc as T;
}

function ayni(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** Açılış eşitlemesinin kararı (saf, test edilir). */
export function yuklemeGerekli(g: {
  yerel: Record<string, string>;
  yerelMs: number;
  ortak: Record<string, string> | null;
  ortakMs: number | null;
}): boolean {
  if (Object.keys(g.yerel).length === 0) return false; // yüklenecek bir şey yok
  if (!g.ortak) return true; // ortakta yok ya da (anahtar değişti) çözülemiyor
  if (ayni(g.yerel, g.ortak)) return false;
  return g.yerelMs > (g.ortakMs ?? 0); // yerel daha sonra kaydedilmiş
}

/** Ortak kayıt (düz metin); yoksa / çözülemezse / ulaşılamazsa null (→ yerel dosya). */
export async function ortakKimlikOku(ad: OrtakEntegrasyon): Promise<Record<string, string> | null> {
  const k = anahtar();
  if (!k) return null;
  const c = onbellek.get(ad);
  if (c && Date.now() - c.at < OKUMA_OMRU_MS) return c.deger;
  try {
    await ensureRuntimeSchema();
    const satir = await remotePrisma.integrationSecret.findUnique({ where: { name: ad } });
    const deger = satir ? kimlikCoz(satir.payload, k) : null;
    onbellek.set(ad, { at: Date.now(), deger });
    return deger;
  } catch {
    return c?.deger ?? null;
  }
}

export async function ortakKimlikYaz(
  ad: OrtakEntegrasyon,
  alanlar: Record<string, string>,
  kaydedilmeMs = Date.now()
): Promise<void> {
  const k = anahtar();
  if (!k || Object.keys(alanlar).length === 0) return;
  const payload = kimlikPaketle(alanlar, k, crypto.randomBytes(16));
  await ensureRuntimeSchema();
  const veri = { payload, updatedAtMs: kaydedilmeMs, updatedBy: os.hostname() };
  await remotePrisma.integrationSecret.upsert({
    where: { name: ad },
    create: { name: ad, ...veri },
    update: veri,
  });
  onbellek.set(ad, { at: Date.now(), deger: alanlar });
}

/** Ayar modülünün okuma noktası: ortak kayıt varsa yerelin yerine o. */
export async function ortaklaOku<T extends object>(tanim: KimlikTanimi, yerel: T): Promise<T> {
  const ortak = await ortakKimlikOku(tanim.ad);
  return ortak ? ortakIleBirlestir(tanim, yerel, ortak) : yerel;
}

/** Ayar modülünün yazma noktası (yerel dosyadan SONRA): ortak kaydı güncelle. Hata kaydı engellemez. */
export async function ortagaYaz(tanim: KimlikTanimi, kayit: object): Promise<void> {
  try {
    await ortakKimlikYaz(tanim.ad, duzMetinHaritasi(tanim, kayit));
  } catch (e) {
    console.warn(`[ortak-kimlik] ${tanim.ad} ortak kayda yazılamadı (bu bilgisayarda kayıtlı):`, e instanceof Error ? e.message : e);
  }
}

/** Yerel bilgiyi pazaryerinde salt okunur dener; çalışmıyorsa fırlatır. */
export type KimlikDogrulayici = (alanlar: Record<string, string>) => Promise<void>;

/** Başarısız denemenin hatırası: entegrasyon → denenen dosyanın değişme anı. */
function hatiraYolu(t: KimlikTanimi): string {
  return path.join(path.dirname(t.dosyaYolu()), "ortak-kimlik-denemeleri.json");
}
function hatiraOku(t: KimlikTanimi): Record<string, number> {
  try {
    const v = JSON.parse(fs.readFileSync(hatiraYolu(t), "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}
function hatiraYaz(t: KimlikTanimi, yerelMs: number | null): void {
  try {
    const h = hatiraOku(t);
    if (yerelMs == null) delete h[t.ad];
    else h[t.ad] = yerelMs;
    fs.writeFileSync(hatiraYolu(t), JSON.stringify(h), { encoding: "utf8", mode: 0o600 });
  } catch {
    /* hatıra isteğe bağlı */
  }
}

/** Açılışta: yerel bilgiler ortak kayıtta yoksa ya da daha yeniyse — ve ÇALIŞIYORSA — yükle. */
export async function ortakKimlikleriEsitle(
  tanimlar: readonly KimlikTanimi[],
  dogrulayicilar: Partial<Record<OrtakEntegrasyon, KimlikDogrulayici>> = {}
): Promise<void> {
  const k = anahtar();
  if (!k) return;
  for (const t of tanimlar) {
    try {
      const yol = t.dosyaYolu();
      if (!fs.existsSync(yol)) continue;
      const yerel = duzMetinHaritasi(t, await ayarDosyasiOku<object>(yol));
      const yerelMs = fs.statSync(yol).mtimeMs;
      await ensureRuntimeSchema();
      const satir = await remotePrisma.integrationSecret.findUnique({ where: { name: t.ad } });
      const ortak = satir ? kimlikCoz(satir.payload, k) : null;
      if (!yuklemeGerekli({ yerel, yerelMs, ortak, ortakMs: satir?.updatedAtMs ?? null })) continue;
      if (hatiraOku(t)[t.ad] === yerelMs) continue; // bu dosya daha önce denendi ve çalışmadı
      const dogrula = dogrulayicilar[t.ad];
      if (dogrula) {
        try {
          await dogrula(yerel);
        } catch (e) {
          hatiraYaz(t, yerelMs);
          console.warn(`[ortak-kimlik] ${t.ad}: bu bilgisayardaki bilgi pazaryerinde çalışmadı, ortak kayda yüklenmedi:`, e instanceof Error ? e.message : e);
          continue;
        }
      }
      // Kaydedilme anı = yerel dosyanın değişme anı: başka bilgisayardaki daha yeni bilgiyi ezmesin.
      await ortakKimlikYaz(t.ad, yerel, yerelMs);
      hatiraYaz(t, null);
      console.info(`[ortak-kimlik] ${t.ad} bilgileri ortak kayda yüklendi`);
    } catch (e) {
      console.warn(`[ortak-kimlik] ${t.ad} eşitlenemedi:`, e instanceof Error ? e.message : e);
    }
  }
}
