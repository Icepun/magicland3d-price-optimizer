import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  GIZLI_AZAMI,
  gizliHaritaGuncelle,
  gizliHaritaOku,
  gizliMi,
  uyariImzasi,
} from "../../mobile/src/lib/bildirim-gizle";

/**
 * TELEFONDA BİLDİRİM KAPATMA — "bildirimleri silme yok, hep bildirim görünüyor".
 *
 * Kalıcı bildirimler (baskı bitti vb.) veritabanında okundu işaretlenir. Anlık uyarılar (stok ≤ 1,
 * filament, duraklayan yazıcı) her yoklamada yeniden hesaplandığı için METNİYLE gizlenir: durum
 * değişince (stok 1 → 0) metin değişir ve uyarı geri gelir — kapatılan sorun sessizce büyümesin.
 * Gizli liste iki telefon ortak (AppSetting).
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const stok = { id: "stock:p1", title: "Stok bitiyor", body: "Kupa: 1 adet kaldı" };

describe("anlık uyarı gizleme kuralı", () => {
  it("kapatılan uyarı aynı metinle gelirse gizli kalır", () => {
    const h = gizliHaritaGuncelle({}, [stok], new Set([stok.id]));
    expect(gizliMi(h, stok)).toBe(true);
  });

  it("durum değişince (metin farklı) uyarı YENİDEN görünür", () => {
    const h = gizliHaritaGuncelle({}, [stok], new Set([stok.id]));
    expect(gizliMi(h, { ...stok, body: "Kupa: stok bitti" })).toBe(false);
    expect(gizliMi(h, { ...stok, title: "Stok bitti" })).toBe(false);
  });

  it("başka bir uyarıyı gizlemez", () => {
    const h = gizliHaritaGuncelle({}, [stok], new Set([stok.id]));
    expect(gizliMi(h, { ...stok, id: "stock:p2" })).toBe(false);
  });

  it("çözülen sorunun kaydı atılır — aynı metinle geri gelirse görünür", () => {
    const h1 = gizliHaritaGuncelle({}, [stok], new Set([stok.id]));
    // Stok yenilendi: uyarı artık hesaplanmıyor. Başka bir uyarı kapatılırken kayıt budanır.
    const diger = { id: "print:u1", title: "U1 duraklatıldı", body: "Filament bitti" };
    const h2 = gizliHaritaGuncelle(h1, [diger], new Set([diger.id]));
    expect(gizliMi(h2, stok)).toBe(false);
    expect(gizliMi(h2, diger)).toBe(true);
  });

  it("hâlâ görünen uyarıların kaydı korunur", () => {
    const h1 = gizliHaritaGuncelle({}, [stok], new Set([stok.id]));
    const diger = { id: "print:u1", title: "U1 duraklatıldı", body: "Filament bitti" };
    const h2 = gizliHaritaGuncelle(h1, [diger], new Set([stok.id, diger.id]));
    expect(gizliMi(h2, stok)).toBe(true);
  });

  it(`kayıt sayısı ${GIZLI_AZAMI} ile sınırlı, en yeniler kalır`, () => {
    const cok = Array.from({ length: GIZLI_AZAMI + 25 }, (_, i) => ({ id: `s:${i}`, title: "t", body: `${i}` }));
    const h = gizliHaritaGuncelle({}, cok, new Set(cok.map((u) => u.id)));
    expect(Object.keys(h)).toHaveLength(GIZLI_AZAMI);
    expect(gizliMi(h, cok[cok.length - 1])).toBe(true);
    expect(gizliMi(h, cok[0])).toBe(false);
  });

  it("bozuk/eski ayar hiçbir şeyi gizlemez ve çökmez", () => {
    for (const deger of [null, undefined, "", "{", "[]", "3", '"x"', "null"]) {
      expect(gizliHaritaOku(deger)).toEqual({});
    }
    expect(gizliHaritaOku(JSON.stringify({ a: "x|y", b: 5, c: null }))).toEqual({ a: "x|y" });
  });

  it("imza başlık + metin", () => {
    expect(uyariImzasi(stok)).toBe("Stok bitiyor|Kupa: 1 adet kaldı");
  });
});

describe("bildirim veritabanı katmanı", () => {
  const db = oku("mobile/src/lib/db/notifications.ts");

  it("kalıcılar hiç gizlenmez (onlar okundu işaretlenir); sayılar gizlilersiz", () => {
    expect(db).toContain("const gorunen = alerts.filter((a) => a.persistent || !gizliMi(gizli, a));");
    expect(db).toContain("counts: { total: gorunen.length, critical, warning: gorunen.length - critical - success }");
  });

  it("kapatma tek parça yazılır (okundu + gizli liste birlikte)", () => {
    const govde = db.slice(db.indexOf("export async function bildirimleriKapat("));
    expect(govde).toContain("UPDATE Notification SET acknowledgedAt = ?");
    expect(govde).toContain("GIZLI_AYAR_ANAHTARI");
    expect(govde).toContain("await writeBatch(stmts)");
  });
});

describe("bildirimler ekranı", () => {
  const ekran = oku("mobile/src/app/notifications.tsx");

  it("her satır kaydırılarak ve ✕ ile kapanır; başlıkta Tümünü temizle", () => {
    expect(ekran).toContain('from "react-native-gesture-handler/ReanimatedSwipeable"');
    expect(ekran).toContain("onSwipeableOpen={onSil}");
    expect(ekran).toContain('accessibilityLabel="Bildirimi kapat"');
    expect(ekran).toContain('accessibilityLabel="Tümünü temizle"');
  });

  it("kapatma iyimser: satır hemen düşer, sonra liste tazelenir", () => {
    expect(ekran).toContain("onMutate:");
    expect(ekran).toContain('onSettled: () => qc.invalidateQueries({ queryKey: ["notifications"] })');
  });

  it("zil rozeti aynı sorgudan (gizliler sayılmaz)", () => {
    const baslik = oku("mobile/src/components/kit/Header.tsx");
    expect(baslik).toContain('queryKey: ["notifications"]');
    expect(baslik).toContain("const toplam = data?.counts.total ?? 0;");
  });
});
