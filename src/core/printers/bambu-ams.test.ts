/**
 * AMS ALGILAMA — AMS'si takılı olmayan yazıcıya AMS'li baskı gitmesin.
 *
 * 23 Eyl 2026: A2L'de AMS yoktu; renk ekranı dört hayali yuva gösterip `use_ams: true` gönderdi,
 * yazıcı ısınıp başlangıçta bekledi ve baskı hiç başlamadı. Yazıcı AMS olmadığını raporunda
 * açıkça söylüyordu; okumuyorduk. Aşağıdaki A2L parçası CANLI rapordan alındı.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { amsDurumuCoz, toWarning } from "./bambu";
import { AMS_YOK_COK_RENK, amsKarari } from "./ams-karari";

/** A2L, AMS takılı değil (23 Eyl 2026, canlı rapor). */
const A2L = {
  ams: {
    ams: [], ams_exist_bits: "0", tray_exist_bits: "0", tray_is_bbl_bits: "0", tray_tar: "0",
    tray_now: "0", tray_pre: "0", tray_read_done_bits: "0", tray_reading_bits: "0", version: 2,
  },
  vir_slot: [{ id: "255", tray_color: "F55A74FF", tray_type: "PLA", tray_info_idx: "GFL99" }],
};

/** A1 + AMS lite (eski biçim: dış makara `vt_tray`). */
const A1 = {
  ams: {
    ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA", tray_color: "000000FF" }, { id: "1" }] }],
    ams_exist_bits: "1",
    tray_now: "0",
  },
  vt_tray: { id: "254", tray_type: "PETG", tray_color: "FFFFFFFF" },
};

describe("AMS durumu", () => {
  it("A2L: AMS yok, dış makara yeni biçimden (vir_slot) okunur", () => {
    expect(amsDurumuCoz(A2L)).toEqual({ amsVar: false, harici: { renk: "#F55A74", tip: "PLA" } });
  });

  it("A1: AMS var, dış makara eski biçimden (vt_tray) okunur", () => {
    expect(amsDurumuCoz(A1)).toEqual({ amsVar: true, harici: { renk: "#FFFFFF", tip: "PETG" } });
  });

  it("yalnız varlık bitleri gelirse onlara bakılır", () => {
    expect(amsDurumuCoz({ ams: { ams_exist_bits: "0" } }).amsVar).toBe(false);
    expect(amsDurumuCoz({ ams: { ams_exist_bits: "3" } }).amsVar).toBe(true);
  });

  it("rapor gelmediyse ya da AMS alanı yoksa BİLİNMİYOR (null) — engelleme yapılmaz", () => {
    expect(amsDurumuCoz(undefined).amsVar).toBeNull();
    expect(amsDurumuCoz({}).amsVar).toBeNull();
    expect(amsDurumuCoz({ ams: { tray_now: "1" } }).amsVar).toBeNull();
  });
});

describe("AMS kararı", () => {
  it("AMS yoksa her zaman dış makara, istenen ne olursa olsun", () => {
    expect(amsKarari(false, true, 1)).toEqual({ useAms: false, hata: null });
    expect(amsKarari(false, undefined, 1)).toEqual({ useAms: false, hata: null });
  });

  it("AMS yokken çok renkli dosya reddedilir", () => {
    expect(amsKarari(false, true, 3)).toEqual({ useAms: false, hata: AMS_YOK_COK_RENK });
  });

  it("AMS varsa ya da bilinmiyorsa istenen aynen geçer", () => {
    expect(amsKarari(true, true, 3)).toEqual({ useAms: true, hata: null });
    expect(amsKarari(true, false, 1)).toEqual({ useAms: false, hata: null });
    expect(amsKarari(null, true, 3)).toEqual({ useAms: true, hata: null });
  });
});

describe("uyarı birimi (HMS)", () => {
  // Kodlar üreticinin kod sayfalarıyla doğrulandı (23 Eyl 2026).
  const uyari = (attr: number, code: number) => toWarning(attr, code);

  it("0300 hareket kartı — AMS DEĞİL (A2L'nin motor kalibrasyonu uyarısı)", () => {
    const w = uyari(0x03002e00, 0x00030001);
    expect(w.code).toBe("0300-2E00-0003-0001");
    expect(w.text).toBe("Yazıcı mekaniği — Yazıcı uyarı veriyor");
  });

  it("07xx ve 12xx AMS (makaradaki filament bitti)", () => {
    expect(uyari(0x07002000, 0x00020001).text).toBe("AMS — Yazıcı ciddi bir uyarı veriyor");
    expect(uyari(0x07012000, 0x00020001).text).toMatch(/^AMS — /);
    expect(uyari(0x12002000, 0x00020001).text).toMatch(/^AMS — /);
  });

  it("0500 ana kart, 0C00 kamera; bilinmeyen birim uydurulmaz", () => {
    expect(uyari(0x05000600, 0x00020001).text).toMatch(/^Ana kart — /);
    expect(uyari(0x0c000300, 0x00030005).text).toMatch(/^Kamera — /);
    expect(uyari(0x18000000, 0x00030001).text).toBe("Yazıcı uyarı veriyor");
  });
});

describe("kararın bağlandığı yerler", () => {
  const oku = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("baskı ucu iki başlatma yolunda da KARARI gönderir, isteneni değil", () => {
    const ucu = oku("src/app/api/models/[id]/print/route.ts");
    expect(ucu).toContain("getBambuAmsDurumu(");
    expect(ucu).toMatch(/useAms: karar\.useAms/);
    expect(ucu).toMatch(/useAms: useAmsEtkin/);
    // Ham istek doğrudan yazıcıya gitmemeli.
    expect(ucu).not.toMatch(/\{\s*md5: mf\.contentMd5, amsMapping: bambuMapping, useAms,/);
    expect(ucu).not.toMatch(/amsMapping: bambuMapping, useAms, plateParam/);
  });

  it("renk ekranı AMS yoksa yuva seçtirmez ve kutuyu gizler", () => {
    const ekran = oku("src/components/printers/print-flow.tsx");
    expect(ekran).toMatch(/const amsYok = isBambu && slotsQ\.data\?\.amsVar === false/);
    expect(ekran).toMatch(/amsKarari\(slotsQ\.data\?\.amsVar, useAms, printColors\.length\)/);
    expect(ekran).toMatch(/isBambu && !amsYok && \(/);
  });

  it("yuva ucu AMS durumunu ekrana taşır", () => {
    const uc = oku("src/app/api/printers/[id]/slots/route.ts");
    expect(uc).toMatch(/slots: read, amsVar, harici/);
  });
});
