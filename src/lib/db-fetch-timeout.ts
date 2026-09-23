/**
 * Turso'ya giden HER HTTP isteğine ZAMAN AŞIMI koyar — uygulamanın kilitlenmesinin kök çözümü.
 *
 * ÖLÇÜLEN KİLİT (14 Ağu 2026): uygulamada TÜM veritabanı rotaları 12sn+ yanıtsız kalırken
 * (printers, products, spools, printable-models) AYRI bir süreçten aynı sorgu 340ms sürüyordu.
 * Turso, ağ ve makine sağlıklıydı. Yeniden başlatmak yalnız ~15-20 saniye işe yarıyordu.
 *
 * SEBEP: @libsql/client HTTP istemcisi istekleri 20'lik bir eşzamanlılık havuzundan geçiriyor
 * ve isteğin KENDİSİNDE zaman aşımı yok. Ağ bir kez takılınca (WiFi geçişi, uyku, NAT'ın
 * boştaki soketi düşürmesi) o istek iznini BIRAKMIYOR.
 *
 * ── 20 Ağu 2026 ÖLÇÜMÜ: zaman aşımı TEK BAŞINA yetmiyormuş ──────────────────────────────
 * Kullanıcı "her sayfa 15-20 saniye açılıyor" dedi. Ölçüldü:
 *   • Sayfanın KENDİ sorguları toplam ~1-1,7 sn. Yani sorgu sayısı suçlu DEĞİL.
 *   • Prisma'nın libSQL adaptörü her sorgu için bir mutex alıyor ve istek bitene kadar
 *     tutuyor → tek takılan istek TÜM uygulamayı zaman aşımı süresi kadar durduruyor.
 *     Kuyruktaki sorgular kendi tam sürelerini ayrıca bekliyor: 20/40/60 sn kademeleri.
 *     Ölçülen en uzun donma 36,8 sn.
 *   • Uygulama 18-20 sn takılıyken AYRI bir süreçten aynı sorgu 72-73 ms döndü → veritabanı
 *     ve Turso sağlam; ölen şey uygulamanın kendi soketi.
 *   • Kanarya (288 örnek): p50 83 ms, p90 2.155 ms, p99 9.837 ms.
 *
 * Bu yüzden iki değişiklik BİRLİKTE yapıldı (sıra önemliydi):
 *   1) İptal edilen istek TAZE bağlantıyla BİR KEZ yeniden denenir. Ayrı sürecin 72 ms
 *      alması, yeniden denemenin tutacağının kanıtı.
 *   2) Tavan 20 sn → 6 sn. Retry olmadan süreyi düşürmek "yavaş"ı "bozuk"a çevirirdi.
 *
 * ⚠️ YENİDEN DENEME YALNIZ OKUMADA. İptal edilen bir istek sunucuda UYGULANMIŞ olabilir;
 * yazmayı tekrarlamak satırı iki kez ekler/günceller. Gövdede yazma ifadesi görülürse
 * yeniden denenmez — bu güvence koda gömülü, ayara bırakılmadı.
 */

/**
 * Zaman aşımı süresi (ms). Varsayılan 20sn → **6sn**.
 * Taban 5sn'de bırakıldı: ölçülen en yavaş MEŞRU sorgu ~3,5sn; env ile bunun altına
 * inilirse gerçek iş kesilmeye başlar.
 */
export function dbFetchTimeoutMs(): number {
  return Math.max(5_000, Number(process.env.MLHUB_DB_FETCH_TIMEOUT_MS) || 6_000);
}

/** Bu süreyi aşan istekler kayda geçer — tavana ÇARPMAYAN takılmalar da görünsün. */
export function dbYavasEsikMs(): number {
  return Math.max(300, Number(process.env.MLHUB_DB_SLOW_MS) || 1_000);
}

type FetchLike = (input: unknown, init?: { signal?: AbortSignal; body?: unknown }) => Promise<unknown>;

/** Son yavaş/iptal olayları — teşhis için; tanı ucu buradan okur. */
export interface DbOlay {
  at: number;
  ms: number;
  tur: "yavas" | "iptal" | "yeniden-denendi" | "yeniden-deneme-basarili";
}
const OLAY_TAVANI = 500;
/**
 * ⚠️ `globalThis` ŞART — modül kapsamındaki dizi TEŞHİSİ KÖR EDİYORDU.
 *
 * Next, `instrumentation.ts`'i (relay) rotalardan AYRI paketlere derliyor. Veritabanı
 * istemcisini ilk yaratan katman hangisiyse olaylar ONUN kopyasına yazılıyor; `/api/diag/db`
 * ise rota katmanındaki kopyayı okuyor. Sonuç: uç, gerçekte ne olursa olsun HER ZAMAN
 * "sıfır yavaş, sıfır iptal" döndürüyordu — yani "veritabanı temiz" çıkarımı yapısal olarak
 * anlamsızdı. Aynı tuzak Bambu'da iki MQTT istemcisi doğurmuştu.
 *
 * Tavan 200 → 500: artık tüm paketlerin ortak kuyruğu.
 */
const olaylar: DbOlay[] = ((globalThis as unknown as { __mlhub_db_olaylar?: DbOlay[] })
  .__mlhub_db_olaylar ??= []);

function olayEkle(tur: DbOlay["tur"], ms: number): void {
  olaylar.push({ at: Date.now(), ms: Math.round(ms), tur });
  if (olaylar.length > OLAY_TAVANI) olaylar.splice(0, olaylar.length - OLAY_TAVANI);
}

