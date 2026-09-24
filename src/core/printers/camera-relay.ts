/**
 * TELEFONA KAMERA AKTARICISI — LAN'daki yazıcı kamerasını telefona taşır.
 *
 * Sözleşme ve SQL: `@/core/printer-camera`. Özet: telefon `PrinterCamera.wantedUntilMs`'i ileri
 * yazar; bu döngü isteği görür, satırı sahiplenir, kameraya yayın merkezinden (camera-hub)
 * abone olur ve kareyi en çok `KARE_ARALIK_MS`'de bir R2'ye koyup imzalı adresini satıra yazar.
 * İstek süresi dolunca abonelik bırakılır (kamera uykuya döner) ve kareler silinir.
 *
 * YAZICIYA YÜK (kamera modüllerinin ana kuralı): kamera YALNIZ biri izlerken açık. Dosya
 * aktarılırken hiç açılmaz, açıksa kapanır (U1 aktarım sırasında ağdan düşüyordu). Masaüstü
 * penceresi de aynı anda izliyorsa yazıcıya ikinci bağlantı açılmaz (yayın merkezi).
 *
 * MALİYET: kare ~80 KB, en çok 1,5 sn'de bir → izlerken ~55 KB/sn yükleme. R2'de silme
 * ücretsiz; her oturum yalnız son birkaç kareyi tutar. Veritabanına kare başına tek küçük
 * satır güncellemesi gider (görsel değil, adres).
 */
import crypto from "node:crypto";
import os from "node:os";
import { remotePrisma } from "@/lib/prisma";
import {
  deleteObject, getR2Config, listModelObjects, presignGetUrl, putObjectBytes, type R2Config,
} from "@/lib/r2";
import {
  KAMERA_SAHIP_BAYAT_MS, kameraHataYazSql, kameraIstekleriSql, kameraKareYazSql,
  kameraSahiplenSql, kameraSahiplikBirakSql,
} from "@/core/printer-camera";
import { processSingleton } from "./process-singleton";
import { kameraAbone, type KameraKaynagi } from "./camera-hub";
import { bambuKameraAkisi } from "./bambu-camera";
import { snapmakerKameraAkisi, snapmakerKameraVar } from "./snapmaker-camera";
import { moonrakerBase } from "./moonraker";
import { aktarimSuruyor } from "./transfer-state";
import { printerCfgCached } from "./config-cache";

/** İstekler bu aralıkla yoklanır — telefonda "açılıyor" süresinin üst sınırını belirler. */
const TUR_MS = 3_000;
/** İki kare yüklemesi arası en az süre. U1 ~480 ms'de, Bambu ~2,5 sn'de bir kare üretiyor. */
export const KARE_ARALIK_MS = 1_500;
/** R2'de tutulan son kare sayısı — telefon bir öncekini indirirken silinmesin. */
export const TUTULAN_KARE = 3;
/** İmzalı adresin ömrü. Kare birkaç saniyede eskiyor; uzun ömür yalnız saat farkına pay. */
const ADRES_OMRU_SN = 900;
/** Hata sonrası kendiliğinden yeniden deneme beklemesi (telefon "Tekrar dene" derse beklenmez). */
const HATA_BEKLEME_MS = 30_000;
/** Aktarım bitince kameranın kendiliğinden geri gelmesi için daha kısa bekleme. */
const AKTARIM_BEKLEME_MS = 10_000;
/** Art arda bu kadar yükleme düşerse oturum hatayla biter. */
const AZAMI_ARDISIK_HATA = 5;
/** Kamera türü tespiti (ağ yoklaması) bu süre önbelleklenir. */
const TUR_TESPIT_TTL_MS = 5 * 60_000;
/** Açılışta süpürülecek kare yaşı — çökmüş bir oturumdan kalanlar. */
const ARTIK_KARE_YASI_MS = 10 * 60_000;

