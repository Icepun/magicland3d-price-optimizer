/**
 * MAKARA ETİKETİ — kendi makaralarımızdaki boş NFC etiketiyle otomatik tanıma (U1, Extended Firmware).
 *
 * Örnekler canlı yazıcıdan (U1 Üst, 10 Kas 2026): Snapmaker'ın etiketi kanal 3'te, diğerleri boş
 * (`CARD_UID: 0`). Boş etiketin şekli firmware belgesinden (docs/design/filament_detect.md):
 * yalnız `CARD_UID` + `CARD_TYPE`, `OFFICIAL: false`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  etiketDurumu, etiketKarari, filamentDetectBilgisi, filamentDetectEtiketleri, kayitlariCoz, uidCoz,
  type KanalEtiketi, type MakaraEtiketKaydi,
} from "./makara-etiketi";

const bos = { VENDOR: "NONE", MAIN_TYPE: "NONE", SUB_TYPE: "NONE", RGB_1: 0xffffff, OFFICIAL: false, CARD_UID: 0 };
const snapmaker = { VENDOR: "Snapmaker", MAIN_TYPE: "PLA", SUB_TYPE: "SnapSpeed", RGB_1: 0xe2dedb, OFFICIAL: true, CARD_UID: [176, 135, 104, 106] };
const bosEtiket = { ...bos, CARD_UID: [4, 161, 178, 195, 212, 229, 128], CARD_TYPE: "NTAG" };

describe("etiketin yazıcıdaki hâli", () => {
  it("etiket yoksa (0 / boş / sıfırlar) kanal listeye girmez", () => {
    expect(uidCoz(0)).toBeNull();
    expect(uidCoz([])).toBeNull();
    expect(uidCoz([0, 0, 0, 0])).toBeNull();
    expect(uidCoz([1, 300])).toBeNull();
    expect(filamentDetectEtiketleri({ info: [bos, bos, bos, bos] })).toEqual([]);
    expect(filamentDetectEtiketleri(undefined)).toEqual([]);
  });

  it("Snapmaker etiketi ve boş etiket ayrı çözülür", () => {
    const [b, s] = filamentDetectEtiketleri({ info: [bos, bosEtiket, bos, snapmaker] });
    expect(b).toMatchObject({ kanal: 1, uid: "04A1B2C3D4E580", tur: "NTAG", bilgili: false, renk: null, tip: null });
    expect(s).toMatchObject({ kanal: 3, uid: "B087686A", bilgili: true, satici: "Snapmaker", renk: "E2DEDB", tip: "PLA" });
  });
});

const etiket = (o: Partial<KanalEtiketi> = {}): KanalEtiketi => ({
  kanal: 1, uid: "04A1B2C3D4E580", uidBaytlari: [4, 161, 178, 195, 212, 229, 128], tur: "NTAG",
  bilgili: false, satici: null, renk: null, tip: null, ...o,
});
const kayit: MakaraEtiketKaydi = { renk: "E72F1D", tip: "PLA", guncellendi: "2026-11-10T10:00:00.000Z" };

describe("karar", () => {
  it("tanınmayan boş etiket → yeni (kullanıcı bir kez tanıtır)", () => {
    expect(etiketKarari(etiket(), undefined)).toEqual({ tur: "yeni" });
    expect(etiketDurumu({ tur: "yeni" })).toBe("yeni");
  });

  it("tanımlı etiket yeni takıldı → uygula; yazıcıda zaten doğruysa → güncel", () => {
    expect(etiketKarari(etiket(), kayit)).toEqual({ tur: "uygula", kayit });
    expect(etiketKarari(etiket({ bilgili: true, satici: "Generic", renk: "E72F1D", tip: "PLA" }), kayit)).toEqual({ tur: "guncel" });
    // Kayıt değişti (makara başka renkle dolduruldu) → yeniden uygula.
    expect(etiketKarari(etiket({ bilgili: true, satici: "Generic", renk: "000000", tip: "PLA" }), kayit).tur).toBe("uygula");
    expect(etiketDurumu({ tur: "guncel" })).toBe("tanimli");
  });

  it("Snapmaker'ın etiketi ya da kendi bilgisini taşıyan etiket asla ezilmez", () => {
    const s = etiket({ bilgili: true, satici: "Snapmaker", renk: "E2DEDB", tip: "PLA" });
    expect(etiketKarari(s, undefined)).toEqual({ tur: "kendi" });
    expect(etiketKarari(s, kayit)).toEqual({ tur: "kendi" });
    expect(etiketKarari(etiket({ bilgili: true, satici: "Elegoo", renk: "112233", tip: "PETG" }), undefined)).toEqual({ tur: "kendi" });
    expect(etiketDurumu({ tur: "kendi" })).toBeNull();
  });
});

describe("yazıcıya giden bilgi", () => {
  it("yalnız firmware'in kabul ettiği alanlar; etiket kimliği aynen geri verilir", () => {
    expect(filamentDetectBilgisi(etiket(), kayit)).toEqual({
      VENDOR: "Generic", MAIN_TYPE: "PLA", SUB_TYPE: "Basic", RGB_1: 0xe72f1d, ALPHA: 255,
      HOTEND_MIN_TEMP: 190, HOTEND_MAX_TEMP: 230,
      CARD_UID: [4, 161, 178, 195, 212, 229, 128], CARD_TYPE: "NTAG",
    });
  });

  it("profili olmayan tür ana türün sıcaklıklarını alır (PETG-CF → PETG)", () => {
    const b = filamentDetectBilgisi(etiket({ tur: null }), { ...kayit, tip: "PETG-CF" });
    expect(b).toMatchObject({ MAIN_TYPE: "PETG-CF", HOTEND_MIN_TEMP: 220, HOTEND_MAX_TEMP: 260 });
    expect(b).not.toHaveProperty("CARD_TYPE");
  });
});

describe("kayıt deposu", () => {
  it("bozuk girdi atlanır, geçerli olan kalır", () => {
    const ham = JSON.stringify({
      "04A1B2C3D4E580": { renk: "e72f1d", tip: "PLA", guncellendi: "x" },
      KOTU: { renk: "E72F1D", tip: "PLA" },
      B087686A: { renk: "ZZZ", tip: "PLA" },
      "11223344": { renk: "112233" },
    });
    expect(kayitlariCoz(ham)).toEqual({ "04A1B2C3D4E580": { renk: "E72F1D", tip: "PLA", guncellendi: "x" } });
    expect(kayitlariCoz("{bozuk")).toEqual({});
    expect(kayitlariCoz(null)).toEqual({});
  });
});

/* ── Otomatik uygulayıcı ───────────────────────────────────────────────────── */

