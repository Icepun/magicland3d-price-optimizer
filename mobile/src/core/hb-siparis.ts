/**
 * HEPSİBURADA SİPARİŞ LİSTELERİNİN TOPLANMASI — masaüstü + telefon AYNI fonksiyon.
 *
 * HB siparişleri tek uçtan gelmez:
 *  • `/orders` yalnız "Open" (paketlenecek) siparişlerin KALEM listesini verir (sipariş no tekrar eder),
 *  • `/packages/…/{""|shipped|delivered|undelivered}` paket özetleri: statüsüz uç tam sipariş
 *    (kalem + tutar) verir, diğerleri yalnız sipariş no + tarih (tutar detaydan çekilir),
 *  • iptal/iade listeleri (yolu doğrulanmadı, bkz. `HB_TALEP_YOLLARI`).
 * Bu dosya listeleri çekip TEK sipariş haritasında birleştirir. Detay çekimi, önbellek ve kalıcı
 * kayıt her tarafın kendi işidir.
 *
 * ⚠️ NEDEN ÇEKİRDEKTE: kurallar önce masaüstünde düzeltildi, telefonun kendi kopyası geride kaldı
 * (27 Eyl 2026'da fark edildi):
 *  1. telefon iptal/iade listelerini hiç okumuyordu → teslimden sonra iade edilen sipariş telefonun
 *     cirosunda ve yazdığı finans geçmişinde "satıldı" olarak kalıyordu,
 *  2. telefon özet listelerde teslim/kargo damgasını sipariş tarihi sayıyordu → finans geçmişine
 *     yanlış `orderedAt` gidiyor, ay sonunda verilen sipariş sonraki aya kayıyordu,
 *  3. telefon açık siparişlerin yalnız ilk 100 kalemini okuyordu.
 * `npm run sync-core` ile telefona kopyalanır — bu kurallar bir daha iki ayrı yerde yazılmasın.
 */
import { HEPSIBURADA_STATUS_KINDS, hbSonDurum } from "./order-status-kind";

/* ── Defansif okuma yardımcıları (HB yanıt şekli uçtan uca değişiyor) ───────── */

export function hbStr(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}

export function hbArray(o: unknown, keys: readonly string[]): Record<string, unknown>[] {
  if (Array.isArray(o)) return o as Record<string, unknown>[];
  if (!o || typeof o !== "object") return [];
  const r = o as Record<string, unknown>;
  for (const k of keys) {
    if (Array.isArray(r[k])) return r[k] as Record<string, unknown>[];
  }
  return [];
}

/** Çözülebilen İLK tarih → epoch ms; hiçbiri çözülemezse null. Sıra = öncelik. */
export function hbTarihMs(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const d = new Date(typeof v === "number" ? v : String(v));
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return null;
}

/**
 * Paket/talep kaydının GERÇEK sipariş numarası (paket numarası değil).
 *
 * ⚠️ STATÜSÜZ PAKET LİSTESİNDE sipariş numarası paketin kendisinde YOK, kalemlerinde
 * (`items[].orderNumber`) duruyor — ölçüldü 3 Eki 2026. Kalemlere bakılmadığı için anahtar paket
 * numarasına düşüyordu: aynı sipariş paketlenince ikinci kez "yeni sipariş" bildirildi (1-2 gün
 * sonra, toplu) ve finans geçmişine ikinci kez yazıldı (Hepsiburada'nın 223 kaydının 83'ü).
 * Teslim/kargo listeleri ise numarayı üstte büyük harfle (`OrderNumber`) veriyor.
 */
export function hbSiparisNo(p: Record<string, unknown>): string {
  const ust = hbStr(p.OrderNumber, p.orderNumber, Array.isArray(p.OrderNumbers) ? p.OrderNumbers[0] : "");
  if (ust) return ust;
  for (const kalem of hbArray(p, ["items", "Items", "lines", "orderItems"])) {
    const no = hbStr(kalem.orderNumber, kalem.OrderNumber);
    if (no) return no;
  }
  return "";
}

