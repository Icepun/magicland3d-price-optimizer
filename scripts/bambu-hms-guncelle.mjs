// Bambu Lab'ın RESMİ uyarı/hata kodu açıklamalarını (Türkçe) indirip uygulamaya gömülen
// sözlüğü yeniden üretir:  node scripts/bambu-hms-guncelle.mjs
//
// Kaynak: Bambu Studio'nun kullandığı uç — https://e.bambulab.com/query.php?lang=tr[&d=<seri öneki>]
//   device_hms   → HMS uyarıları (16 haneli kod, yazıcının `print.hms[]` girişleri)
//   device_error → baskı hata kodları (8 haneli, `print.print_error`)
// `d` verilmezse genel liste gelir (X/P serisi); AMS lite gibi modele özel kodlar yalnız modelin
// listesinde var. Model = seri numarasının ilk 3 hanesi (A1: 039, A2L: 26A).
//
// Çıktı: src/core/printers/bambu-hms-tr.json
//   { surum, hms, err, modelHms: {<önek>: {…}}, modelErr: {…} }
//   `hms`/`err` = bütün kaynakların birleşimi; `model*` = o modelde metni FARKLI olan kodlar.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODELLER = ["039", "26A"]; // yeni Bambu modeli eklenince seri önekini buraya yaz
const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEDEF = path.join(KOK, "src/core/printers/bambu-hms-tr.json");

async function liste(onek) {
  const url = `https://e.bambulab.com/query.php?lang=tr${onek ? `&d=${onek}` : ""}`;
  const yanit = await fetch(url);
  if (!yanit.ok) throw new Error(`${url} → HTTP ${yanit.status}`);
  const govde = await yanit.json();
  if (govde?.result !== 0 || !govde.data) throw new Error(`${url} → beklenmeyen yanıt`);
  const cevir = (tur) =>
    new Map(
      (govde.data[tur]?.tr ?? [])
        .map((x) => [String(x.ecode ?? "").toUpperCase(), String(x.intro ?? "").replace(/\s+/g, " ").trim()])
        .filter(([kod, metin]) => /^[0-9A-F]+$/.test(kod) && metin)
    );
  return { surum: String(govde.data.device_hms?.ver ?? ""), hms: cevir("device_hms"), err: cevir("device_error") };
}

const genel = await liste(null);
const modeller = Object.fromEntries(await Promise.all(MODELLER.map(async (m) => [m, await liste(m)])));

function birlestir(tur) {
  const taban = new Map(genel[tur]);
  // Genelde olmayan kodlar: ilk gören modelin metni tabana girer.
  for (const m of MODELLER) for (const [kod, metin] of modeller[m][tur]) if (!taban.has(kod)) taban.set(kod, metin);
  // Modelde metni tabandan FARKLI olanlar o modelin üstüne yazması olarak saklanır.
  const ust = {};
  for (const m of MODELLER) {
    const fark = [...modeller[m][tur]].filter(([kod, metin]) => taban.get(kod) !== metin);
    if (fark.length) ust[m] = Object.fromEntries(fark.sort(([a], [b]) => a.localeCompare(b)));
  }
  return { taban: Object.fromEntries([...taban].sort(([a], [b]) => a.localeCompare(b))), ust };
}

const hms = birlestir("hms");
const err = birlestir("err");
const cikti = {
  surum: [genel.surum, ...MODELLER.map((m) => modeller[m].surum)].sort().at(-1),
  hms: hms.taban,
  err: err.taban,
  modelHms: hms.ust,
  modelErr: err.ust,
};
if (Object.keys(cikti.hms).length < 1500 || Object.keys(cikti.err).length < 300) {
  throw new Error("Liste beklenenden çok küçük — dosya YAZILMADI (uç değişmiş olabilir).");
}
fs.writeFileSync(HEDEF, `${JSON.stringify(cikti)}\n`);
console.log(
  `yazıldı: ${path.relative(KOK, HEDEF)} — sürüm ${cikti.surum}, ${Object.keys(cikti.hms).length} uyarı, ` +
    `${Object.keys(cikti.err).length} hata kodu, ${(fs.statSync(HEDEF).size / 1024).toFixed(0)} KB`
);
