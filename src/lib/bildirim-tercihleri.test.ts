import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { masaustuKapaliOku, masaustuKapaliYaz, masaustundeKapali } from "./bildirim-tercihleri";

/** Masaüstü tercihi yerel dosyada — her bilgisayar kendi kararını verir. */
describe("bu bilgisayarın bildirim tercihi", () => {
  let klasor: string;
  const onceki = process.env.TURSO_SETTINGS_FILE;

  beforeEach(() => {
    klasor = fs.mkdtempSync(path.join(os.tmpdir(), "mlhub-bildirim-"));
    // getUserDataDir ayar dosyasının klasörünü kullanıyor.
    process.env.TURSO_SETTINGS_FILE = path.join(klasor, "turso-settings.json");
  });

  afterEach(() => {
    if (onceki === undefined) delete process.env.TURSO_SETTINGS_FILE;
    else process.env.TURSO_SETTINGS_FILE = onceki;
    fs.rmSync(klasor, { recursive: true, force: true });
  });

  it("dosya yokken her şey açık", () => {
    expect(masaustuKapaliOku()).toEqual([]);
  });

  it("yazılan liste temizlenip geri okunur", () => {
    expect(masaustuKapaliYaz(["stok", "uydurma", "stok", "baski-bitti"])).toEqual(["baski-bitti", "stok"]);
    expect(masaustuKapaliOku()).toEqual(["baski-bitti", "stok"]);
    // Geçici dosya arkada kalmaz.
    expect(fs.readdirSync(klasor)).toEqual(["bildirim-tercihleri.json"]);
  });

  it("bozuk dosya uygulamayı düşürmez — hepsi açık sayılır", () => {
    fs.writeFileSync(path.join(klasor, "bildirim-tercihleri.json"), "{yarım");
    expect(masaustuKapaliOku()).toEqual([]);
  });

  it("zildeki uyarı kapatılan türe aitse süzülür", () => {
    expect(masaustundeKapali({ id: "printer-done:p1:1", type: "printer" }, ["baski-bitti"])).toBe(true);
    expect(masaustundeKapali({ id: "order-new:shopify:1124", type: "order" }, ["baski-bitti"])).toBe(false);
    expect(masaustundeKapali({ id: "stock-p1", type: "stock" }, [])).toBe(false);
    expect(masaustundeKapali({ id: "bilinmeyen", type: "order-x" }, ["stok"])).toBe(false);
  });
});
