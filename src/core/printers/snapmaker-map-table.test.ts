/**
 * Snapmaker U1 renk/kafa eşleme tablosu — YANLIŞ RENKLE BASMA gerilemesinin koruması.
 *
 * Kullanıcı 4 renkli bir baskıda doğru kafaları seçmesine rağmen yazıcı yanlış renklerle bastı.
 * Sahadan (yazıcının kendi komut geçmişinden) alınan kanıt, aynı dosya için:
 *
 *   bizim eski çıktı  : MAP_TABLE="[[0, 0], [1, 2], [2, 2], [3, 3]]"
 *   Snapmaker uygul.  : MAP_TABLE="[[0, 0], [1, 2], [3, 3], [4, 1]]"
 *
 * Proje 5 filament tanımlıyordu (NOZZLE_TEMP 5 değerli) ve model 0/1/3/4 numaralı mantıksal
 * araçları kullanıyordu. Eski kod sabit `[0,1,2,3]` döngüsüyle tablo ürettiği için MANTIKSAL 4
 * hiç yazılmıyordu → kullanıcının o renk için seçtiği kafa sessizce düşüyor, firmware
 * varsayılanda kalıyor ve o renk yanlış kafadan basılıyordu.
 *
 * Firmware tarafı (u1-klipper): `extruder_map_table[mantıksal] = fiziksel`, ardından
 * `self.extruder_gcode_id = f"T{mapped_value}"`. Yani tabloda olmayan mantıksal araç
 * eşlenmeden geçer.
 */
import { describe, expect, it } from "vitest";
import { buildSnapmakerMapTable } from "./moonraker";

describe("Snapmaker MAP_TABLE", () => {
  it("mantıksal 4 ve üstünü DÜŞÜRMEZ (asıl gerileme)", () => {
    // Sahadaki gerçek durum: kullanılan araçlar 0/1/3/4, kullanıcı seçimi 0→0, 1→2, 3→3, 4→1.
    const table = buildSnapmakerMapTable({ 0: 0, 1: 2, 3: 3, 4: 1 });

    expect(table).toContain("[4, 1]");
    expect(table).toContain("[3, 3]");
    expect(table).toContain("[1, 2]");
    expect(table).toContain("[0, 0]");
  });

  it("eşlemesi olmayan 0-3 için kimlik yazar (bayat tabloyu ezmek için)", () => {
    // Kullanılmayan mantıksal 2 tabloya kimlik olarak girer; firmware'de ekrandan set edilmiş
    // eski bir eşleme kalmışsa bu baskıyı etkileyemesin.
    expect(buildSnapmakerMapTable({ 0: 0, 1: 2, 3: 3, 4: 1 })).toContain("[2, 2]");
  });

  it("3'ün üstünde KİMLİK YAZMAZ — fiziksel kafa 0-3 ile sınırlı", () => {
    // Mantıksal 6 eşlenmişse 4 ve 5 için uydurma `[4, 4]` / `[5, 5]` hedefi üretilmemeli.
    const table = buildSnapmakerMapTable({ 0: 1, 6: 2 });

    expect(table).toContain("[6, 2]");
    expect(table).not.toContain("[4, 4]");
    expect(table).not.toContain("[5, 5]");
  });

  it("eşleme yoksa dört kafanın kimlik tablosunu verir", () => {
    expect(buildSnapmakerMapTable(undefined)).toBe("[0, 0], [1, 1], [2, 2], [3, 3]");
    expect(buildSnapmakerMapTable({})).toBe("[0, 0], [1, 1], [2, 2], [3, 3]");
  });

  it("çiftler mantıksal indekse göre artan sırada yazılır", () => {
    const table = buildSnapmakerMapTable({ 4: 1, 0: 0, 3: 3, 1: 2 });
    expect(table).toBe("[0, 0], [1, 2], [2, 2], [3, 3], [4, 1]");
  });

  it("üreticinin gönderdiği eşlemeyi bire bir üretebilir", () => {
    // Snapmaker'ın kendi uygulamasının aynı dosya için gönderdiği tablo — kullanılmayan 2 hariç
    // her mantıksal araç yerinde. Bizimki 2'yi kimlikle doldurur (zararsız, firmware zaten
    // kullanılmayan aracı hiç çağırmaz), asıl olan 4'ün DÜŞMEMESİ.
    const bizim = buildSnapmakerMapTable({ 0: 0, 1: 2, 3: 3, 4: 1 });
    for (const cift of ["[0, 0]", "[1, 2]", "[3, 3]", "[4, 1]"]) {
      expect(bizim).toContain(cift);
    }
  });
});