/** Paket numarası — statüsüz listede `packageNumber`, teslim/kargo listelerinde `PackageNumber`. */
export function hbPaketNo(p: Record<string, unknown>): string {
  return hbStr(p.packageNumber, p.PackageNumber);
}

/**
 * ⚠️ SİPARİŞİN VERİLİŞ ANI — teslim/kargo tarihi DEĞİL.
 *
 * Bu tarih ekranda "sipariş saati", listenin sıralama ölçütü ve finans geçmişinin `orderedAt`'i.
 * `DeliveredDate`/`ShippedDate` öne alınınca teslim edilmiş sipariş "teslim edildiği saatte
 * verilmiş" görünüyor, ay sonu siparişi sonraki ayın cirosuna yazılıyordu.
 */
function hbPaketVerilisMs(p: Record<string, unknown>): number | null {
  return hbTarihMs(p.orderDate, p.CreatedDate, p.PackageReadyDate);
}

/** İptal/iade kaydının veriliş anı. Talep damgaları yalnız son çare (sipariş tarihi yoksa). */
function hbTalepVerilisMs(p: Record<string, unknown>): number | null {
  return hbTarihMs(p.orderDate, p.CreatedDate, p.ClaimDate, p.CancelledDate, p.ReturnDate);
}

/* ── Sayfalama ─────────────────────────────────────────────────────────────── */

export const HB_SAYFA_BOYU = 100;
/** Bir listeden okunacak en çok kayıt — bozuk yanıtta sonsuz döngü freni. */
export const HB_SAYFA_TAVANI = 3000;

/** `/orders` yanıtında kalem dizisinin olabileceği alanlar. */
const HB_ACIK_ANAHTARLARI = ["items", "orders", "data", "content", "result"] as const;
/** Paket ve iptal/iade yanıtlarında kayıt dizisinin olabileceği alanlar. */
const HB_OZET_ANAHTARLARI = ["items", "data", "content", "result"] as const;

/**
 * Bir listenin TÜM sayfaları: boş sayfada, eksik (son) sayfada ya da `null` yanıtta durur.
 *
 * Açık siparişler eskiden tek sayfa okunuyordu. O uç sipariş değil KALEM döndürdüğü için
 * 100'den fazla kalem olunca fazlası sessizce düşüyordu.
 */
export async function hbTumSayfalar(
  sayfaGetir: (offset: number, limit: number) => Promise<unknown>,
  anahtarlar: readonly string[]
): Promise<Record<string, unknown>[]> {
  const hepsi: Record<string, unknown>[] = [];
  for (let offset = 0; offset < HB_SAYFA_TAVANI; offset += HB_SAYFA_BOYU) {
    const sayfa = await sayfaGetir(offset, HB_SAYFA_BOYU);
    if (sayfa == null) break; // iptal/iade: uç yok ya da geçici hata → bu tur atla
    const dizi = hbArray(sayfa, anahtarlar);
    if (!dizi.length) break;
    hepsi.push(...dizi);
    if (dizi.length < HB_SAYFA_BOYU) break;
  }
  return hepsi;
}

/* ── İptal / iade uçları ───────────────────────────────────────────────────── */

export type HbTalepTuru = "cancelled" | "returned";

/**
 * İptal/iade liste uçlarının ADAY yolları (`{mid}` = mağaza kimliği).
 *
 * ⚠️ DOĞRULANMADI (HB belgeleri kapalı). Sırayla denenir, çalışan hatırlanır, hiçbiri çalışmazsa
 * uç "yok" sayılır ve sipariş akışı ETKİLENMEZ. Gerçek yol doğrulanınca listenin başına alınmalı.
 */