/** Teşhis: son olaylar + özet. */
export function dbOlaylari(): { olaylar: DbOlay[]; ozet: Record<string, number> } {
  const ozet: Record<string, number> = { yavas: 0, iptal: 0, "yeniden-denendi": 0, "yeniden-deneme-basarili": 0 };
  for (const o of olaylar) ozet[o.tur] = (ozet[o.tur] ?? 0) + 1;
  return { olaylar: [...olaylar], ozet };
}

/** Testler için. */
export function dbOlaylariSifirla(): void {
  olaylar.length = 0;
}

/**
 * Gövdede veri DEĞİŞTİREN bir ifade var mı? Varsa yeniden deneme yapılmaz.
 * Şüphede kalırsan "var" say — yanlış pozitif yalnız bir yavaşlık, yanlış negatif VERİ BOZAR.
 */
export function govdeYazmaIceriyor(body: unknown): boolean {
  if (body == null) return false;
  let metin: string;
  if (typeof body === "string") metin = body;
  else if (body instanceof Uint8Array) metin = new TextDecoder().decode(body);
  else return true; // tanımadığımız gövde → güvenli tarafta kal
  return /\b(insert|update|delete|replace|create|drop|alter|pragma|begin|commit|vacuum)\b/i.test(metin);
}

/** Girdi bir `Request` nesnesi mi? (libSQL istemcisi fetch'i böyle çağırıyor — aşağıya bak.) */
function istekNesnesi(x: unknown): Request | null {
  return typeof Request !== "undefined" && x instanceof Request ? x : null;
}

/**
 * Request gövdesinde yazma var mı? Gövde klonlanarak okunur — asıl nesne tüketilmez.
 * Okunamıyorsa "var" say (yanlış pozitif yalnız bir yavaşlık, yanlış negatif VERİ BOZAR).
 */
async function istekYazmaIceriyor(istek: Request | null): Promise<boolean> {
  if (!istek) return true;
  if (istek.body == null) return false;
  try {
    return govdeYazmaIceriyor(await istek.clone().text());
  } catch {
    return true;
  }
}

/**
 * Verilen fetch'i zaman aşımı + (yalnız okumada) tek yeniden denemeyle sarar.
 * `temel` verilmezse global fetch kullanılır (test bunu kendi sahte fetch'iyle çağırır).
 *
 * ⚠️ libSQL'in HTTP istemcisi fetch'i TEK ARGÜMANLA, hazır bir `Request` nesnesiyle çağırıyor
 * (`fetch(new Request(url, { method: "POST", body }))`). Bu sarmal ilk yazıldığında iki şey
 * varsayılmıştı, ikisi de yanlıştı:
 *   1. Aynı nesneyle ikinci kez fetch yapılabilir → YAPILAMAZ: ilk deneme gövdeyi tüketiyor,
 *      ikinci deneme "Request object that has already been used" ile çöküyordu. Günlükte
 *      1.196 kez (tek günde 322) — kurtarma denemesi BİR KEZ BİLE çalışmamıştı.
 *   2. Gövde `init.body`'de → DEĞİL: `init` hiç yok, her istek "okuma" sanılıyordu. Yani
 *      yazma koruması kördü; çift yazma olmamasının tek sebebi 1. hatanın denemeyi öldürmesiydi.
 * Çözüm: ilk denemeden ÖNCE klon alınır (okunmadıkça maliyeti yok); yazma kontrolü ve yeniden
 * deneme o klondan yapılır. İkisini ayrı ayrı düzeltmek YASAK — yalnız 1'i düzeltmek zaman
 * aşımına uğrayan yazmaları iki kez uygular.
 */
export function withDbFetchTimeout(temel?: FetchLike, timeoutMs?: number): FetchLike {
  const alt: FetchLike =
    temel ?? ((input, init) => (fetch as unknown as FetchLike)(input, init));
  const sure = timeoutMs ?? dbFetchTimeoutMs();
  const yenidenKapali = process.env.MLHUB_DB_FETCH_RETRY === "0";

  const birKez = (input: unknown, init?: { signal?: AbortSignal; body?: unknown }) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), sure);
    // Çağıranın kendi iptal sinyali varsa onu da dinle — yoksa iptal yutulurdu. Request
    // nesnesinin kendi sinyali de sayılır: init'teki sinyal onu EZER.
    const disSinyal = init?.signal ?? istekNesnesi(input)?.signal;
    if (disSinyal) {
      if (disSinyal.aborted) ctrl.abort();
      else disSinyal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    return alt(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  };

  return async (input, init) => {
    const bas = Date.now();
    const istek = istekNesnesi(input);
    // Yeniden deneme için yedek — ilk deneme asıl nesnenin gövdesini tüketecek.
    const yedek = istek && !yenidenKapali ? istek.clone() : null;
    try {
      const r = await birKez(input, init);
      const gecen = Date.now() - bas;
      if (gecen >= dbYavasEsikMs()) olayEkle("yavas", gecen);
      return r;
    } catch (e) {
      const gecen = Date.now() - bas;
      olayEkle("iptal", gecen);

      const disIptal = init?.signal?.aborted === true || istek?.signal?.aborted === true;
      if (yenidenKapali || disIptal) throw e;
      const yazma = istek ? await istekYazmaIceriyor(yedek) : govdeYazmaIceriyor(init?.body);
      if (yazma) throw e;

      /**
       * TAZE BAĞLANTIYLA TEK DENEME. Ölçüm: uygulama 18-20 sn takılıyken ayrı süreç aynı
       * sorguyu 72-73 ms'de aldı — yani ölen bağlantıydı, hizmet değil.
       */
      olayEkle("yeniden-denendi", gecen);
      const r = await birKez(yedek ?? input, init);
      olayEkle("yeniden-deneme-basarili", Date.now() - bas);
      return r;
    }
  };
}
