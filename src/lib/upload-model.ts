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
function xhrSend(
  method: string,
  url: string,
  body: XMLHttpRequestBodyInit,
  onProgress?: (p: UploadProgress) => void,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    const t0 = performance.now();
    let lastT = t0;
    let lastLoaded = 0;
    let speed = 0;
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable || !onProgress) return;
      const now = performance.now();
      const dt = (now - lastT) / 1000;
      if (dt >= 0.12) {
        const inst = (e.loaded - lastLoaded) / dt;
        speed = speed > 0 ? speed * 0.65 + inst * 0.35 : inst; // EMA → zıplamayı yumuşat
        lastT = now;
        lastLoaded = e.loaded;
      }
      onProgress({ loaded: e.loaded, total: e.total, bytesPerSec: speed });
    };
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => reject(new Error("Ağ hatası — bağlantını kontrol et"));
    xhr.ontimeout = () => reject(new Error("Zaman aşımı"));
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

async function presign(originalName: string): Promise<PresignResp> {
  const r = await fetch("/api/storage/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ originalName }),
  });
  const data = (await r.json().catch(() => ({}))) as PresignResp;
  if (!r.ok) throw new Error(data?.error || `Hazırlık hatası (HTTP ${r.status})`);
  return data;
}

/** Dosyayı imzalı URL ile doğrudan R2'ye PUT et (gerçek progress). */
async function putToR2(uploadUrl: string, file: File, onProgress?: (p: UploadProgress) => void) {
  const res = await xhrSend("PUT", uploadUrl, file, onProgress);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `Buluta yükleme reddedildi (HTTP ${res.status}). R2 CORS ayarı eksik olabilir — Ayarlar → Cloud Depolama'dan "Bağlantıyı test et".`,
    );
  }
}

/** Ürüne bağlı model parçası yükle (R2 veya yerel). */
export async function uploadProductModel(opts: {
  productId: string;
  printerConfigId: string;
  file: File;
  applyToVariants?: boolean;
  onProgress?: (p: UploadProgress) => void;
}): Promise<unknown> {
  const { productId, printerConfigId, file, applyToVariants, onProgress } = opts;
  const pre = await presign(file.name);

  if (pre.mode === "r2" && pre.uploadUrl && pre.key) {
    await putToR2(pre.uploadUrl, file, onProgress);
    const r = await fetch(`/api/products/${productId}/models`, {
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
  const res = await xhrSend("POST", `/api/products/${productId}/models`, fd, onProgress);
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
