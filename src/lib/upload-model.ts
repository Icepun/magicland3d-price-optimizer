/**
 * İstemci-tarafı model dosyası yükleme. R2 açıksa: sunucudan imzalı PUT URL al → dosyayı DOĞRUDAN
 * R2'ye XHR ile yükle (gerçek progress: bayt + hız) → sunucuya confirm (DB satırı). R2 kapalıysa:
 * eski yerel multipart yüklemeye düşer. Dosya main process'ten GEÇMEZ → pencere donmaz.
 */

export interface UploadProgress {
  /** Yüklenen bayt. */
  loaded: number;
  /** Toplam bayt. */
  total: number;
  /** Anlık hız (bayt/sn, yumuşatılmış). */
  bytesPerSec: number;
}

interface PresignResp {
  mode: "r2" | "local";
  key?: string;
  uploadUrl?: string;
  error?: string;
}

/** Genel XHR gönderimi + upload progress (hız EMA ile yumuşatılır). */
/** Bu kadar süre hiç bayt gitmezse yükleme "takıldı" sayılır ve kesilir (Wi-Fi askıda kalınca pencere kilitleniyordu). */
const TAKILMA_MS = 60_000;

function xhrSend(
  method: string,
  url: string,
  body: XMLHttpRequestBodyInit,
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Yükleme iptal edildi"));
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    let sonIlerleme = Date.now();
    const bekci = setInterval(() => {
      if (Date.now() - sonIlerleme > TAKILMA_MS) {
        clearInterval(bekci);
        xhr.abort();
        reject(new Error("Bağlantı koptu — yükleme durdu, tekrar dene"));
      }
    }, 5_000);
    const iptal = () => { clearInterval(bekci); xhr.abort(); reject(new Error("Yükleme iptal edildi")); };
    signal?.addEventListener("abort", iptal, { once: true });
    const bitir = () => { clearInterval(bekci); signal?.removeEventListener("abort", iptal); };
    const t0 = performance.now();
    let lastT = t0;
    let lastLoaded = 0;
    let speed = 0;
    xhr.upload.onprogress = (e) => {
      sonIlerleme = Date.now();
      if (!e.lengthComputable || !onProgress) return;
      const now = performance.now();
      const dt = (now - lastT) / 1000;
      if (dt >= 0.12) {
        const inst = (e.loaded - lastLoaded) / dt;
        speed = speed > 0 ? speed * 0.65 + inst * 0.35 : inst; // EMA → zıplamayı yumuşat
        lastT = now;
        lastLoaded = e.loaded;
      } else if (speed === 0 && e.loaded > 0) {
        // Küçük dosyada 0,12 sn'lik pencere hiç dolmuyor, hız 0 kalıyor ve ekranda
        // "başlıyor…" yükleme bitene kadar duruyordu. İlk olayda baştan beri geçen süreyle
        // dürüst bir ortalama ver — kullanıcı ilerlemenin aktığını görsün.
        const gecen = (now - t0) / 1000;
        if (gecen >= 0.03) speed = e.loaded / gecen;
      }
      onProgress({ loaded: e.loaded, total: e.total, bytesPerSec: speed });
    };
    xhr.onload = () => { bitir(); resolve({ status: xhr.status, text: xhr.responseText }); };
    xhr.onerror = () => { bitir(); reject(new Error("Bağlantı hatası — bağlantını kontrol et")); };
    xhr.ontimeout = () => { bitir(); reject(new Error("Bağlantı koptu — yükleme durdu, tekrar dene")); };
    xhr.send(body);
  });
}

function errFromText(text: string, fallback: string): string {
  try {
    const b = JSON.parse(text);
    if (b?.error) return String(b.error);
  } catch {
    /* düz metin */
  }
  return fallback;
}

/**
 * PARÇAYA KAYNAK MODEL BAĞLA — görüntüleme için (baskıya gönderilmez).
 *
 * Baskı dosyalarından AYRI bir önekte ("meshes/") saklanır; süpürücü iki öneki ayrı
 * kolonlara göre tarıyor, karıştırılırsa veri silinir.
 */
