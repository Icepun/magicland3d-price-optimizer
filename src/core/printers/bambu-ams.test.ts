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
import { aktifYuva, amsDurumuCoz, amsYuvalariCoz, bambuAmsEslemesi, buildBambuStartPayload, toWarning } from "./bambu";
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

/**
 * A2L + AMS LITE (25 Eyl 2026): baskı yazıcıya gidiyor ama PREPARE'de takılıp kalıyordu.
 * Birim 16 numaralı ve komutta yalnız düz eşleme vardı. Aşağıdaki birim CANLI rapordan.
 */
const A2L_LITE = {
  ams: {
    ams: [{
      id: "16",
      tray: [
        { id: "0" }, { id: "1" },
        { id: "2", tray_type: "PLA", tray_color: "FF6A13FF" },
        { id: "3", tray_type: "PLA", tray_color: "000000FF" },
      ],
    }],
    ams_exist_bits: "1000", tray_exist_bits: "c000000", tray_now: "255",
  },
};
const A1_LITE = { ams: { ams: [{ id: "0", tray: [0, 1, 2, 3].map((i) => ({ id: String(i), tray_type: "PLA", tray_color: "FFFFFFFF" })) }] } };
const IKI_BIRIM = {
  ams: { ams: [0, 1].map((u) => ({ id: String(u), tray: [0, 1, 2, 3].map((i) => ({ id: String(i), tray_type: "PLA", tray_color: "FFFFFFFF" })) })) },
};

describe("AMS birimi ve baskı eşlemesi", () => {
  it("A2L: makaralar 1-4 olarak kalır, birim numarası (16) ayrıca tutulur", () => {
    const y = amsYuvalariCoz(A2L_LITE);
    expect(y.map((s) => [s.slot, s.amsId, s.yuva, s.empty])).toEqual([[0, 16, 0, true], [1, 16, 1, true], [2, 16, 2, false], [3, 16, 3, false]]);
    expect(y[2].color).toBe("#FF6A13");
  });

  it("A2L: düz eşleme birim içi makara, ayrıntılıda {16, makara}; kullanılmayan renk {255,255}", () => {
    const e = bambuAmsEslemesi([-1, -1, -1, 3], amsYuvalariCoz(A2L_LITE));
    expect(e.duz).toEqual([-1, -1, -1, 3]);
    expect(e.ayrintili).toEqual([
      { ams_id: 255, slot_id: 255 }, { ams_id: 255, slot_id: 255 }, { ams_id: 255, slot_id: 255 }, { ams_id: 16, slot_id: 3 },
    ]);
  });

  it("A1 (birim 0) değişmez: düz 0-3, ayrıntılıda {0, makara}", () => {
    const e = bambuAmsEslemesi([2, 0], amsYuvalariCoz(A1_LITE));
    expect(e.duz).toEqual([2, 0]);
    expect(e.ayrintili).toEqual([{ ams_id: 0, slot_id: 2 }, { ams_id: 0, slot_id: 0 }]);
  });

  it("iki AMS: makara numaraları çakışmaz (0-7), düz = birim×4+makara", () => {
    const y = amsYuvalariCoz(IKI_BIRIM);
    expect(y.map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const e = bambuAmsEslemesi([5], y);
    expect(e.duz).toEqual([5]);
    expect(e.ayrintili).toEqual([{ ams_id: 1, slot_id: 1 }]);
  });

  it("AMS HT (128+): düz = birim numarası, makara 0", () => {
    const ht = { ams: { ams: [{ id: "128", tray: [{ id: "0", tray_type: "PETG", tray_color: "FFFFFFFF" }] }] } };
    const e = bambuAmsEslemesi([0], amsYuvalariCoz(ht));
    expect(e.duz).toEqual([128]);
    expect(e.ayrintili).toEqual([{ ams_id: 128, slot_id: 0 }]);
  });

  it("baskı komutu: AMS kullanılıyorsa ams_mapping2 gider; dış makara yolu değişmez", () => {
    const y = amsYuvalariCoz(A2L_LITE);
    const ams = buildBambuStartPayload("a.3mf", "a", false, "m", { useAms: true, amsMapping: [-1, -1, -1, 3] }, y) as { print: Record<string, unknown> };
    expect(ams.print.ams_mapping).toEqual([-1, -1, -1, 3]);
    expect(ams.print.ams_mapping2).toEqual([
      { ams_id: 255, slot_id: 255 }, { ams_id: 255, slot_id: 255 }, { ams_id: 255, slot_id: 255 }, { ams_id: 16, slot_id: 3 },
    ]);
    const dis = buildBambuStartPayload("a.3mf", "a", false, "m", { useAms: false }, y) as { print: Record<string, unknown> };
    expect(dis.print.ams_mapping).toEqual([0]);
    expect(dis.print).not.toHaveProperty("ams_mapping2");
  });

  it("şu anki makara: A2L'de tray_now birim içi (0-3), normal AMS'te birim×4+makara", () => {
    expect(aktifYuva(2, amsYuvalariCoz(A2L_LITE))).toBe(2);
    expect(aktifYuva(255, amsYuvalariCoz(A2L_LITE))).toBeNull();
    expect(aktifYuva(1, amsYuvalariCoz(A1_LITE))).toBe(1);
    expect(aktifYuva(5, amsYuvalariCoz(IKI_BIRIM))).toBe(5);
  });
});