const db = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSetting: {
      findUnique: vi.fn(async () => (db.value == null ? null : { key: "printers.makaraEtiketleri", value: db.value })),
      upsert: vi.fn(async ({ create }: { create: { value: string } }) => { db.value = create.value; }),
    },
  },
}));

describe("otomatik uygulayıcı + yazıcıya gönderim", () => {
  let gonderilen: { url: string; govde: unknown }[];
  let yanit: { status: number; body: unknown };

  beforeEach(async () => {
    const { clearMoonrakerPort } = await import("./moonraker");
    const { makaraEtiketiOnbellekSifirla } = await import("./makara-etiketi-izleyici");
    clearMoonrakerPort();
    makaraEtiketiOnbellekSifirla();
    db.value = null;
    gonderilen = [];
    yanit = { status: 200, body: { result: { state: "success" } } };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      // Yalnız yazma isteklerini say (port çözümü vb. okumalar hariç).
      if (init?.method === "POST") gonderilen.push({ url: String(url), govde: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      return { ok: yanit.status < 400, status: yanit.status, json: async () => yanit.body } as unknown as Response;
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("tanıtılan makara takılınca bilgi bir kez gider; baskı sürerken beklenir", async () => {
    const { makaraEtiketiKaydet, makaraEtiketleriniIsle } = await import("./makara-etiketi-izleyici");
    await makaraEtiketiKaydet("04A1B2C3D4E580", { renk: "e72f1d", tip: "PLA" });

    expect(await makaraEtiketleriniIsle("10.0.0.7", 7125, [etiket()], true)).toBe(0);
    expect(gonderilen).toEqual([]);

    expect(await makaraEtiketleriniIsle("10.0.0.7", 7125, [etiket()], false)).toBe(1);
    expect(gonderilen).toHaveLength(1);
    expect(gonderilen[0].url).toBe("http://10.0.0.7:7125/printer/filament_detect/set");
    expect(gonderilen[0].govde).toMatchObject({ channel: 1, info: { MAIN_TYPE: "PLA", RGB_1: 0xe72f1d, CARD_UID: [4, 161, 178, 195, 212, 229, 128] } });

    // Yazıcı yansıtana kadar gelen yoklamalar aynı bilgiyi tekrar göndermez.
    expect(await makaraEtiketleriniIsle("10.0.0.7", 7125, [etiket()], false)).toBe(0);
    // Yansıdıktan sonra zaten güncel.
    const guncel = etiket({ bilgili: true, satici: "Generic", renk: "E72F1D", tip: "PLA" });
    expect(await makaraEtiketleriniIsle("10.0.0.7", 7125, [guncel], false)).toBe(0);
    expect(gonderilen).toHaveLength(1);
  });

  it("tanınmayan ve Snapmaker etiketine hiçbir şey gönderilmez", async () => {
    const { makaraEtiketleriniIsle } = await import("./makara-etiketi-izleyici");
    const s = etiket({ kanal: 3, uid: "B087686A", bilgili: true, satici: "Snapmaker", renk: "E2DEDB", tip: "PLA" });
    expect(await makaraEtiketleriniIsle("10.0.0.8", 7125, [etiket(), s], false)).toBe(0);
    expect(gonderilen).toEqual([]);
  });

  it("stok yazılımda uç yok → anlaşılır hata; firmware reddi de yutulmaz", async () => {
    const { moonrakerEtiketBilgisiYaz } = await import("./moonraker");
    yanit = { status: 404, body: { error: "not found" } };
    await expect(moonrakerEtiketBilgisiYaz("10.0.0.9", 7125, 0, {})).rejects.toThrow(/desteklemiyor/);
    yanit = { status: 200, body: { result: { state: "error", message: "unsupported fields: X" } } };
    await expect(moonrakerEtiketBilgisiYaz("10.0.0.9", 7125, 0, {})).rejects.toThrow(/kaydedilemedi/);
    await expect(moonrakerEtiketBilgisiYaz("10.0.0.9", 7125, 4, {})).rejects.toThrow(/Kafa/);
  });
});
