import { describe, expect, it } from "vitest";
import { etiketYazicisiSec } from "./yazici-secimi";

const BU_PC = ["Xprinter XP-490B", "Microsoft Print to PDF", "HPCB9AC6 (HP Smart Tank 510 series)"];

describe("etiket yazıcısı seçimi", () => {
  it("seçim yokken adından etiket yazıcısını bulur (ofis yazıcısını değil)", () => {
    expect(etiketYazicisiSec(BU_PC, null)).toEqual({ yazici: "Xprinter XP-490B", elleSecildi: false });
  });

  it("kullanıcının seçimi listede oldukça ona uyar", () => {
    expect(etiketYazicisiSec(BU_PC, "Microsoft Print to PDF")).toEqual({
      yazici: "Microsoft Print to PDF",
      elleSecildi: true,
    });
  });

  it("seçilen yazıcı kaldırıldıysa tahmine döner", () => {
    expect(etiketYazicisiSec(BU_PC, "Eski Zebra")).toEqual({ yazici: "Xprinter XP-490B", elleSecildi: false });
  });

  it("etiket yazıcısı yoksa tahminle ofis yazıcısına GÖNDERMEZ", () => {
    expect(etiketYazicisiSec(["HP LaserJet", "Microsoft Print to PDF"], null)).toEqual({
      yazici: null,
      elleSecildi: false,
    });
  });
});