export const AKTARIM_SURUYOR_MESAJI = "Yazıcıya dosya gönderiliyor — kamera aktarım bitince açılır.";

/** Bu masaüstü sürecinin kimliği — iki masaüstü aynı anda açıkken sahipliği ayırır. */
const SAHIP = processSingleton(
  "kamera_sahip",
  () => `${os.hostname().slice(0, 32)}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`,
);

type Cfg = {
  id: string; type: string; brand: string | null; host: string; port: number;
  accessCode: string | null; serial: string | null; enabled?: boolean;
};

interface Oturum {
  yaziciId: string;
  host: string;
  r2: R2Config;
  birak: (() => void) | null;
  /** R2'ye konan kareler, eskiden yeniye. */
  anahtarlar: string[];
  sonGonderim: number;
  gonderiliyor: boolean;
  /** Yükleme sürerken gelen EN SON kare — aradakiler atlanır, telefon hep en tazesini görür. */
  bekleyen: Buffer | null;
  zamanlayici: ReturnType<typeof setTimeout> | null;
  ardisikHata: number;
  bitti: boolean;
}

interface IstekSatiri {
  printerConfigId: string;
  owner: string | null;
  ownerAtMs: number | null;
  error: string | null;
}

const oturumlar = processSingleton("kamera_oturumlar", () => new Map<string, Oturum>());
/** Yazıcı → kendiliğinden yeniden denemenin serbest kalacağı an. */
const bekleme = processSingleton("kamera_bekleme", () => new Map<string, number>());
const turTespiti = processSingleton(
  "kamera_turTespiti",
  () => new Map<string, { at: number; tur: "snapmaker" | "genel" | "yok" }>(),
);
const durumKutu = processSingleton("kamera_durum", () => ({ basladi: false, turda: false, supuruldu: false }));

/** Kare anahtarı: yazıcı başına klasör, zaman damgalı ad (her kare yeni adres → önbellek yok). */
export function kareAnahtari(yaziciId: string, ms: number): string {
  const guvenli = yaziciId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "yazici";
  return `camera/${guvenli}/${ms}.jpg`;
}

/** Tutulacak son `tut` kare dışındakiler (eskiden yeniye sıralı listeden). */
export function silinecekKareler(anahtarlar: readonly string[], tut: number = TUTULAN_KARE): string[] {
  return anahtarlar.length > tut ? anahtarlar.slice(0, anahtarlar.length - tut) : [];
}

/**
 * Kendiliğinden yeniden deneme serbest mi? Telefon hatayı sildiyse ("Tekrar dene" ya da ekranı
 * yeniden açtı) bekleme yok sayılır.
 */
export function denemeSerbestMi(satirHatasi: string | null, serbestAn: number | undefined, simdi: number): boolean {
  if (satirHatasi == null) return true;
  return serbestAn == null || simdi >= serbestAn;
}

function dbDuraklatildi(): boolean {
  return !!(globalThis as { __MLHUB_DB_PAUSED__?: boolean }).__MLHUB_DB_PAUSED__;
}

