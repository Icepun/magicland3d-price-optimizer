/**
 * KARGO ADRESİ — müşterinin Shopify'a yazdığı serbest metinden il / ilçe / mahalle / telefon çıkar.
 *
 * Neden gerekli: Shopify'ın Türkiye adresinde ilçe alanı yok; HepsiJet ise il + ilçeyi ayrı ve
 * KENDİ adlarıyla istiyor (yanlış ilçe = yanlış şube). Canlı veride (Kas 2026, son 40 sipariş)
 * `city` alanı bazen ilçe ("Kartal"), bazen "İlçe / İl" ("Kağıthane / İstanbul"), bazen yalnız il,
 * bir kez posta kodu; `province` 11'inde boş, 1'inde yanlış; ilçe çoğu kez adres metninin içinde.
 * 13 Kas 2026'dan beri ödeme sayfası etiketleri: address1 = Mahalle, address2 = Cadde/Sokak,
 * city = "İlçe / İl" — ama müşteri yine serbest yazar.
 *
 * Bu modül yalnız ÖNERİR: kullanıcı her gönderiyi iki sütunlu ekranda görüp onaylar. Emin
 * olunamayan alanlar `kontrol`'de işaretlenir; arayüz onları vurgular.
 *
 * SAF — ağ / veritabanı yok. İl ve ilçe adları dışarıdan (HepsiJet'in listesi) verilir.
 * ⚠️ Kişisel veri işler: hiçbir şey günlüğe yazılmaz.
 */

export interface HamAdres {
  ad?: string | null;
  soyad?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  phone?: string | null;
}

/** Kargo firmasının il kaydı — adlar onun yazdığı gibi ("İZMİR", "MENEMEN"). */
export interface IlKaydi {
  ad: string;
  ilceler: string[];
}

export interface CozulenAdres {
  ad: string;
  soyad: string;
  /** Kargo firmasının listesindeki adıyla; bulunamadıysa null. */
  il: string | null;
  ilce: string | null;
  /** Mahalle ADAYI (müşterinin yazdığı, ek temizlenmiş) — listeyle eşleştirme arayüzde yapılır. */
  mahalle: string | null;
  acikAdres: string;
  /** 05xxxxxxxxx; çözülemediyse null. */
  telefon: string | null;
  /** Alan → kullanıcıya gösterilecek kısa uyarı. Boşsa her şey emin. */
  kontrol: Partial<Record<"il" | "ilce" | "telefon" | "adres" | "ad", string>>;
}

