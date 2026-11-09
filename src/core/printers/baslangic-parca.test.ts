/**
 * BASKI BAŞLARKEN PARÇA İPTALİ — "bu parçaları hiç basma".
 *
 * Parça listesi baskıdan ÖNCE dosyadan çıkarılır, iptal ise baskı başlayınca yazıcıya gider.
 * İkisinin aynı adı konuşması şart; yanlış eşleşme yanlış parçanın basılmaması demek. Burada:
 *   1. Dosyadaki tanımlar doğru okunur (tırnaklı ad, poligon, yorum satırı, tekrar).
 *   2. U1'de: parça listesi yazıcıda belirene kadar beklenir, ad harf duyarsız eşlenir ve komuta
 *      YAZICININ yazımı gider; bulunamayan parça raporlanır (baskı durmaz, kullanıcı uyarılır).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { excludeTanimlariniOku } from "./exclude-object";
import { clearMoonrakerCaps, clearMoonrakerPort, moonrakerBaslangictaAtla } from "./moonraker";

describe("dosyadaki parça tanımları", () => {
  it("U1 dosyasındaki gerçek biçimi okur: ad, merkez, poligon", () => {
    const metin = [
      "; EXECUTABLE_BLOCK_START",
      "EXCLUDE_OBJECT_DEFINE NAME=sauron_cloak_low.stl_id_0_copy_0 CENTER=135.5,135.993 POLYGON=[[64.2,215.8],[64.5,206.8],[89,92.2],[126.5,16.7]]",
      "EXCLUDE_OBJECT_DEFINE NAME=base_id_1_copy_0 CENTER=40,40 POLYGON=[[30,30],[50,30],[50,50],[30,50]]",
      "",
      "PRINT_START",
    ].join("\n");
    const t = excludeTanimlariniOku(metin);
    expect(t.map((x) => x.name)).toEqual(["sauron_cloak_low.stl_id_0_copy_0", "base_id_1_copy_0"]);
    expect(t[0].center).toEqual([135.5, 135.993]);
    expect(t[0].polygon[0]).toEqual([64.2, 215.8]);
    expect(t[1].polygon).toHaveLength(4);
  });

  it("tırnaklı adı kaçışlarıyla çözer (boşluklu / tırnaklı adlar böyle yazılıyor)", () => {
    const t = excludeTanimlariniOku(
      'EXCLUDE_OBJECT_DEFINE NAME="Max\'s \\"Shroud\\" 2" CENTER=10,20 POLYGON=[[5,15],[15,15],[15,25],[5,25]]',
    );
    expect(t[0].name).toBe('Max\'s "Shroud" 2');
  });

  it("yorumun içindeki geçiş komut sayılmaz; aynı parça iki kez listelenmez", () => {
    const t = excludeTanimlariniOku([
      "; EXCLUDE_OBJECT_DEFINE NAME=yorum CENTER=1,1",
      "EXCLUDE_OBJECT_DEFINE NAME=Parca CENTER=10,10 POLYGON=[[9,9],[11,9],[11,11],[9,11]]",
      "EXCLUDE_OBJECT_DEFINE NAME=PARCA CENTER=10,10 POLYGON=[[9,9],[11,9],[11,11],[9,11]]",
    ].join("\n"));
    expect(t.map((x) => x.name)).toEqual(["Parca"]);
  });

  it("poligonu olmayan parçaya merkezin çevresinde kare çizer; merkezi de yoksa atlar", () => {
    const t = excludeTanimlariniOku([
      "EXCLUDE_OBJECT_DEFINE NAME=sadece_merkez CENTER=100,50",
      "EXCLUDE_OBJECT_DEFINE NAME=hicbir_sey",
    ].join("\n"));
    expect(t).toHaveLength(1);
    expect(t[0].polygon).toEqual([[95, 45], [105, 45], [105, 55], [95, 55]]);
  });

  it("tanım yoksa boş liste", () => {
    expect(excludeTanimlariniOku("G28\nG1 X10\n; printing object kup\n")).toEqual([]);
  });
});

/* ── U1: baskı başlayınca atlama (sahte Moonraker) ─────────────────────────── */