function sayiya(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Döngüyü başlat (relay açılışında bir kez). `ulasilabilir`: bu makine yazıcıya LAN'dan
 * ulaşabiliyor mu — ulaşamayan masaüstü isteği sahiplenmez, LAN'daki diğerine bırakır.
 */
export function startKameraAktarici(ulasilabilir: (yaziciId: string) => boolean): void {
  if (durumKutu.basladi) return;
  durumKutu.basladi = true;
  setInterval(() => {
    void kameraTuru(ulasilabilir).catch(() => {
      /* ağ/veritabanı anlık hatası — sonraki tur dener */
    });
  }, TUR_MS);
}

async function kameraTuru(ulasilabilir: (yaziciId: string) => boolean): Promise<void> {
  if (dbDuraklatildi() || durumKutu.turda) return;
  durumKutu.turda = true;
  try {
    const simdi = Date.now();
    let satirlar: IstekSatiri[];
    try {
      const ham = await remotePrisma.$queryRawUnsafe<Record<string, unknown>[]>(kameraIstekleriSql(), simdi);
      satirlar = ham.map((r) => ({
        printerConfigId: String(r.printerConfigId),
        owner: r.owner == null ? null : String(r.owner),
        ownerAtMs: sayiya(r.ownerAtMs),
        error: r.error == null ? null : String(r.error),
      }));
    } catch {
      return; // tablo henüz yok (eski şema) ya da ağ — sonraki tur
    }

    // 1) İstenmeyen oturumları kapat (telefon ekranı kapattı / süre doldu).
    const istenen = new Set(satirlar.map((s) => s.printerConfigId));
    for (const o of [...oturumlar.values()]) {
      if (!istenen.has(o.yaziciId)) await oturumuBitir(o, null);
    }

    // 2) Yeni istekleri aç.
    for (const s of satirlar) {
      const acik = oturumlar.get(s.printerConfigId);
      if (acik) {
        // Aktarım oturum sürerken başladıysa kamerayı hemen bırak.
        if (aktarimSuruyor(acik.host)) await oturumuBitir(acik, AKTARIM_SURUYOR_MESAJI, AKTARIM_BEKLEME_MS);
        continue;
      }
      if (!denemeSerbestMi(s.error, bekleme.get(s.printerConfigId), simdi)) continue;
      // Başka masaüstü canlı olarak sunuyorsa dokunma.
      if (s.owner && s.owner !== SAHIP && s.ownerAtMs != null && simdi - s.ownerAtMs < KAMERA_SAHIP_BAYAT_MS) continue;
      if (!ulasilabilir(s.printerConfigId)) continue;
      await oturumBaslat(s.printerConfigId);
    }

    if (!durumKutu.supuruldu) {
      durumKutu.supuruldu = true;
      void artikKareleriSupur().catch(() => {});
    }
  } finally {
    durumKutu.turda = false;
  }
}

/** Hata yaz + sahipliği bırak + bir süre kendiliğinden deneme. */
async function hataYaz(yaziciId: string, mesaj: string, beklemeMs = HATA_BEKLEME_MS): Promise<void> {
  bekleme.set(yaziciId, Date.now() + beklemeMs);
  await remotePrisma
    .$executeRawUnsafe(kameraHataYazSql(), mesaj, Date.now(), yaziciId, SAHIP)
    .catch(() => {});
}

/** Bu yazıcıda hangi kamera var? Moonraker'da ağ yoklaması gerekir → önbellekli. */
async function moonrakerKameraTuru(cfg: Cfg): Promise<"snapmaker" | "genel" | "yok"> {
  const k = `${cfg.host}:${cfg.port}`;
  const hit = turTespiti.get(k);
  if (hit && Date.now() - hit.at < TUR_TESPIT_TTL_MS) return hit.tur;
  let tur: "snapmaker" | "genel" | "yok" = "yok";
  if (await snapmakerKameraVar(cfg.host, cfg.port)) {
    tur = "snapmaker";
  } else if (await anlikKareAl(cfg.host, cfg.port)) {
    tur = "genel";
  }
  turTespiti.set(k, { at: Date.now(), tur });
  return tur;
}

/** Standart Moonraker/crowsnest anlık görüntüsü — tek kare, JPEG değilse null. */
async function anlikKareAl(host: string, port: number): Promise<Buffer | null> {
  const ctrl = new AbortController();
  const zaman = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${moonrakerBase(host, port)}/webcam/?action=snapshot`, { signal: ctrl.signal });
    if (!r.ok || !(r.headers.get("content-type") || "").startsWith("image/")) {
      try { await r.arrayBuffer(); } catch { /* gövdeyi tüket */ }
      return null;
    }
    const b = Buffer.from(await r.arrayBuffer());
    return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 ? b : null;
  } catch {
    return null;
  } finally {
    clearTimeout(zaman);
  }
}

/**
 * Standart Moonraker kamerası için kaynak: MJPEG akışını ayrıştırmak yerine anlık görüntüyü
 * aralıkla çeker (telefona zaten 1,5 sn'de bir kare gidiyor).
 */
function genelKameraKaynagi(host: string, port: number): KameraKaynagi {
  return (onKare, onHata) => {
    let kapandi = false;
    let zamanlayici: ReturnType<typeof setTimeout> | null = null;
    let ardisikBos = 0;
    const cek = async () => {
      if (kapandi) return;
      const kare = await anlikKareAl(host, port);
      if (kapandi) return;
      if (kare) {
        ardisikBos = 0;
        onKare(kare);
      } else if (++ardisikBos >= 10) {
        kapandi = true;
        onHata("Kameradan görüntü gelmiyor.");
        return;
      }
      zamanlayici = setTimeout(() => void cek(), KARE_ARALIK_MS);
    };
    void cek();
    return {
      durdur: () => {
        kapandi = true;
        if (zamanlayici) clearTimeout(zamanlayici);
      },
    };
  };
}

async function kaynakSec(cfg: Cfg): Promise<KameraKaynagi | { hata: string }> {
  const bambu = cfg.type === "bambu" || (cfg.brand || "").toLowerCase() === "bambu";
  if (bambu) {
    const kod = cfg.accessCode;
    if (!kod) return { hata: "Bu yazıcı için erişim kodu girilmemiş." };
    return (onKare, onHata) => bambuKameraAkisi(cfg.host, kod, onKare, onHata);
  }
  const tur = await moonrakerKameraTuru(cfg);
  if (tur === "snapmaker") return (onKare, onHata) => snapmakerKameraAkisi(cfg.host, cfg.port, onKare, onHata);
  if (tur === "genel") return genelKameraKaynagi(cfg.host, cfg.port);
  return { hata: "Bu yazıcıda kamera bulunamadı." };
}

async function oturumBaslat(yaziciId: string): Promise<void> {
  const cfg = await printerCfgCached<Cfg>(yaziciId).catch(() => null);
  if (!cfg || cfg.enabled === false) {
    await hataYaz(yaziciId, "Yazıcı bulunamadı ya da devre dışı.");
    return;
  }
  if (aktarimSuruyor(cfg.host)) {
    await hataYaz(yaziciId, AKTARIM_SURUYOR_MESAJI, AKTARIM_BEKLEME_MS);
    return;
  }
  const r2 = await getR2Config().catch(() => null);
  if (!r2) {
    await hataYaz(yaziciId, "Kamerayı telefona taşımak için bulut depolama (R2) gerekli — masaüstünde Ayarlar'dan kurulur.");
    return;
  }
  const kaynak = await kaynakSec(cfg);
  if ("hata" in kaynak) {
    await hataYaz(yaziciId, kaynak.hata);
    return;
  }
  // Yoklamalar sürerken durum değişmiş olabilir — sahiplenme koşulu son sözü söyler.
  const simdi = Date.now();
  const alindi = await remotePrisma
    .$executeRawUnsafe(kameraSahiplenSql(), SAHIP, simdi, yaziciId, simdi - KAMERA_SAHIP_BAYAT_MS)
    .catch(() => 0);
  if (alindi !== 1 || oturumlar.has(yaziciId)) return;

  bekleme.delete(yaziciId);
  const o: Oturum = {
    yaziciId, host: cfg.host, r2, birak: null, anahtarlar: [], sonGonderim: 0,
    gonderiliyor: false, bekleyen: null, zamanlayici: null, ardisikHata: 0, bitti: false,
  };
  oturumlar.set(yaziciId, o);
  o.birak = kameraAbone(yaziciId, kaynak, {
    onKare: (jpeg) => {
      if (o.bitti) return;
      o.bekleyen = jpeg;
      void gonder(o);
    },
    onHata: (mesaj) => void oturumuBitir(o, mesaj),
  });
}

async function gonder(o: Oturum): Promise<void> {
  if (o.bitti || o.gonderiliyor || !o.bekleyen) return;
  const kalan = o.sonGonderim + KARE_ARALIK_MS - Date.now();
  if (kalan > 0) {
    if (!o.zamanlayici) {
      o.zamanlayici = setTimeout(() => {
        o.zamanlayici = null;
        void gonder(o);
      }, kalan);
    }
    return;
  }
  const kare = o.bekleyen;
  o.bekleyen = null;
  o.gonderiliyor = true;
  o.sonGonderim = Date.now();
  try {
    if (dbDuraklatildi()) return; // uyku/uyanma: ağ işlemlerine girme, kare atlanır
    if (aktarimSuruyor(o.host)) {
      await oturumuBitir(o, AKTARIM_SURUYOR_MESAJI, AKTARIM_BEKLEME_MS);
      return;
    }
    const an = Date.now();
    const anahtar = kareAnahtari(o.yaziciId, an);
    await putObjectBytes(anahtar, new Uint8Array(kare), "image/jpeg", o.r2);
    o.anahtarlar.push(anahtar);
    const adres = await presignGetUrl(anahtar, o.r2, ADRES_OMRU_SN);
    const yazildi = await remotePrisma.$executeRawUnsafe(
      kameraKareYazSql(), adres, an, Date.now(), o.yaziciId, SAHIP,
    );
    if (yazildi !== 1) {
      // Sahiplik başka masaüstüne geçmiş (biz uyurken devraldı) — sessizce çekil.
      await oturumuBitir(o, null);
      return;
    }
    o.ardisikHata = 0;
    for (const eski of silinecekKareler(o.anahtarlar)) void deleteObject(eski, o.r2).catch(() => {});
    o.anahtarlar = o.anahtarlar.slice(-TUTULAN_KARE);
  } catch {
    if (++o.ardisikHata >= AZAMI_ARDISIK_HATA) {
      await oturumuBitir(o, "Kamera görüntüsü buluta gönderilemiyor (bağlantı sorunu).");
    }
  } finally {
    o.gonderiliyor = false;
    if (!o.bitti && o.bekleyen) void gonder(o);
  }
}

/** Oturumu kapat: kameradan ayrıl, kareleri sil, satırı bırak (hata varsa nedeniyle). */
async function oturumuBitir(o: Oturum, hata: string | null, beklemeMs = HATA_BEKLEME_MS): Promise<void> {
  if (o.bitti) return;
  o.bitti = true;
  if (oturumlar.get(o.yaziciId) === o) oturumlar.delete(o.yaziciId);
  if (o.zamanlayici) clearTimeout(o.zamanlayici);
  try {
    o.birak?.();
  } catch {
    /* zaten kapalı */
  }
  for (const k of o.anahtarlar) void deleteObject(k, o.r2).catch(() => {});
  o.anahtarlar = [];
  if (hata) {
    await hataYaz(o.yaziciId, hata, beklemeMs);
  } else {
    await remotePrisma
      .$executeRawUnsafe(kameraSahiplikBirakSql(), Date.now(), o.yaziciId, SAHIP)
      .catch(() => {});
  }
}

/** Çöken/kapanan bir oturumdan kalan kareler — açılışta bir kez, yalnız eskileri. */
async function artikKareleriSupur(): Promise<void> {
  const r2 = await getR2Config().catch(() => null);
  if (!r2) return;
  const nesneler = await listModelObjects(r2, "camera/");
  const sinir = Date.now() - ARTIK_KARE_YASI_MS;
  for (const n of nesneler) {
    if (n.lastModified && n.lastModified.getTime() < sinir) {
      await deleteObject(n.key, r2).catch(() => {});
    }
  }
}