export const HB_TALEP_YOLLARI: Record<HbTalepTuru, readonly string[]> = {
  cancelled: ["/packages/merchantid/{mid}/cancelled", "/orders/merchantid/{mid}/cancelled"],
  returned: ["/packages/merchantid/{mid}/returned", "/claims/merchantid/{mid}"],
};

/**
 * "Bu yol YOK" demek olan durumlar — yalnız bunlarda aday kalıcı olarak elenir.
 *
 * 400 ve 401 BİLEREK DIŞARIDA: 400 "yol doğru ama istek eksik" (HB liste uçları tarih aralığı
 * isteyebiliyor), 401 ise kimlik sorunu. İkisini "yol yok" saymak, DOĞRU yolu kalıcı olarak
 * eleyip iptal/iade taramasını sessizce kapatırdı.
 */
export const HB_YOL_YOK_DURUMLARI: ReadonlySet<number> = new Set([403, 404, 405, 501]);

/** Fırlatılan hatanın HTTP durumu (`status` alanı); bilinmiyorsa 0 (ağ hatası vb.). */
function hataDurumu(hata: unknown): number {
  const s = hata && typeof hata === "object" ? (hata as { status?: unknown }).status : undefined;
  return typeof s === "number" ? s : 0;
}

/**
 * İptal/iade listesinin bir sayfası. HİÇBİR koşulda fırlatmaz.
 *
 * Yol yoksa (403/404/405/501) `null` döner ve `hafiza` ömrünce bir daha denenmez; geçici hatada
 * (500, limit, ağ) yalnız bu çağrı `null` döner, aday "yok" sayılmaz.
 */
export async function hbTalepSayfasi(
  tur: HbTalepTuru,
  sayfa: { offset: number; limit: number },
  baglam: {
    merchantId: string;
    /** tür → çalışan yol şablonu; null = hiçbiri yok. */
    hafiza: Map<HbTalepTuru, string | null>;
    /** Host'suz yol + sorgu → gövde. Başarısızlıkta HTTP durumunu `status` alanında taşıyan hata fırlatır. */
    iste: (yol: string) => Promise<unknown>;
  }
): Promise<unknown | null> {
  const bilinen = baglam.hafiza.get(tur);
  if (bilinen === null) return null;
  const mid = encodeURIComponent(baglam.merchantId);
  const adaylar = bilinen ? [bilinen] : HB_TALEP_YOLLARI[tur];
  let hepsiYok = true;
  for (const sablon of adaylar) {
    try {
      const govde = await baglam.iste(
        `${sablon.replace("{mid}", mid)}?offset=${sayfa.offset}&limit=${sayfa.limit}`
      );
      baglam.hafiza.set(tur, sablon);
      return govde;
    } catch (hata) {
      // Yolun yanlış olduğunu SADECE durum kodundan anlarız; mesaj metnine bakmayız.
      if (!HB_YOL_YOK_DURUMLARI.has(hataDurumu(hata))) hepsiYok = false;
    }
  }
  if (hepsiYok) baglam.hafiza.set(tur, null);
  return null;
}

/* ── Birleştirme ───────────────────────────────────────────────────────────── */

export type HbPaketDurumu = "" | "shipped" | "delivered" | "undelivered";

/** Okunan paket listeleri ve listeden gelen siparişe verilecek durum adı. */
const HB_PAKET_LISTELERI: readonly (readonly [HbPaketDurumu, string])[] = [
  ["", "Packaged"],
  ["shipped", "Shipped"],
  ["delivered", "Delivered"],
  ["undelivered", "UnDelivered"],
];

const HB_TALEP_LISTELERI: readonly (readonly [HbTalepTuru, string])[] = [
  ["cancelled", "Cancelled"],
  ["returned", "Returned"],
];

