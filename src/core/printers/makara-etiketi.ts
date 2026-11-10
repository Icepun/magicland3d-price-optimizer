/**
 * MAKARA ETİKETİ — kendi bastığımız makaralara yapıştırılan BOŞ NFC etiketiyle otomatik tanıma (U1).
 *
 * Neden etikete veri yazmıyoruz: U1'in stok yazılımı yalnız Snapmaker'ın İMZALI etiketini okur
 * (u1-klipper `filament_protocol.py`, RSA imza) — taklit edilemez. Topluluk "Extended Firmware"i
 * (paxx12, v2.0.0-paxx12-24+) ise tanımadığı etiketin bile kimliğini (UID) `filament_detect`
 * nesnesinde yayınlıyor ve `POST /printer/filament_detect/set` ile dışarıdan filament bilgisi
 * yazdırıyor (docs/design/filament_detect.md). Böylece eşleşme (UID → renk + tür) UYGULAMADA
 * tutulur: makara yeniden doldurulunca etiketi değil kaydı değiştirmek yeter, yazıcı cihazı gerekmez.
 *
 * Bu dosya SAF (ağ / veritabanı yok) — durum çözümü, karar ve gönderilecek bilgi burada test edilir.
 */
import { BAMBU_FILAMENT_PROFILI } from "./filament-tipleri";

/** Bir besleme kanalındaki (= kafa) etiketin yazıcıdaki hâli. */
export interface KanalEtiketi {
  kanal: number;
  /** Büyük harf onaltılık, ayraçsız ("B087686A"). */
  uid: string;
  /** Ham bayt dizisi — `filament_detect/set`'e aynen geri verilir. */
  uidBaytlari: number[];
  tur: "NTAG" | "M1" | null;
  /** Etikette (ya da daha önce bizim yazdığımız) filament bilgisi var mı (`OFFICIAL`). */
  bilgili: boolean;
  satici: string | null;
  /** RRGGBB (büyük harf) — bilgi yoksa null. */
  renk: string | null;
  tip: string | null;
}

/** Uygulamada tutulan eşleşme: bu etiketli makarada hangi filament var. */
export interface MakaraEtiketKaydi {
  renk: string; // RRGGBB
  tip: string;
  guncellendi: string; // ISO
}

const temizMetin = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s.toUpperCase() !== "NONE" ? s : null;
};

/** `CARD_UID` → onaltılık + baytlar. Etiket yoksa firmware 0 (sayı) ya da boş dizi koyar. */
export function uidCoz(ham: unknown): { uid: string; baytlar: number[] } | null {
  if (!Array.isArray(ham) || ham.length === 0) return null;
  const baytlar = ham.map((b) => Number(b));
  if (baytlar.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
  if (baytlar.every((b) => b === 0)) return null;
  return { uid: baytlar.map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase(), baytlar };
}

/** `status.filament_detect` → etiketi olan kanallar (etiketsiz kanal listeye girmez). */
export function filamentDetectEtiketleri(fd: unknown): KanalEtiketi[] {
  const info = (fd as { info?: unknown } | null | undefined)?.info;
  if (!Array.isArray(info)) return [];
  const out: KanalEtiketi[] = [];
  info.forEach((ham, kanal) => {
    const i = (ham ?? {}) as Record<string, unknown>;
    const u = uidCoz(i.CARD_UID);
    if (!u) return;
    const bilgili = i.OFFICIAL === true;
    const rgb = Number(i.RGB_1);
    out.push({
      kanal,
      uid: u.uid,
      uidBaytlari: u.baytlar,
      tur: i.CARD_TYPE === "NTAG" || i.CARD_TYPE === "M1" ? i.CARD_TYPE : null,
      bilgili,
      satici: temizMetin(i.VENDOR),
      renk: bilgili && Number.isInteger(rgb) && rgb >= 0 ? (rgb & 0xffffff).toString(16).padStart(6, "0").toUpperCase() : null,
      tip: bilgili ? temizMetin(i.MAIN_TYPE) : null,
    });
  });
  return out;
}

export type EtiketKarari =
  /** Etiket kendi bilgisini taşıyor (Snapmaker'ın ya da başka bir üreticinin) — dokunulmaz. */
  | { tur: "kendi" }
  /** Tanınmayan boş etiket — kullanıcı bir kez tanıtmalı. */
  | { tur: "yeni" }
  /** Tanımlı ve yazıcıda zaten doğru. */
  | { tur: "guncel" }
  /** Tanımlı ama yazıcıya henüz gitmedi (yeni takıldı ya da kayıt değişti). */
  | { tur: "uygula"; kayit: MakaraEtiketKaydi };

export function etiketKarari(etiket: KanalEtiketi, kayit: MakaraEtiketKaydi | undefined): EtiketKarari {
  // Snapmaker'ın imzalı etiketi her zaman kazanır — üstüne asla yazılmaz.
  if (etiket.satici?.toLowerCase() === "snapmaker") return { tur: "kendi" };
  if (!kayit) return etiket.bilgili ? { tur: "kendi" } : { tur: "yeni" };
  if (etiket.bilgili && etiket.renk === kayit.renk.toUpperCase() && etiket.tip === kayit.tip) return { tur: "guncel" };
  return { tur: "uygula", kayit };
}

/** Panelde çipe yansıyan durum (`kendi` panelde ayrıca gösterilmez). */
export function etiketDurumu(k: EtiketKarari): "tanimli" | "yeni" | null {
  if (k.tur === "guncel" || k.tur === "uygula") return "tanimli";
  if (k.tur === "yeni") return "yeni";
  return null;
}

/** `filament_detect/set` için `info` — firmware bilinmeyen alanı reddettiği için yalnız yazılabilir alanlar. */
export function filamentDetectBilgisi(etiket: KanalEtiketi, kayit: MakaraEtiketKaydi): Record<string, unknown> {
  const profil = BAMBU_FILAMENT_PROFILI[kayit.tip] ?? BAMBU_FILAMENT_PROFILI[kayit.tip.split("-")[0]] ?? BAMBU_FILAMENT_PROFILI.PLA;
  return {
    VENDOR: "Generic",
    MAIN_TYPE: kayit.tip,
    SUB_TYPE: "Basic",
    RGB_1: parseInt(kayit.renk, 16) & 0xffffff,
    ALPHA: 255,
    HOTEND_MIN_TEMP: profil.min,
    HOTEND_MAX_TEMP: profil.max,
    CARD_UID: etiket.uidBaytlari,
    ...(etiket.tur ? { CARD_TYPE: etiket.tur } : {}),
  };
}

/** AppSetting'teki JSON → kayıtlar. Bozuk girdi atlanır (en kötü: makara yeniden tanıtılır). */
export function kayitlariCoz(ham: string | null | undefined): Record<string, MakaraEtiketKaydi> {
  if (!ham) return {};
  try {
    const j = JSON.parse(ham) as Record<string, unknown>;
    const out: Record<string, MakaraEtiketKaydi> = {};
    for (const [uid, v] of Object.entries(j ?? {})) {
      const k = v as Partial<MakaraEtiketKaydi>;
      if (!/^[0-9A-F]{8,20}$/.test(uid)) continue;
      if (typeof k?.renk !== "string" || !/^[0-9A-Fa-f]{6}$/.test(k.renk)) continue;
      if (typeof k.tip !== "string" || !k.tip) continue;
      out[uid] = { renk: k.renk.toUpperCase(), tip: k.tip, guncellendi: typeof k.guncellendi === "string" ? k.guncellendi : "" };
    }
    return out;
  } catch {
    return {};
  }
}
