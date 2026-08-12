/**
 * Basılan dosya ↔ model eşleştirmesi — YANLIŞ MODEL GÖSTERME gerilemesinin koruması.
 *
 * Baskı kartındaki "canlı dolan model" görselleştirmesi, yazıcının bildirdiği dosya adını bir
 * model kaydına eşleyerek o kaydın geometrisini/önizlemesini gösterir. Eşleştirme eskiden YALNIZ
 * ada bakıyordu: aynı adla yeniden dilimlenmiş iki dosya varsa (ör. "Xbox Dual 2s11dk.gcode"
 * güncellenip tekrar yüklendiğinde) kartta SESSİZCE yanlış modelin geometrisi çıkıyordu —
 * kullanıcı basılmayan ürünün fotoğrafını görüyordu.
 *
 * Oysa yükleme adında zaten bir içerik imzası var: dosyanın MD5'inin ilk 10 hanesi
 * ("Darth Kol Gövde 2s1dk-8d28f87e04.gcode"). Adı bu içerikten biz ürettiğimiz için imza
 * kanıttır. Artık imza doğrulanır, kayıttaki içerikle çelişirse eşleştirme REDDEDİLİR.
 *
 * Aşağıdaki dosya adları ve MD5'ler dört yazıcının CANLI durumundan okundu (12 Ağu 2026):
 * Neptune 4 Pro, Neptune 4 Plus, Snapmaker U1, Bambu Lab A1.
 */
import { describe, expect, it } from "vitest";
import {
  buildSignedUploadName,
  extractContentSignature,
  matchPrintedModel,
  normalizeModelFileName,
  stripContentSignature,
  type ModelFileCandidate,
} from "./print-file-signature";

/** Sahadan: yazıcının bildirdiği ad → o dosyanın kaydındaki tam MD5 + kayıttaki orijinal ad. */
const CANLI = {
  neptunePro: {
    basilan: "Darth Kol Gövde 2s1dk-8d28f87e04.gcode",
    kayit: { id: "cmq0qwh2p000vwfg0lobw0pv9", originalName: "Darth Kol Gövde 2s1dk.gcode", contentMd5: "8d28f87e04d0e3fdcade39b2d9325f87" },
  },
  neptunePlus: {
    basilan: "Darth Kol Bacak 3s32dk-9e997568b1.gcode",
    kayit: { id: "cmq0qxjyo0011wfg05ruprbcc", originalName: "Darth Kol Bacak 3s32dk.gcode", contentMd5: "9e997568b1d4ad68bd9d52fd0234806c" },
  },
  snapmaker: {
    basilan: "Dark Lord PS5 19s55dk-4c655543a7.gcode",
    kayit: { id: "cmsachluk005lwfmwxdcqx1p1", originalName: "Dark Lord PS5 19s55dk.gcode", contentMd5: "4c655543a702f269ae625c01c5f9116e" },
  },
  // Bambu adı ASCII'ye çevirip boşluğu "_" yapar; "-" ve hex haneler KORUNUR → imza sağ kalır.
  bambu: {
    basilan: "PISTON_CUP_P1S_plate_1.gcode-90b29c4d56.3mf",
    kayit: { id: "cmsq4pdet000ewfks1lnrmo89", originalName: "PISTON_CUP_P1S_plate_1.gcode.3mf", contentMd5: "90b29c4d56faed8227d7292fcb3bdad5" },
  },
} satisfies Record<string, { basilan: string; kayit: ModelFileCandidate }>;

describe("içerik imzası — ayrıştırma", () => {
  it("dört yazıcının GERÇEK dosya adından imzayı çıkarır", () => {
    expect(extractContentSignature(CANLI.neptunePro.basilan)).toBe("8d28f87e04");
    expect(extractContentSignature(CANLI.neptunePlus.basilan)).toBe("9e997568b1");
    expect(extractContentSignature(CANLI.snapmaker.basilan)).toBe("4c655543a7");
    expect(extractContentSignature(CANLI.bambu.basilan)).toBe("90b29c4d56");
  });

  it("imzasız (elle yazıcıya atılmış) adda null döner", () => {
    expect(extractContentSignature("Darth Kol Gövde 2s1dk.gcode")).toBeNull();
    expect(extractContentSignature("Balerin Takı 1s4dk.gcode.3mf")).toBeNull();
  });

  it("ad zaten '-10 hane' ile bitiyorsa SON imzayı okur", () => {
    // Kullanıcı dosyasını "Model-1234567890.gcode" diye adlandırdıysa yükleme adı iki ek taşır;
    // geçerli olan bizim eklediğimiz sondaki imzadır.
    expect(extractContentSignature("Model-1234567890-8d28f87e04.gcode")).toBe("8d28f87e04");
  });

  it("üretim ↔ ayrıştırma gidiş-dönüşü (uzantı zinciri ve uzantısız ad dahil)", () => {
    const md5 = "8d28f87e04d0e3fdcade39b2d9325f87";
    expect(buildSignedUploadName("Darth Kol Gövde 2s1dk.gcode", md5)).toBe("Darth Kol Gövde 2s1dk-8d28f87e04.gcode");
    expect(buildSignedUploadName("Balerin Takı 1s4dk.gcode.3mf", md5)).toBe("Balerin Takı 1s4dk.gcode-8d28f87e04.3mf");
    expect(buildSignedUploadName("Gövde", md5)).toBe("Gövde-8d28f87e04");
    for (const ad of ["Darth Kol Gövde 2s1dk.gcode", "Balerin Takı 1s4dk.gcode.3mf", "Gövde"]) {
      expect(extractContentSignature(buildSignedUploadName(ad, md5))).toBe("8d28f87e04");
      expect(stripContentSignature(buildSignedUploadName(ad, md5))).toBe(ad);
    }
  });
});

