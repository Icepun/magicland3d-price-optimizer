import { describe, expect, it } from "vitest";
import { familyMemberIds, fileContentKey, printerFamilyKey, sameFamily } from "./printer-family";

/**
 * SAHADA YAŞANDI (23 Eyl 2026): ikinci Snapmaker U1 eklenince ürün dosyaları ona hiç görünmedi.
 * Aynı marka + modeldeki yazıcılar aynı dosyayı basar; model bilinmiyorsa eşleştirme YAPILMAZ.
 */
const alt = { id: "u1-alt", type: "moonraker", brand: "snapmaker", model: "U1" };
const ust = { id: "u1-ust", type: "moonraker", brand: "snapmaker", model: " u1 " };
const bambu = { id: "a1", type: "bambu", brand: "bambu", model: "A1" };
const mini = { id: "a1m", type: "bambu", brand: "bambu", model: "A1 mini" };
const bilinmeyen = { id: "x", type: "moonraker", brand: "elegoo", model: null };
const bilinmeyen2 = { id: "y", type: "moonraker", brand: "elegoo", model: "" };

describe("yazıcı ailesi", () => {
  it("aynı marka + model (büyük/küçük harf ve boşluk farkı önemsiz) aynı aile", () => {
    expect(sameFamily(alt, ust)).toBe(true);
    expect(printerFamilyKey(alt)).toBe(printerFamilyKey(ust));
  });

  it("farklı model aynı aile DEĞİL (A1 ile A1 mini ayrı dosya ister)", () => {
    expect(sameFamily(bambu, mini)).toBe(false);
    expect(sameFamily(alt, bambu)).toBe(false);
  });

  it("modeli girilmemiş yazıcı yalnız kendisiyle eşleşir", () => {
    expect(sameFamily(bilinmeyen, bilinmeyen2)).toBe(false);
    expect(sameFamily(bilinmeyen, bilinmeyen)).toBe(true);
  });

  it("aile üyeleri: kendisi ilk sırada, kardeşleri arkasında", () => {
    expect(familyMemberIds([alt, bambu, ust], "u1-ust")).toEqual(["u1-ust", "u1-alt"]);
    expect(familyMemberIds([alt, bambu, ust], "a1")).toEqual(["a1"]);
    expect(familyMemberIds([alt], "silinmis")).toEqual(["silinmis"]);
  });

  it("aynı içerik farklı yazıcılara yüklense de aynı anahtarı alır", () => {
    expect(fileContentKey({ contentMd5: "abc", originalName: "x.gcode", r2Key: "models/1.gcode" }))
      .toBe(fileContentKey({ contentMd5: "abc", originalName: "y.gcode", r2Key: "models/2.gcode" }));
    expect(fileContentKey({ originalName: "Ejderha.gcode", sizeBytes: 10 }))
      .toBe(fileContentKey({ originalName: "ejderha.gcode ", sizeBytes: 10 }));
    expect(fileContentKey({ originalName: "Ejderha.gcode", sizeBytes: 10 }))
      .not.toBe(fileContentKey({ originalName: "Ejderha.gcode", sizeBytes: 11 }));
  });
});

describe("tekrar ayıklama", () => {
  it("özeti olan ve olmayan iki kopya aynı dosya sayılır; ilk görülen kalır", async () => {
    const { dedupeFiles } = await import("./printer-family");
    const kalan = dedupeFiles([
      { id: 1, originalName: "Blinker.gcode", sizeBytes: 350, contentMd5: "abc" },
      { id: 2, originalName: "Blinker.gcode", sizeBytes: 350, contentMd5: null },
      { id: 3, originalName: "Bumper.gcode", sizeBytes: 900, contentMd5: null },
    ]);
    expect(kalan.map((d) => d.id)).toEqual([1, 3]);
  });
});

describe("kopya bulucu", () => {
  const yazicilar = [
    { id: "u1-alt", type: "moonraker", brand: "snapmaker", model: "U1" },
    { id: "u1-ust", type: "moonraker", brand: "snapmaker", model: "U1" },
    { id: "a1", type: "bambu", brand: "bambu", model: "A1" },
  ];
  const satir = (over: Record<string, unknown>) => ({
    productId: "__custom__", label: null, sizeBytes: 100, contentMd5: null, createdAt: "2026-09-01T00:00:00Z",
    originalName: "Blinker.gcode", printerConfigId: "u1-alt", ...over,
  }) as { id: string; productId: string; printerConfigId: string; originalName: string; sizeBytes: number; contentMd5: string | null; createdAt: string; label: string | null; meshR2Key?: string | null };

  it("iki U1'e ayrı yüklenen aynı dosya kopya sayılır; özetli olan kalır", async () => {
    const { findDuplicateFiles } = await import("./printer-family");
    const { tutulan, fazla } = findDuplicateFiles(
      [satir({ id: "1" }), satir({ id: "2", printerConfigId: "u1-ust", contentMd5: "abc" })],
      yazicilar,
    );
    expect(tutulan.map((s) => s.id)).toEqual(["2"]);
    expect(fazla.map((s) => s.id)).toEqual(["1"]);
  });

  it("farklı AİLEDEKİ aynı ad + boyut kopya DEĞİL (Bambu dosyası U1 dosyası değildir)", async () => {
    const { findDuplicateFiles } = await import("./printer-family");
    const { fazla } = findDuplicateFiles([satir({ id: "1" }), satir({ id: "2", printerConfigId: "a1" })], yazicilar);
    expect(fazla).toEqual([]);
  });

  it("farklı ürün ya da farklı parça adı kopya DEĞİL", async () => {
    const { findDuplicateFiles } = await import("./printer-family");
    const { fazla } = findDuplicateFiles(
      [
        satir({ id: "1", productId: "p1" }),
        satir({ id: "2", productId: "p2" }),
        satir({ id: "3", productId: "p1", label: "Kapak" }),
      ],
      yazicilar,
    );
    expect(fazla).toEqual([]);
  });

  it("aynı yazıcıya iki kez yüklenen dosyada en yeni kalır", async () => {
    const { findDuplicateFiles } = await import("./printer-family");
    const { tutulan, fazla } = findDuplicateFiles(
      [satir({ id: "eski", createdAt: "2026-09-01T00:00:00Z" }), satir({ id: "yeni", createdAt: "2026-09-20T00:00:00Z" })],
      yazicilar,
    );
    expect(tutulan.map((s) => s.id)).toEqual(["yeni"]);
    expect(fazla.map((s) => s.id)).toEqual(["eski"]);
  });
});
