/**
 * Modeller denetimi (23 Kas 2026) — ailedeki ikiz kopyalar ve "silmeden bayatla" önbelleği.
 */
import { describe, expect, it } from "vitest";
import { aileIkizleri } from "./models-view";
import { swr, swrBayatla } from "@/lib/route-cache";

const yazicilar = [
  { id: "u1", type: "moonraker", brand: "snapmaker", model: "U1" },
  { id: "u2", type: "moonraker", brand: "snapmaker", model: "U1" },
  { id: "a1", type: "bambu", brand: "bambu", model: "A1" },
];
const dosya = (id: string, printerConfigId: string, ek: Partial<{ originalName: string; sizeBytes: number; contentMd5: string | null }> = {}) => ({
  id, printerConfigId, originalName: "kol.gcode", sizeBytes: 1000, contentMd5: null as string | null, ...ek,
});

describe("aileIkizleri", () => {
  it("aynı içerik ailenin öbür yazıcısında → ikiz; başka aile ya da başka içerik → değil", () => {
    const hedef = dosya("a", "u1", { contentMd5: "m1" });
    const liste = [
      hedef,
      dosya("ikiz", "u2", { contentMd5: "m1" }),
      dosya("baskaAile", "a1", { contentMd5: "m1" }),
      dosya("baskaIcerik", "u2", { contentMd5: "m2", originalName: "diger.gcode" }),
    ];
    expect(aileIkizleri(liste, hedef, yazicilar).map((f) => f.id)).toEqual(["ikiz"]);
  });

  it("imzasız dosyada ad + boyut eşleşmesi ikiz sayılır", () => {
    const hedef = dosya("a", "u1");
    const liste = [hedef, dosya("b", "u2"), dosya("c", "u2", { sizeBytes: 999 })];
    expect(aileIkizleri(liste, hedef, yazicilar).map((f) => f.id)).toEqual(["b"]);
  });
});

describe("swrBayatla", () => {
  it("kayıt silinmez: eldeki gövde HEMEN döner, arkada yenisi hesaplanır", async () => {
    let surum = 1;
    const hesap = async () => ({ surum: surum });
    const anahtar = `test-bayatla:${Math.random()}`;
    expect(await swr(anahtar, 60_000, hesap)).toEqual({ surum: 1 });
    surum = 2;
    // Taze kayıt → yeni hesap yok.
    expect(await swr(anahtar, 60_000, hesap)).toEqual({ surum: 1 });
    swrBayatla(anahtar);
    // Bayatlandı → eski gövde anında döner (soğuk hesap beklenmez)...
    expect(await swr(anahtar, 60_000, hesap)).toEqual({ surum: 1 });
    // ...ve arkada başlayan hesap bitince yenisi gelir.
    await new Promise((r) => setTimeout(r, 10));
    expect(await swr(anahtar, 60_000, hesap)).toEqual({ surum: 2 });
  });
});