export interface HbToplananSiparis<K> {
  /** Ham HB durum adı (Open/Packaged/Shipped/Delivered/UnDelivered/Cancelled/Returned…). */
  status: string;
  /** Siparişin VERİLİŞ anı (epoch ms) — teslim/kargo/iade damgası değil. Bilinmiyorsa null. */
  date: number | null;
  customer: string | null;
  /** null = özet listeden geldi; kalem ve tutar sipariş detayından çekilecek. */
  lines: K[] | null;
}

/**
 * İptal/iade kayıtlarını sipariş haritasına uygula.
 *
 * ⚠️ GÜVENLİK FRENİ: sipariş başka bir listede de görünüyorsa, ancak KAYDIN KENDİ durumu
 * iptal/iade diyorsa ezilir. Uç yolu doğrulanmadığı için "her siparişi döndüren" bir yanıt
 * bütün ciroyu silemesin. Hiçbir aktif listede olmayan sipariş zaten ciroya girmiyordu; iptal/iade
 * olarak eklenir ki kalıcı kayıttaki eski "satıldı" satırı düzelsin.
 */
export function hbTalepleriUygula<K>(
  siparisler: Map<string, HbToplananSiparis<K>>,
  kayitlar: readonly Record<string, unknown>[],
  etiket: string
): void {
  for (const p of kayitlar) {
    const on = hbSiparisNo(p);
    if (!on) continue;
    const kendi = hbStr(p.status, p.Status, p.packageStatus, p.claimStatus);
    const kendiIptal = kendi ? HEPSIBURADA_STATUS_KINDS[kendi]?.kind === "cancelled" : false;
    const mevcut = siparisler.get(on);
    if (mevcut) {
      if (kendiIptal) mevcut.status = kendi;
      continue;
    }
    siparisler.set(on, {
      status: kendiIptal ? kendi : etiket,
      date: hbTalepVerilisMs(p),
      customer: null,
      lines: null,
    });
  }
}

export interface HbListeUclari {
  /** `/orders` sayfası (açık siparişlerin kalemleri). Fırlatırsa toplama da düşer. */
  acikSiparisler(offset: number, limit: number): Promise<unknown>;
  /** `/packages` sayfası. Fırlatırsa toplama da düşer. */
  paketler(durum: HbPaketDurumu, offset: number, limit: number): Promise<unknown>;
  /** İptal/iade sayfası; uç yoksa null. Fırlatırsa o liste boş sayılır, toplama sürer. */
  talepler(tur: HbTalepTuru, offset: number, limit: number): Promise<unknown | null>;
}

export interface HbToplamaSonucu<K> {
  siparisler: Map<string, HbToplananSiparis<K>>;
  /**
   * Bu turda aynı siparişin hem sipariş hem paket numarasıyla görüldüğü çiftler — eskiden paket
   * numarasıyla yazılmış kalıntı finans satırlarını temizlemek için (masaüstü kullanır).
   */
  paketCiftleri: { orderNo: string; packageNo: string }[];
}

/**
 * Açık siparişleri, paket listelerini ve iptal/iade listelerini çekip birleştirir.
 * `kalemCevir`: ham HB kalemi → çağıranın kalem şekli (masaüstü ve telefonun alanları farklı).
 */
