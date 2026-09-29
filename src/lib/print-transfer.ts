import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getUserDataDir } from "@/lib/storage";
import { pushToAllDevices } from "@/lib/push-notify";
import { toDbDate } from "@/lib/sqlite-date";

/**
 * BASKI GÖNDERİMİNİN KARA KUTUSU — "baskıyı başlattım, gidip baktım, başlamamış, ekranda da bir
 * şey yok" (29 Eyl 2026, U1 Alt'ta iki kez).
 *
 * Eskiden gönderimin sonucu YALNIZ ekrandaki akışa yazılıyordu: 9 sn'lik bir açılır bildirim ve
 * 12 sn sonra silinen bir kart uyarısı. Kullanıcı başından ayrıldıysa, pencere yenilendiyse
 * (uykudan uyanınca kendiliğinden yenileniyor) ya da uygulama kapandıysa sebep iz bırakmadan
 * kayboluyordu; uygulama günlüğünde de tek satır yoktu. Artık:
 *   1. Her deneme ve sonucu `userData/baski-gunlugu.log`'a yazılır (teşhis için).
 *   2. Başarısızlık KALICI bildirimdir: zil + işletim sistemi bildirimi + telefona push.
 *   3. Aktarım sürerken bilgisayar uykuya geçmez, güncelleme kurulmaz (main.js kancaları).
 *   4. Uygulama aktarım ortasında kapanırsa bir sonraki açılışta "yarıda kaldı" bildirilir.
 */

type Kuresel = {
  __MLHUB_BASKI_AKTARIMI__?: number;
  /** main.js tanımlar: aktarım sürerken bilgisayarın uykuya geçmesini engeller. */
  __MLHUB_UYKU_ENGELI__?: (aktif: boolean) => void;
};
const kuresel = globalThis as Kuresel;

const GUNLUK_AZAMI_BAYT = 512 * 1024;

function gunlukYolu(): string {
  return path.join(getUserDataDir(), "baski-gunlugu.log");
}
function yarimYolu(): string {
  return path.join(getUserDataDir(), "baski-aktarimlari.json");
}

/** Günlüğe tek satır (JSON). Yazılamazsa sessiz: günlük baskıyı asla engellemez. */
export function baskiGunlugu(olay: Record<string, unknown>): void {
  try {
    const dosya = gunlukYolu();
    fs.appendFileSync(dosya, JSON.stringify({ zaman: new Date().toISOString(), ...olay }) + "\n");
    const boy = fs.statSync(dosya).size;
    if (boy > GUNLUK_AZAMI_BAYT) {
      const metin = fs.readFileSync(dosya, "utf8");
      fs.writeFileSync(dosya, metin.slice(metin.indexOf("\n", metin.length / 2) + 1));
    }
  } catch { /* günlük kritik değil */ }
}

interface YarimKayit {
  pid: number;
  printerName: string;
  label: string;
  startedAt: number;
}

function yarimOku(): Record<string, YarimKayit> {
  try {
    const j = JSON.parse(fs.readFileSync(yarimYolu(), "utf8")) as unknown;
    return j && typeof j === "object" ? (j as Record<string, YarimKayit>) : {};
  } catch {
    return {};
  }
}
function yarimYaz(v: Record<string, YarimKayit>): void {
  try {
    if (Object.keys(v).length === 0) fs.rmSync(yarimYolu(), { force: true });
    else fs.writeFileSync(yarimYolu(), JSON.stringify(v));
  } catch { /* kritik değil */ }
}

/** Bildirimde teknik iz ve uzun açıklama olmasın: ilk cümle, en çok 140 karakter. */
export function kisaSebep(mesaj: string): string {
  const temiz = mesaj.split(" · iz:")[0].replace(/\s+/g, " ").trim();
  return temiz.length > 140 ? `${temiz.slice(0, 137)}…` : temiz;
}

