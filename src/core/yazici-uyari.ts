/**
 * YAZICI UYARI METİNLERİ — sunum yardımcıları (saf; masaüstü ve telefon ortak kullanabilir).
 *
 * Yazıcıdan gelen açıklama (Bambu'nun resmi cümlesi ya da Klipper'ın ham mesajı) üç yerde
 * gösteriliyor: kartın uyarı bandı, "Duraklatıldı · …" satırı ve bildirim. Her biri farklı
 * uzunluk istiyor; kırpma/başlık kuralı tek yerde dursun.
 */

const buyukBasla = (s: string) => (s ? s.charAt(0).toLocaleUpperCase("tr-TR") + s.slice(1) : s);

export interface UyariParcalari {
  /** Ne oldu — tek kısa cümle ("AMS lite yuva 2'deki filament tükendi"). */
  baslik: string;
  /** Ne yapmalı / ayrıntı ("Lütfen yeni bir filament takın."). Yoksa null. */
  aciklama: string | null;
}

/**
 * Açıklamayı "ne oldu" + "ne yapmalı" diye ikiye böl: ilk cümle başlık, kalanı ayrıntı.
 * Ayraç noktalama + boşluktur — "0.4 mm" gibi ondalıklar bölünmez.
 */
export function uyariParcala(metin: string | null | undefined): UyariParcalari {
  const t = (metin ?? "").replace(/\s+/g, " ").trim();
  if (!t) return { baslik: "", aciklama: null };
  // Çok kısa bir baş ("Not:") başlık olmasın diye en az 12 karakter aranır.
  const m = /^(.{12,}?)([.;:!?])\s+(\S.*)$/.exec(t);
  if (!m) return { baslik: t.replace(/[.;:!]+$/, ""), aciklama: null };
  return { baslik: m[1].trim(), aciklama: buyukBasla(m[3].trim()) };
}

/** Uzun açıklamayı cümle sınırında kısalt (bildirim gövdesi / tek satırlık alanlar için). */
export function uyariKisalt(metin: string | null | undefined, sinir = 160): string {
  const t = (metin ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= sinir) return t;
  const { baslik } = uyariParcala(t);
  if (baslik.length <= sinir) return baslik;
  return `${baslik.slice(0, sinir - 1).trimEnd()}…`;
}

/**
 * En sık durumlar için KISA ad — bildirim başlığı ve özet şeridi ("Filament bitti").
 * Tanımadığı metinde null döner; çağıran genel başlığa ("Baskı duraklatıldı") düşer.
 * Sıra önemli: "filament tükendi … sıkışıp sıkışmadığını kontrol edin" önce BİTTİ'ye uymalı.
 */
const KISA_NEDENLER: readonly (readonly [RegExp, string])[] = [
  [/iptal edildi/, "Baskı iptal edildi"],
  [/kullanıcı tarafından duraklatıldı/, "Elle duraklatıldı"],
  [/filament\S*\s.*?(tükendi|bitti)|filament bitti|yuva \d+ boş|makara\S* boş/, "Filament bitti"],
  [/filament\S*\s.*?(dolan|düğüm|sıkış)/, "Filament sıkıştı"],
  [/filament\S*\s.*?kop(muş|tu)/, "Filament koptu"],
  [/filament\S*\s.*?(çekemiyor|yüklenemedi|çekilemedi|çıkarılamadı|ekstrüde edilemedi)/, "Filament beslenemiyor"],
  [/(püskürtme ucu|nozul|ekstrüder)\S*\s.*?tıkan/, "Nozul tıkanmış olabilir"],
  [/tabla\S*\s.*?(algılanmadı|temiz değil)/, "Tablayı kontrol et"],
  [/spagetti|kümelenme|filament birikmesi|dağılmış/, "Baskı dağılmış olabilir"],
  [/(kapı|kapak|kapağı)\S*\s.*?açık/, "Kapak açık"],
  [/park yerine dönemedi/, "Baskı kafası takıldı"],
  [/sıcaklı\S*\s.*?(anormal|yüksek|düşük)|ısınmıyor|ısıtıcı/, "Isıtma sorunu"],
  [/depolama|sd kart|microsd/, "Hafıza kartı sorunu"],
];