export async function hbSiparisleriTopla<K>(
  uclar: HbListeUclari,
  kalemCevir: (kalem: Record<string, unknown>) => K
): Promise<HbToplamaSonucu<K>> {
  const siparisler = new Map<string, HbToplananSiparis<K>>();
  const paketCiftleri: { orderNo: string; packageNo: string }[] = [];

  // a) Açık siparişler — FLAT kalem listesi (sipariş no tekrar eder) → sipariş no'ya göre grupla.
  const acikKalemler = await hbTumSayfalar((o, l) => uclar.acikSiparisler(o, l), HB_ACIK_ANAHTARLARI);
  for (const li of acikKalemler) {
    const on = hbStr(li.orderNumber, li.orderId, li.id);
    if (!on) continue;
    let e = siparisler.get(on);
    if (!e) {
      e = {
        status: hbStr(li.status) || "Open",
        date: hbTarihMs(li.orderDate, li.createdDate),
        customer: hbStr(li.customerName) || null,
        lines: [],
      };
      siparisler.set(on, e);
    }
    (e.lines as K[]).push(kalemCevir(li));
  }

  // b) Paket listeleri + iptal/iade listeleri AYNI ANDA çekilir (iptal/iade turu bekleme süresi
  //    eklemesin); birleştirme sırası yine sabit: önce paketler, sonra iptal/iade.
  const [paketSonuclari, talepSonuclari] = await Promise.all([
    Promise.all(
      HB_PAKET_LISTELERI.map(([durum]) =>
        hbTumSayfalar((o, l) => uclar.paketler(durum, o, l), HB_OZET_ANAHTARLARI)
      )
    ),
    Promise.all(
      HB_TALEP_LISTELERI.map(([tur]) =>
        // İptal/iade listesi sipariş çekimini ASLA bozmaz.
        hbTumSayfalar((o, l) => uclar.talepler(tur, o, l), HB_OZET_ANAHTARLARI).catch(
          () => [] as Record<string, unknown>[]
        )
      )
    ),
  ]);

  for (const [idx, paketler] of paketSonuclari.entries()) {
    const [durum, etiket] = HB_PAKET_LISTELERI[idx];
    // Statüsüz uç TAM sipariş verir (kalem + tutar `items` içinde) → detay çekimi GEREKMEZ.
    //
    // 🔴 ÇİFT SAYIM: anahtar olarak önce packageNumber alınıyordu, kargoya verilen siparişlerde
    // ise OrderNumber. Aynı sipariş iki ayrı kimlikle kaydedilip finans geçmişinde iki kez
    // sayılıyordu. Artık GERÇEK sipariş numarası kazanır; paket numarası yalnız sipariş numarası
    // hiç gelmediğinde iç kimlik olarak kullanılır.
    const tamSiparis = durum === "";
    for (const p of paketler) {
      const orderNo = hbSiparisNo(p);
      // Paket↔sipariş çifti HER listeden toplanır: paket numarasıyla yazılmış eski kopya kayıtlar
      // (bkz. hbSiparisNo) ancak çift bilinince kesin olarak temizlenebiliyor.
      const paketNo = hbPaketNo(p);
      if (orderNo && paketNo && orderNo !== paketNo) paketCiftleri.push({ orderNo, packageNo: paketNo });
      if (tamSiparis) {
        const packageNo = paketNo || hbStr(p.id);
        const key = orderNo || packageNo;
        if (!key || siparisler.has(key)) continue;
        siparisler.set(key, {
          status: hbStr(p.status) || etiket,
          date: hbPaketVerilisMs(p),
          customer: hbStr(p.recipientName, p.customerName) || null,
          lines: hbArray(p, ["items", "lines", "orderItems"]).map(kalemCevir),
        });
      } else {
        if (!orderNo) continue;
        const mevcut = siparisler.get(orderNo);
        if (mevcut) {
          // Aynı sipariş birden çok listede: İLERİDEKİ durum kazanır (teslim, kargoyu ezer).
          mevcut.status = hbSonDurum(mevcut.status, etiket);
          continue;
        }
        siparisler.set(orderNo, { status: etiket, date: hbPaketVerilisMs(p), customer: null, lines: null });
      }
    }
  }

  // c) İptal/iade: teslim edilmiş bir sipariş sonradan iade edilince diğer listelerden düşüyor,
  //    kalıcı kayıtta ise "satıldı" olarak kalıp ciroda sonsuza kadar duruyordu.
  for (const [idx, kayitlar] of talepSonuclari.entries()) {
    hbTalepleriUygula(siparisler, kayitlar, HB_TALEP_LISTELERI[idx][1]);
  }

  return { siparisler, paketCiftleri };
}