describe("dosya adı normalize", () => {
  it("imza / uzantı / plaka eki / Türkçe farkını siler", () => {
    expect(normalizeModelFileName(CANLI.neptunePro.basilan)).toBe("darthkolgovde2s1dk");
    expect(normalizeModelFileName("Darth Kol Gövde 2s1dk.gcode")).toBe("darthkolgovde2s1dk");
    // Bambu tarafı: "Standı — Siyah" → "Standi_Siyah"; eski normalize (yalnız küçültme)
    // "standı" ≠ "standi" yüzünden Bambu'yu HİÇ eşleyemiyordu.
    expect(normalizeModelFileName("Standi_Siyah.3mf")).toBe(normalizeModelFileName("Standı — Siyah.gcode.3mf"));
  });

  it("klasör önekini atar", () => {
    expect(normalizeModelFileName("cache/Darth Kol Gövde 2s1dk-8d28f87e04.gcode")).toBe("darthkolgovde2s1dk");
  });
});

describe("eşleştirme — canlı yazıcılar", () => {
  it("dört yazıcının basmakta olduğu dosya doğru kayda eşleşir", () => {
    for (const { basilan, kayit } of Object.values(CANLI)) {
      const r = matchPrintedModel(basilan, [kayit]);
      expect(r.hit?.id).toBe(kayit.id);
      expect(r.reason).toBe("signature");
    }
  });

  it("imza tutuyorsa ad tutmasa bile eşleşir (aynı dosya, kayıtta farklı adla)", () => {
    // Dosya yeniden adlandırıldıysa içerik yine aynı içeriktir — imza bunun kanıtı.
    const r = matchPrintedModel(CANLI.snapmaker.basilan, [
      { ...CANLI.snapmaker.kayit, originalName: "Dark Lord PS5 (yeni isim).gcode" },
    ]);
    expect(r.hit?.id).toBe(CANLI.snapmaker.kayit.id);
    expect(r.reason).toBe("signature");
  });
});

describe("eşleştirme — asıl gerileme: aynı adla yeniden dilimlenmiş dosya", () => {
  it("adı tutan ama İÇERİĞİ tutmayan kaydı REDDEDER (yanlış model gösterme)", () => {
    // Yazıcı eski dilimi basıyor; kayıttaki dosya o adla yeniden dilimlenip değiştirilmiş.
    // Eski davranış: ad tuttuğu için YENİ modelin geometrisi/önizlemesi gösteriliyordu.
    const r = matchPrintedModel(CANLI.neptunePro.basilan, [
      { ...CANLI.neptunePro.kayit, contentMd5: "0000000000ffffffffffffffffffffff" },
    ]);
    expect(r.hit).toBeNull();
    expect(r.reason).toBe("signature-mismatch");
  });

  it("doğru içerikli kayıt listede varsa onu seçer, adaşını değil", () => {
    const yanlis: ModelFileCandidate = { id: "yanlis", originalName: "Darth Kol Gövde 2s1dk.gcode", contentMd5: "1111111111aaaaaaaaaaaaaaaaaaaaaa" };
    const r = matchPrintedModel(CANLI.neptunePro.basilan, [yanlis, CANLI.neptunePro.kayit]);
    expect(r.hit?.id).toBe(CANLI.neptunePro.kayit.id);
  });

  it("imza var ama md5'i HİÇ yazılmamış kayıt varsa ad eşleşmesi sürer (geriye dönük uyum)", () => {
    // Eski kayıtlarda contentMd5 boş olabilir; boş md5 imzayı çürütemez → eşleşme kaybolmasın.
    const r = matchPrintedModel(CANLI.neptunePro.basilan, [
      { id: "eski", originalName: "Darth Kol Gövde 2s1dk.gcode", contentMd5: null },
    ]);
    expect(r.hit?.id).toBe("eski");
    expect(r.reason).toBe("name");
  });
});