export function kisaNeden(metin: string | null | undefined): string | null {
  const t = (metin ?? "").toLocaleLowerCase("tr-TR");
  if (!t.trim()) return null;
  for (const [desen, ad] of KISA_NEDENLER) if (desen.test(t)) return ad;
  return null;
}

/** "extruder" → 1. kafa, "extruder1" → 2. kafa (Klipper adları ve U1 dizinleri sıfırdan başlar). */
const kafaNo = (dizin: string | number | undefined) => {
  const n = Number(dizin ?? 0);
  return Number.isFinite(n) ? n + 1 : 1;
};

/**
 * Klipper / Snapmaker U1'in HAM durum mesajını kullanıcı diline çevir.
 *
 * Geçmiş bildirimlerde aynen şunlar görüldü (12 Eki 2026 ölçümü): `detected noodle`,
 * `detected dirty bed`, `extruder[2]: state: load_feeding, error: wheel_speed!raw msg:logic error!`
 * ve `{"coded": "0002-0523-   1-0042", "msg":"Extruder extruder1 malfunction after parking, …"}`.
 * Tanınmayan mesaj UYDURULMAZ: olduğu gibi (JSON ise yalnız `msg` alanı) döner.
 */
export function klipperMesajiCevir(ham: string | null | undefined): string | null {
  let t = (ham ?? "").trim();
  if (!t) return null;
  if (t.startsWith("{")) {
    try {
      const msg = (JSON.parse(t) as { msg?: unknown }).msg;
      if (typeof msg === "string" && msg.trim()) t = msg.trim();
    } catch {
      // JSON kesik gelmiş olabilir — "msg" alanını elle ayıkla.
      const m = /"msg"\s*:\s*"([^"]+)/.exec(t);
      if (m) t = m[1].trim();
    }
  }
  const kucuk = t.toLowerCase();

  const besleme = /extruder\[(\d+)\]:\s*state:\s*(\w+),\s*error:\s*(\w+)/i.exec(t);
  if (besleme) {
    const kafa = kafaNo(besleme[1]);
    if (besleme[3].toLowerCase() === "wheel_speed") {
      return `${kafa}. kafa filamenti çekemiyor — makara bitmiş ya da filament takılmış olabilir`;
    }
    if (/unload/i.test(besleme[2])) return `${kafa}. kafadan filament çıkarılamadı`;
    if (/load/i.test(besleme[2])) return `${kafa}. kafaya filament yüklenemedi`;
    return `${kafa}. kafada filament besleme sorunu`;
  }
  const park = /extruder(\d*)\s+failed to return to park position/i.exec(t);
  if (park) return `${kafaNo(park[1] === "" ? 0 : park[1])}. kafa park yerine dönemedi`;

  if (kucuk.includes("detected noodle")) return "Baskı dağılmış olabilir (spagetti algılandı)";
  if (kucuk.includes("detected dirty bed")) return "Tabla temiz değil — üzerinde parça ya da kalıntı var";
  if (kucuk.includes("detected residue")) return "Tablada önceki baskıdan kalıntı var";
  if (/filament\s*run\s*out|runout/i.test(t)) return "Filament bitti";
  const isitici = /heater (\S+) not heating at expected rate/i.exec(t);
  if (isitici) {
    const hedef = /bed/i.test(isitici[1]) ? "Tabla" : "Nozul";
    return `${hedef} beklenen hızda ısınmıyor — ısıtıcıyı ve kablosunu kontrol et`;
  }
  if (/adc out of range/i.test(t)) return "Sıcaklık sensörü okunamıyor — kablo ya da sensör arızalı olabilir";
  if (/lost communication with mcu|timer too close/i.test(t)) return "Yazıcının kartıyla bağlantı koptu — yazıcıyı yeniden başlat";
  if (/move out of range/i.test(t)) return "Hareket yazıcının sınırlarını aşıyor";
  if (/must home/i.test(t)) return "Eksenler sıfırlanmamış";
  if (/extrude below minimum temp|below minimum extrude temp/i.test(t)) return "Nozul yeterince sıcak değil";
  return t;
}