export async function uploadPartMesh(opts: {
  fileId: string;
  file: File;
  onProgress?: (p: UploadProgress) => void;
}): Promise<{ tur: string; boyut: number }> {
  const { fileId, file, onProgress } = opts;

  const pres = await fetch("/api/storage/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ originalName: file.name, kind: "mesh" }),
  });
  const presJson = (await pres.json().catch(() => ({}))) as { mode?: string; key?: string; uploadUrl?: string; error?: string };
  if (!pres.ok) throw new Error(presJson.error || "Yükleme başlatılamadı");
  if (presJson.mode !== "r2" || !presJson.key || !presJson.uploadUrl) {
    // Kaynak model yalnız bulutta anlamlı: yerel diskteki dosyaya diğer cihazlar erişemez.
    throw new Error("Bulut depolama kapalı — kaynak model eklenemiyor");
  }

  await putToR2(presJson.uploadUrl, file, onProgress);

  const onay = await fetch(`/api/models/${fileId}/mesh`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: presJson.key, name: file.name, sizeBytes: file.size }),
  });
  const onayJson = (await onay.json().catch(() => ({}))) as { tur?: string; boyut?: number; error?: string };
  if (!onay.ok) throw new Error(onayJson.error || "Model kaydedilemedi");
  return { tur: onayJson.tur || "", boyut: onayJson.boyut || file.size };
}

async function presign(originalName: string, signal?: AbortSignal): Promise<PresignResp> {
  const r = await fetch("/api/storage/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ originalName }),
    signal,
  });
  const data = (await r.json().catch(() => ({}))) as PresignResp;
  if (!r.ok) throw new Error(data?.error || "Yükleme başlatılamadı — tekrar dene");
  return data;
}

/** Dosyayı imzalı URL ile doğrudan R2'ye PUT et (gerçek progress). */
async function putToR2(uploadUrl: string, file: File, onProgress?: (p: UploadProgress) => void, signal?: AbortSignal) {
  const res = await xhrSend("PUT", uploadUrl, file, onProgress, signal);
  if (res.status < 200 || res.status >= 300) {
    throw new Error("Dosya buluta yüklenemedi — Ayarlar → Bulut Depolama'dan bağlantıyı test et");
  }
}

/** Ürüne bağlı model parçası yükle (R2 veya yerel). */
export async function uploadProductModel(opts: {
  productId: string;
  printerConfigId: string;
  file: File;
  applyToVariants?: boolean;
  onProgress?: (p: UploadProgress) => void;
  /** "İptal" düğmesi. */
  signal?: AbortSignal;
}): Promise<unknown> {
  const { productId, printerConfigId, file, applyToVariants, onProgress, signal } = opts;
  const pre = await presign(file.name, signal);

  if (pre.mode === "r2" && pre.uploadUrl && pre.key) {
    await putToR2(pre.uploadUrl, file, onProgress, signal);
    const r = await fetch(`/api/products/${productId}/models`, {
      signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        r2Key: pre.key,
        originalName: file.name,
        printerConfigId,
        sizeBytes: file.size,
        applyToVariants: !!applyToVariants,
      }),
    });
    if (!r.ok) throw new Error(errFromText(await r.text(), "Kayıt oluşturulamadı"));
    // Oluşturulan satır (ana ürün) → çağıran cache'e optimistic ekler (refetch yok → donma yok).
    return r.json().catch(() => null);
  }

  // Yerel fallback (R2 kapalı): eski multipart yükleme.
  const fd = new FormData();
  fd.append("file", file);
  fd.append("printerConfigId", printerConfigId);
  if (applyToVariants) fd.append("applyToVariants", "true");
  const res = await xhrSend("POST", `/api/products/${productId}/models`, fd, onProgress, signal);
  if (res.status < 200 || res.status >= 300) throw new Error(errFromText(res.text, "Yüklenemedi"));
  try { return JSON.parse(res.text); } catch { return null; }
}

/** Özel baskı (ürünsüz) dosyası yükle — meta (gramaj/süre/önizleme/renk) döner. */
export async function uploadCustomModel(opts: {
  printerConfigId: string;
  file: File;
  onProgress?: (p: UploadProgress) => void;
}): Promise<Record<string, unknown>> {
  const { printerConfigId, file, onProgress } = opts;
  const pre = await presign(file.name);

  if (pre.mode === "r2" && pre.uploadUrl && pre.key) {
    await putToR2(pre.uploadUrl, file, onProgress);
    const r = await fetch(`/api/custom-print/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        r2Key: pre.key,
        originalName: file.name,
        printerConfigId,
        sizeBytes: file.size,
      }),
    });
    if (!r.ok) throw new Error(errFromText(await r.text(), "Kayıt oluşturulamadı"));
    return r.json();
  }

  // Yerel fallback.
  const fd = new FormData();
  fd.append("file", file);
  fd.append("printerConfigId", printerConfigId);
  const res = await xhrSend("POST", `/api/custom-print/upload`, fd, onProgress);
  if (res.status < 200 || res.status >= 300) throw new Error(errFromText(res.text, "Yüklenemedi"));
  return JSON.parse(res.text);
}