/** "Baskı başlamadı" — kalıcı bildirim + telefona push (tür: baskı sorunu). */
export async function baskiBaslamadiBildir(printerName: string, label: string, sebep: string): Promise<void> {
  const title = "Baskı başlamadı ⚠️";
  const body = `${printerName} — ${label} · ${kisaSebep(sebep)}`;
  try {
    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "Notification" ("id","type","severity","title","body","href","createdAt") VALUES (?,?,?,?,?,?,?)`,
      `print-start-fail:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      "printer-error",
      "critical",
      title,
      body,
      "/printers",
      toDbDate(new Date())
    );
  } catch { /* tablo yoksa push yine gider */ }
  await pushToAllDevices(title, body, { tur: "baski-sorun" }).catch(() => {});
}

export type AktarimSonucu = { ok: true } | { ok: false; sebep: string };

/**
 * Gönderim başladı. Dönen fonksiyon sonuçla BİR KEZ çağrılır (sonraki çağrılar yok sayılır).
 * Başarısızlıkta bildirim gider; başarı yalnız günlüğe yazılır (kart zaten "yazdırıyor" olur).
 */
export function baskiAktarimiBaslat(bilgi: {
  printerId: string;
  printerName: string;
  label: string;
  fileId: string;
}): (sonuc: AktarimSonucu) => Promise<void> {
  const basla = Date.now();
  baskiGunlugu({ olay: "basladi", yazici: bilgi.printerName, dosya: bilgi.label, fileId: bilgi.fileId });
  kuresel.__MLHUB_BASKI_AKTARIMI__ = (kuresel.__MLHUB_BASKI_AKTARIMI__ ?? 0) + 1;
  try { kuresel.__MLHUB_UYKU_ENGELI__?.(true); } catch { /* kanca yoksa (geliştirme) geç */ }
  const yarim = yarimOku();
  yarim[bilgi.printerId] = { pid: process.pid, printerName: bilgi.printerName, label: bilgi.label, startedAt: basla };
  yarimYaz(yarim);

  let bitti = false;
  return async (sonuc) => {
    if (bitti) return;
    bitti = true;
    kuresel.__MLHUB_BASKI_AKTARIMI__ = Math.max(0, (kuresel.__MLHUB_BASKI_AKTARIMI__ ?? 1) - 1);
    if (kuresel.__MLHUB_BASKI_AKTARIMI__ === 0) {
      try { kuresel.__MLHUB_UYKU_ENGELI__?.(false); } catch { /* geç */ }
    }
    const kalan = yarimOku();
    delete kalan[bilgi.printerId];
    yarimYaz(kalan);
    baskiGunlugu({
      olay: sonuc.ok ? "basari" : "hata",
      yazici: bilgi.printerName,
      dosya: bilgi.label,
      sureSn: Math.round((Date.now() - basla) / 1000),
      ...(sonuc.ok ? {} : { sebep: sonuc.sebep }),
    });
    if (!sonuc.ok) await baskiBaslamadiBildir(bilgi.printerName, bilgi.label, sonuc.sebep);
  };
}

/**
 * Önceki oturumdan yarıda kalmış gönderimler (uygulama aktarım ortasında kapandı/çöktü) →
 * bildir ve temizle. Açılışta bir kez çağrılır; bu sürecin kendi kayıtlarına dokunmaz.
 */
export async function yarimKalanAktarimlariBildir(): Promise<number> {
  const kayitlar = yarimOku();
  const eskiler = Object.entries(kayitlar).filter(([, k]) => k.pid !== process.pid);
  if (eskiler.length === 0) return 0;
  for (const [id] of eskiler) delete kayitlar[id];
  yarimYaz(kayitlar);
  for (const [, k] of eskiler) {
    baskiGunlugu({ olay: "yarida-kaldi", yazici: k.printerName, dosya: k.label });
    await baskiBaslamadiBildir(k.printerName, k.label, "Uygulama kapandığı için gönderim yarıda kaldı — tekrar başlat.");
  }
  return eskiler.length;
}
