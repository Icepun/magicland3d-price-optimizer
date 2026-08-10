import fs from "node:fs/promises";
import path from "node:path";
import { encryptSecret, tryDecryptSecret } from "@/lib/crypto";

/**
 * Turso (libSQL) bulut DB bağlantı ayarları.
 *
 * userData/turso-settings.json içinde tutulur (her makineye aynı URL+token girilir).
 * electron/main.js bu dosyayı startup'ta okuyup TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
 * env'e koyar; prisma.ts da bu env'lere bakarak Turso'ya bağlanır.
 *
 * NEDEN ŞİFRELİ: bu token TÜM iş verisine tam yetki verir; Trendyol/Shopify
 * kimlikleriyle aynı AES-256-GCM deseniyle (src/lib/crypto.ts) saklanır.
 * Şifreli değer `authTokenEnc` alanında durur.
 *
 * NEDEN HÂLÂ BİR DÜZ METİN KOPYA VAR: electron/main.js düz JS'tir ve açılışta
 * `authToken` alanını doğrudan env'e koyar (çözemez). Düz kopyayı bugün silmek
 * kullanıcının bulut bağlantısını koparır. Bu yüzden "köprü" varsayılan olarak
 * açıktır; main.js + /api/turso/test şifreliyi okumaya geçince
 * MLHUB_TURSO_PLAINTEXT_BRIDGE=0 ile köprü kapanır ve düz kopya dosyadan silinir.
 */
export interface TursoSettings {
  url: string;
  authToken: string;
}

interface StoredTursoSettings {
  url?: string;
  /** ESKİ biçim: düz metin token (geriye dönük okuma + main.js köprüsü). */
  authToken?: string;
  /** YENİ biçim: AES-256-GCM ile şifrelenmiş token. */
  authTokenEnc?: string;
}

/** main.js düz metni hâlâ okuduğu için köprü varsayılan AÇIK. */
function plaintextBridgeEnabled(): boolean {
  return process.env.MLHUB_TURSO_PLAINTEXT_BRIDGE?.trim() !== "0";
}

function getSettingsFilePath() {
  return (
    process.env.TURSO_SETTINGS_FILE ||
    path.join(process.cwd(), "data", "turso-settings.json")
  );
}

async function readStored(): Promise<StoredTursoSettings> {
  try {
    const raw = await fs.readFile(getSettingsFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    // Dosya yok / bozuk → ayar yok. Hata mesajında token olabileceği için asla loglanmaz.
    return {};
  }
}

async function writeStored(next: StoredTursoSettings) {
  const filePath = getSettingsFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // mode 0o600: dosyayı sadece bu kullanıcı okuyabilsin.
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** Şifreli+düz alanlardan geçerli token'ı çıkarır. Hiç token yoksa "". */
function resolveToken(stored: StoredTursoSettings): string {
  const fromEnc = tryDecryptSecret(stored.authTokenEnc);
  if (fromEnc) return fromEnc;
  // Geriye dönük: diskte hâlâ düz metin duruyorsa kabul et (bağlantı kopmasın).
  return stored.authToken?.trim() ?? "";
}

/** Verilen ayarların diskte olması gereken hâli (şifreli + köprü kuralı). */
function normalize(stored: StoredTursoSettings, token: string): StoredTursoSettings {
  const next: StoredTursoSettings = { url: stored.url ?? "" };
  if (token) {
    next.authTokenEnc = stored.authTokenEnc && tryDecryptSecret(stored.authTokenEnc)
      ? stored.authTokenEnc
      : encryptSecret(token);
    if (plaintextBridgeEnabled()) next.authToken = token;
  }
  return next;
}

function needsRewrite(stored: StoredTursoSettings, target: StoredTursoSettings): boolean {
  return (
    (stored.authTokenEnc ?? "") !== (target.authTokenEnc ?? "") ||
    (stored.authToken ?? "") !== (target.authToken ?? "")
  );
}

// Aynı anda birden çok okuma göçü tetiklemesin diye tek uçuş.
let migrationInFlight: Promise<void> | null = null;

/**
 * Sessiz göç: diskte düz metin token varsa şifrelisini yazar (köprü kapalıysa
 * düz kopyayı da siler). Kullanıcı hiçbir şey fark etmez; hata olursa yutulur —
 * göç başarısız olsa bile okuma/bağlantı çalışmaya devam eder.
 */
async function migrateIfNeeded(stored: StoredTursoSettings, token: string) {
  if (!token) return;
  const target = normalize(stored, token);
  if (!needsRewrite(stored, target)) return;
  if (migrationInFlight) return migrationInFlight;

  const run = (async () => {
    try {
      await writeStored(target);
    } catch {
      // Diske yazılamadı (izin/kilit) → sessiz geç, bir sonraki okumada tekrar denenir.
    } finally {
      migrationInFlight = null;
    }
  })();
  migrationInFlight = run;

  return run;
}

/** Token'ı asla ele vermeyen maske (uzunluk bilgisi bile sızmaz). */
function mask(value?: string | null): string {
  if (!value) return "";
  if (value.length <= 8) return "••••••••";
  return `••••••••${value.slice(-4)}`;
}

/** Ayarları oku + gerekiyorsa sessizce şifreliye göç et. */
async function loadSettings(): Promise<{ url: string; authToken: string }> {
  const stored = await readStored();
  const authToken = resolveToken(stored);
  await migrateIfNeeded(stored, authToken);
  return { url: stored.url ?? "", authToken };
}

export async function getPublicTursoSettings() {
  const { url, authToken } = await loadSettings();
  return {
    url,
    hasAuthToken: Boolean(authToken),
    authTokenMasked: mask(authToken),
    // Şu an aktif olan mod (env'e bakar — restart sonrası geçerli olur)
    activeMode: process.env.TURSO_DATABASE_URL ? "turso" : "local",
  };
}

/**
 * Kaydedilmiş bağlantı bilgileri (token AÇIK hâlde döner).
 * Sadece libSQL client kurmak için kullanılır; yanıt gövdesine/loga konmaz.
 */
export async function getTursoConnection(): Promise<TursoSettings> {
  return loadSettings();
}

export async function saveTursoSettings(input: { url: string; authToken?: string }) {
  const stored = await readStored();
  const incoming = input.authToken?.trim();
  // Token alanı boş bırakıldıysa mevcut token korunur (kullanıcı her seferinde yapıştırmasın).
  const token = incoming || resolveToken(stored);

  const next = normalize({ ...stored, url: input.url.trim() }, token);
  next.url = input.url.trim();
  if (incoming) {
    // Yeni token geldi → şifreliyi baştan üret.
    next.authTokenEnc = encryptSecret(incoming);
    if (plaintextBridgeEnabled()) next.authToken = incoming;
    else delete next.authToken;
  }

  await writeStored(next);
}

export async function clearTursoSettings() {
  await writeStored({});
}