describe("eşleştirme — imzasız eski dosyalar", () => {
  it("imza yoksa ad eşleşmesi çalışmaya devam eder", () => {
    const r = matchPrintedModel("Darth Kol Gövde 2s1dk.gcode", [CANLI.neptunePro.kayit]);
    expect(r.hit?.id).toBe(CANLI.neptunePro.kayit.id);
    expect(r.reason).toBe("name");
  });

  it("farklı içerikli iki adaş varsa eşleştirme YAPILMAZ (belirsizlik)", () => {
    const r = matchPrintedModel("Xbox Dual 2s11dk.gcode", [
      { id: "a", originalName: "Xbox Dual 2s11dk.gcode", contentMd5: "aaaaaaaaaa11111111111111111111ff", r2Key: "models/a.gcode" },
      { id: "b", originalName: "Xbox Dual 2s11dk.gcode", contentMd5: "bbbbbbbbbb22222222222222222222ff", r2Key: "models/b.gcode" },
    ]);
    expect(r.hit).toBeNull();
    expect(r.reason).toBe("ambiguous");
  });

  it("AYNI dosyanın varyantlara kopyalanmış satırları belirsizlik SAYILMAZ", () => {
    // Sahada olağan: "Balerin Takı 59dk.gcode" 16 satır, hepsi aynı R2 nesnesi. Bunları
    // belirsiz sayarsak çalışan eşleşmeleri kaybederiz.
    const satirlar: ModelFileCandidate[] = Array.from({ length: 16 }, (_, i) => ({
      id: `varyant-${i}`, originalName: "Balerin Takı 59dk.gcode", contentMd5: null, r2Key: "models/balerin-59dk.gcode",
    }));
    const r = matchPrintedModel("Balerin Takı 59dk.gcode", satirlar);
    expect(r.hit).not.toBeNull();
    expect(r.reason).toBe("name");
  });

  it("aday yoksa null döner", () => {
    expect(matchPrintedModel("Hiç Yüklenmemiş.gcode", [CANLI.neptunePro.kayit]).hit).toBeNull();
    expect(matchPrintedModel("   ", [CANLI.neptunePro.kayit]).reason).toBe("empty");
  });
});

/**
 * SALT RAKAMLI son ek imza SANILIYORDU: 10 haneli rakam da geçerli hex'tir. Kullanıcının elle
 * yazıcıya attığı "Kupa Altligi-2024010112.gcode" gibi bir dosyada `extractContentSignature`
 * "2024010112" döndürüyor, hiçbir kayıt bunu doğrulayamadığı için md5'i DOLU olan tüm ad
 * eşleşmeleri eleniyor ve `signature-mismatch` ile eşleştirme REDDEDİLİYORDU. Sonuç: baskı
 * kartındaki canlı dolan 3B model ve önizleme sessizce kayboluyordu.
 */
describe("salt rakamlı son ek imza SAYILMAZ", () => {
  it("tarih/sayaç eki imza olarak okunmaz", () => {
    expect(extractContentSignature("Kupa Altligi-2024010112.gcode")).toBeNull();
    expect(extractContentSignature("Kupa Altligi-1234567890.gcode")).toBeNull();
  });

  it("en az bir harf içeren gerçek imza hâlâ okunur", () => {
    expect(extractContentSignature("Darth Kol Gövde 2s1dk-8d28f87e04.gcode")).toBe("8d28f87e04");
    expect(extractContentSignature("Kupa Altligi 45dk-1234abcd90.gcode")).toBe("1234abcd90");
  });

  it("rakamlı sonekli dosya ada göre EŞLEŞİR (sessizce reddedilmez)", () => {
    const r = matchPrintedModel("Kupa Altligi-2024010112.gcode", [
      { id: "k1", originalName: "Kupa Altligi-2024010112.gcode", contentMd5: "aaaaaaaaaa11111111111111111111ff" },
    ]);
    expect(r.hit?.id).toBe("k1");
    expect(r.reason).toBe("name");
  });

  it("gerçek imza çelişirse eşleştirme yine REDDEDİLİR (yanlış model gösterme koruması)", () => {
    const r = matchPrintedModel("Kupa Altligi-8d28f87e04.gcode", [
      { id: "k1", originalName: "Kupa Altligi-8d28f87e04.gcode", contentMd5: "ffffffffff11111111111111111111ff" },
    ]);
    expect(r.hit).toBeNull();
    expect(r.reason).toBe("signature-mismatch");
  });
});