/** Karşılaştırma için sadeleştir: Türkçe harfler katlanır, büyük harf, yalnız harf/rakam/boşluk. */
export function sade(metin: string | null | undefined): string {
  return (metin ?? "")
    .replace(/[İIıi]/g, "I")
    .replace(/[Şş]/g, "S")
    .replace(/[Ğğ]/g, "G")
    .replace(/[Üü]/g, "U")
    .replace(/[Öö]/g, "O")
    .replace(/[Çç]/g, "C")
    .replace(/[Ââ]/g, "A")
    .replace(/[Îî]/g, "I")
    .replace(/[Ûû]/g, "U")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/** `aranan` (sade), `metin` (sade) içinde TAM sözcük(ler) olarak geçiyor mu → son geçtiği yer, yoksa -1. */
function sozcukKonumu(metin: string, aranan: string): number {
  if (!aranan) return -1;
  const dolgulu = ` ${metin} `;
  return dolgulu.lastIndexOf(` ${aranan} `);
}

/** Telefonu `05xxxxxxxxx` biçimine getir; cep numarası değilse null. */
export function telefonCoz(ham: string | null | undefined): string | null {
  let r = (ham ?? "").replace(/\D/g, "");
  if (r.startsWith("0090")) r = r.slice(4);
  else if (r.startsWith("90") && r.length === 12) r = r.slice(2);
  if (r.length === 11 && r.startsWith("0")) r = r.slice(1);
  return r.length === 10 && r.startsWith("5") ? `0${r}` : null;
}

/** "Yenişehir Mah." / "yenisehir mahallesi" → "Yenişehir". Mahalle kalıbı yoksa null. */
function mahalleAdayi(metin: string): string | null {
  const m = /([^,;/\n]*?)\s+mah(?:allesi|alesi|alle|\.|\b)/i.exec(metin);
  const aday = m?.[1]?.trim().replace(/^[\s\-–:.]+/, "");
  return aday && aday.length >= 2 && aday.length <= 40 ? aday : null;
}

/** İki adres satırını birleştir; biri diğerini içeriyorsa yinelenmez. */
function adresBirlestir(a: string, b: string): string {
  const sa = sade(a), sb = sade(b);
  if (!sa) return b.trim();
  if (!sb) return a.trim();
  if (sa === sb || sa.includes(sb)) return a.trim();
  if (sb.includes(sa)) return b.trim();
  return `${a.trim()} ${b.trim()}`;
}

interface IlEslesmesi { il: IlKaydi; kaynak: "province" | "city" | "adres" }

export function adresCoz(ham: HamAdres, iller: IlKaydi[]): CozulenAdres {
  const kontrol: CozulenAdres["kontrol"] = {};
  const a1 = (ham.address1 ?? "").trim();
  const a2 = (ham.address2 ?? "").trim();
  const sCity = sade(ham.city);
  const sProvince = sade(ham.province);
  const sAdres = sade(`${a1} ${a2}`);

  // ── Ad ──
  let ad = (ham.ad ?? "").trim();
  let soyad = (ham.soyad ?? "").trim();
  if (!soyad && ad.includes(" ")) {
    const parcalar = ad.split(/\s+/);
    soyad = parcalar.pop()!;
    ad = parcalar.join(" ");
  }
  if (!ad || !soyad) kontrol.ad = "Ad ya da soyad eksik.";

  // ── İl adayları (öncelik sırasıyla) ──
  const sIller = iller.map((il) => ({ il, s: sade(il.ad) }));
  const adaylar: IlEslesmesi[] = [];
  const ekle = (il: IlKaydi, kaynak: IlEslesmesi["kaynak"]) => {
    if (!adaylar.some((x) => x.il === il)) adaylar.push({ il, kaynak });
  };
  const provinceIli = sIller.find((x) => x.s === sProvince)?.il ?? null;
  // Müşteri "İlçe / İl" yazdıysa city'deki il, province'tan güvenilirdir (province boş / yanlış olabiliyor).
  for (const x of sIller) if (sozcukKonumu(sCity, x.s) >= 0) ekle(x.il, "city");
  if (provinceIli) ekle(provinceIli, "province");
  for (const x of sIller) if (sozcukKonumu(sAdres, x.s) >= 0) ekle(x.il, "adres");

  // ── İlçe: her il adayında ara; city'de bulunan en güçlüsü ──
  interface Bulgu { il: IlKaydi; ilce: string; guclu: boolean; konum: number; ilKaynagi: IlEslesmesi["kaynak"] }
  const bulgular: Bulgu[] = [];
  const ilcedeAra = (il: IlKaydi, ilKaynagi: IlEslesmesi["kaynak"]) => {
    const sIl = sade(il.ad);
    for (const ilce of il.ilceler) {
      const s = sade(ilce);
      if (!s) continue;
      const merkez = s === "MERKEZ";
      if (sozcukKonumu(sCity, s) >= 0 && s !== sIl) {
        bulgular.push({ il, ilce, guclu: true, konum: 0, ilKaynagi });
        continue;
      }
      // "Merkez" adres metninde sıradan bir sözcük ("merkez mah.") → metinden ilçe sayılmaz.
      if (merkez) continue;
      const k = sozcukKonumu(sAdres, s);
      // İlçe adı il adıyla aynıysa (ör. il adı geçen her adres) metinden ilçe sayılmaz.
      if (k >= 0 && s !== sIl) bulgular.push({ il, ilce, guclu: false, konum: k, ilKaynagi });
    }
  };
  for (const a of adaylar) ilcedeAra(a.il, a.kaynak);

  let il: IlKaydi | null = null;
  let ilce: string | null = null;
  // Adres metninde tesadüfen geçen başka bir il ("Ankara Cad.") güçlü eşleşmeyi bulandırmasın.
  const tumGuclu = bulgular.filter((x) => x.guclu);
  const oncelikli = tumGuclu.filter((x) => x.ilKaynagi !== "adres");
  const guclu = oncelikli.length ? oncelikli : tumGuclu;

  if (guclu.length === 1) {
    il = guclu[0].il;
    ilce = guclu[0].ilce;
  } else if (guclu.length > 1) {
    // city birden çok ilçe adı içeriyor (nadir) → ilk il adayınınki, işaretli.
    il = guclu[0].il;
    ilce = guclu[0].ilce;
    kontrol.ilce = "Birden çok ilçe adı geçiyor — kontrol et.";
  } else if (adaylar.length === 0) {
    // İl hiçbir yerde yok: city (ya da adres) TÜM ülkede tek bir ilçeye uyuyorsa il de ondan çıkar.
    const eslesen: { il: IlKaydi; ilce: string; cityde: boolean }[] = [];
    for (const kayit of iller) {
      for (const adi of kayit.ilceler) {
        const s = sade(adi);
        if (!s || s === "MERKEZ") continue;
        if (sozcukKonumu(sCity, s) >= 0) eslesen.push({ il: kayit, ilce: adi, cityde: true });
        else if (sozcukKonumu(sAdres, s) >= 0) eslesen.push({ il: kayit, ilce: adi, cityde: false });
      }
    }
    const cityde = eslesen.filter((e) => e.cityde);
    const secenekler = cityde.length ? cityde : eslesen;
    if (secenekler.length === 1) {
      il = secenekler[0].il;
      ilce = secenekler[0].ilce;
      kontrol.il = "İl yazılmamış — ilçeden bulundu.";
    } else {
      kontrol.il = secenekler.length > 1 ? "İl yazılmamış, ilçe adı birden çok ilde var." : "İl bulunamadı.";
      kontrol.ilce = "İlçeyi seç.";
    }
  } else {
    // İl belli, ilçe city'de yok → adres metninde ara.
    const zayif = bulgular.filter((b) => !b.guclu);
    // Önce en güvenilir il adayının bulguları; yoksa diğerleri.
    const ilSirasi = adaylar.map((a) => a.il);
    zayif.sort((x, y) => ilSirasi.indexOf(x.il) - ilSirasi.indexOf(y.il) || y.konum - x.konum);
    const ilkIl = zayif[0]?.il ?? adaylar[0].il;
    const buIlde = zayif.filter((b) => b.il === ilkIl);
    il = ilkIl;
    if (buIlde.length === 1) {
      ilce = buIlde[0].ilce;
      kontrol.ilce = "İlçe adres metninden bulundu — kontrol et.";
    } else if (buIlde.length > 1) {
      ilce = buIlde[0].ilce; // en sonda geçen (adresler "… ilçe / il" diye biter)
      kontrol.ilce = "Adreste birden çok ilçe adı geçiyor — kontrol et.";
    } else {
      // city yalnız il adıysa ve ilin "MERKEZ" ilçesi varsa en olası odur — yine de işaretli.
      const merkez = il.ilceler.find((x) => sade(x) === "MERKEZ");
      ilce = merkez && (sCity === sade(il.ad) || sCity === "MERKEZ") ? merkez : null;
      kontrol.ilce = ilce ? "İlçe yazılmamış — Merkez varsayıldı." : "İlçe bulunamadı — seç.";
    }
  }

  // İl kaynakları çelişiyorsa (province bir il, seçilen başka) kullanıcı görsün.
  if (il && provinceIli && provinceIli !== il) {
    kontrol.il = `Shopify'da il "${provinceIli.ad}" seçilmiş, adres ${il.ad} görünüyor.`;
  } else if (il && !kontrol.il && adaylar.find((x) => x.il === il)?.kaynak === "adres") {
    kontrol.il = "İl adres metninden bulundu — kontrol et.";
  }

  // ── Mahalle adayı ──
  // Yeni düzende address1 = mahalle. Kalıp ("… mah.") varsa o; yoksa address1 kısa ve rakamsızsa kendisi.
  const mahalle =
    mahalleAdayi(a1) ??
    mahalleAdayi(a2) ??
    (a1 && a1.length <= 30 && !/\d/.test(a1) && !a1.includes(",") ? a1 : null);

  // ── Açık adres + telefon ──
  const acikAdres = adresBirlestir(a1, a2);
  if (acikAdres.length < 10) kontrol.adres = "Adres çok kısa.";
  const telefon = telefonCoz(ham.phone);
  if (!telefon) kontrol.telefon = "Telefon cep numarası gibi görünmüyor.";

  return { ad, soyad, il: il?.ad ?? null, ilce, mahalle, acikAdres, telefon, kontrol };
}

/**
 * Müşterinin yazdığı mahalle adayını kargo firmasının mahalle listesinde bul (ad eşitliği, ek
 * ve Türkçe harf farkı gözetmeden). Tek eşleşme yoksa null — arayüz seçtirmez, boş bırakır.
 */
export function mahalleEsle(aday: string | null, mahalleler: string[]): string | null {
  const s = sade(aday).replace(/\s*(MAHALLESI|MAH|MH)$/, "").trim();
  if (!s) return null;
  const temiz = (m: string) => sade(m).replace(/\s*(MAHALLESI|MAH|MH)$/, "").trim();
  const tam = mahalleler.filter((m) => temiz(m) === s);
  if (tam.length === 1) return tam[0];
  if (tam.length > 1) return null;
  const baslayan = mahalleler.filter((m) => temiz(m).startsWith(`${s} `) || s.startsWith(`${temiz(m)} `));
  return baslayan.length === 1 ? baslayan[0] : null;
}