interface Sahte {
  /** Kaçıncı sorguda parça listesi belirsin (yazıcı dosyanın başını okuyana dek boş). */
  listeSorgusu: number;
  objects: string[];
  excluded: string[];
  scriptler: string[];
  sorgu: number;
}
let s: Sahte;

beforeEach(() => {
  vi.useFakeTimers();
  clearMoonrakerPort();
  clearMoonrakerCaps();
  s = { listeSorgusu: 3, objects: ["KUP_ID_0_COPY_0", "SILINDIR_ID_1_COPY_0", "ÇIÇEK_ID_2"], excluded: [], scriptler: [], sorgu: 0 };
  const json = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname === "/printer/objects/query" && u.search.includes("exclude_object")) {
      s.sorgu++;
      const gorunur = s.sorgu >= s.listeSorgusu;
      return json({ result: { status: { exclude_object: {
        objects: gorunur ? s.objects.map((name) => ({ name })) : [],
        excluded_objects: s.excluded,
      } } } });
    }
    if (u.pathname === "/printer/objects/query") {
      return json({ result: { status: { print_stats: { state: "printing" } } } });
    }
    if (u.pathname === "/printer/gcode/script") {
      const script = typeof init?.body === "string" ? (JSON.parse(init.body) as { script: string }).script : "";
      s.scriptler.push(script);
      const m = /^EXCLUDE_OBJECT NAME=(.+)$/.exec(script);
      if (m) s.excluded.push(m[1].replace(/^"|"$/g, "").toUpperCase());
      return json({ result: "ok" });
    }
    return json({ result: {} });
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function bitir<T>(p: Promise<T>): Promise<T> {
  let sonuc: T | undefined;
  let bitti = false;
  void p.then((r) => { sonuc = r; bitti = true; });
  for (let i = 0; i < 200 && !bitti; i++) await vi.advanceTimersByTimeAsync(500);
  if (!bitti) throw new Error("bitmedi");
  return sonuc as T;
}

describe("U1'de baskı başlayınca seçilen parçalar atlanır", () => {
  it("liste yazıcıda belirene kadar bekler, sonra dosyadaki (küçük harfli) adla eşleyip iptal eder", async () => {
    const r = await bitir(moonrakerBaslangictaAtla("10.0.0.9", 7125, ["kup_id_0_copy_0"]));
    expect(r).toEqual({ atlanan: ["kup_id_0_copy_0"], bulunamayan: [] });
    // Komuta yazıcının KENDİ yazımı gider.
    expect(s.scriptler).toContain("EXCLUDE_OBJECT NAME=KUP_ID_0_COPY_0");
    expect(s.sorgu).toBeGreaterThanOrEqual(3);
  });

  it("birden çok parça; Türkçe karakterli ad da eşleşir", async () => {
    const r = await bitir(moonrakerBaslangictaAtla("10.0.0.9", 7125, ["silindir_id_1_copy_0", "çiçek_id_2"]));
    expect(r.bulunamayan).toEqual([]);
    expect(r.atlanan).toHaveLength(2);
    expect(s.excluded).toEqual(expect.arrayContaining(["SILINDIR_ID_1_COPY_0", "ÇIÇEK_ID_2"]));
  });

  it("yazıcıda olmayan parça raporlanır, diğerleri yine iptal edilir", async () => {
    const r = await bitir(moonrakerBaslangictaAtla("10.0.0.9", 7125, ["kup_id_0_copy_0", "yok_boyle_parca"], { azamiMs: 6000 }));
    expect(r.atlanan).toEqual(["kup_id_0_copy_0"]);
    expect(r.bulunamayan).toEqual(["yok_boyle_parca"]);
  });

  it("liste hiç belirmezse hiçbir komut gönderilmez, hepsi raporlanır", async () => {
    s.listeSorgusu = Number.POSITIVE_INFINITY;
    const r = await bitir(moonrakerBaslangictaAtla("10.0.0.9", 7125, ["kup_id_0_copy_0"], { azamiMs: 5000 }));
    expect(r).toEqual({ atlanan: [], bulunamayan: ["kup_id_0_copy_0"] });
    expect(s.scriptler).toEqual([]);
  });
});
