/**
 * KAMERA AKTARICISI — saf yardımcılar ve yapısal güvenceler.
 *
 * Kamera modüllerinin ana kuralı: kamera YALNIZ biri izlerken açık, dosya aktarılırken hiç
 * açılmaz (U1 aktarım sırasında ağdan düşüyordu), iki izleyici yazıcıya iki bağlantı açmaz.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { denemeSerbestMi, kareAnahtari, silinecekKareler, TUTULAN_KARE } from "./camera-relay";

const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("kare anahtarları", () => {
  it("yazıcı başına klasör + zaman damgası; tehlikeli karakter temizlenir", () => {
    expect(kareAnahtari("cmf123", 1_790_000_000_000)).toBe("camera/cmf123/1790000000000.jpg");
    expect(kareAnahtari("../x/y", 5)).toBe("camera/___x_y/5.jpg");
  });

  it("R2'de yalnız son birkaç kare tutulur", () => {
    const k = ["a", "b", "c", "d", "e"];
    expect(silinecekKareler(k)).toEqual(k.slice(0, k.length - TUTULAN_KARE));
    expect(silinecekKareler(["a"])).toEqual([]);
  });
});

describe("hata sonrası yeniden deneme", () => {
  it("telefon hatayı sildiyse beklemeden dener; silmediyse bekleme dolunca", () => {
    expect(denemeSerbestMi(null, 10_000, 5_000)).toBe(true);
    expect(denemeSerbestMi("Kamera yok", 10_000, 5_000)).toBe(false);
    expect(denemeSerbestMi("Kamera yok", 10_000, 10_000)).toBe(true);
    expect(denemeSerbestMi("Kamera yok", undefined, 5_000)).toBe(true);
  });
});

describe("yapısal güvenceler", () => {
  const kaynak = oku("src/core/printers/camera-relay.ts");

  it("dosya aktarılırken kamera açılmaz, açıksa kapanır", () => {
    expect(kaynak.match(/aktarimSuruyor\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("kameraya yayın merkezinden abone olunur (yazıcıya ikinci bağlantı yok)", () => {
    expect(kaynak).toContain("kameraAbone(");
    // Kamera akışı yalnız yayın merkezine verilen KAYNAK içinde açılır, doğrudan tutulmaz.
    expect(kaynak).toContain("return (onKare, onHata) => bambuKameraAkisi(");
    expect(kaynak).not.toMatch(/=\s*bambuKameraAkisi\(/);
  });

  it("masaüstü kamera penceresi de yayın merkezini kullanıyor", () => {
    const rota = oku("src/app/api/printers/[id]/camera/route.ts");
    expect(rota).toContain("kameraAbone(");
    expect(rota).not.toContain("kamera.durdur()");
  });

  it("relay kamera döngüsünü başlatıyor ve yeteneği bildiriyor", () => {
    const relay = oku("src/core/printers/relay.ts");
    expect(relay).toContain("startKameraAktarici(");
    expect(relay).toMatch(/RELAY_CAPS = "[^"]*camera/);
  });

  it("şema: tablo ve kolon runtime-schema'da, sürüm artırıldı", () => {
    const sema = oku("src/lib/runtime-schema.ts");
    expect(sema).toContain('CREATE TABLE IF NOT EXISTS "PrinterCamera"');
    expect(sema).toContain('ensureColumn("PrinterSnapshot", "detail", "TEXT")');
    expect(sema).toMatch(/const CURRENT_SCHEMA_VERSION = "(\d+)"/);
    expect(Number(/const CURRENT_SCHEMA_VERSION = "(\d+)"/.exec(sema)![1])).toBeGreaterThanOrEqual(48);
    const prisma = oku("prisma/schema.prisma");
    expect(prisma).toContain("model PrinterCamera {");
    expect(prisma).toMatch(/detail\s+String\?/);
  });
});
