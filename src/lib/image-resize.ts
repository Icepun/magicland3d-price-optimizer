"use client";

/**
 * Görseli küçültüp JPEG **data URL**'sine çevirir (tarayıcı/canvas ile).
 *
 * NEDEN: Elle yüklenen görseller eskiden yerel dosyaya kaydedilip imageUrl = "/api/images/<uuid>"
 * oluyordu; bu yalnızca o bilgisayarın yerel sunucusunda çözülüyordu → mobil/diğer cihazlar (Turso'yu
 * doğrudan okuyan) bu görseli yükleyemiyordu. Data URL DB'de durur → HER cihaz görür, yerel dosya yok.
 *
 * Küçültme (max ~600px, JPEG ~0.85) data URL'i küçük tutar (~30-60KB) → DB/liste payload'u şişmez.
 * Şeffaf alanlar beyazla doldurulur (JPEG şeffaflık tutmaz; ürün görselleri için uygun).
 */
export function imageSrcToDataUrl(src: string, maxSize = 600, quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      if (!w || !h) return reject(new Error("Görsel boyutu okunamadı"));
      if (Math.max(w, h) > maxSize) {
        const s = maxSize / Math.max(w, h);
        w = Math.round(w * s);
        h = Math.round(h * s);
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Görsel işlenemedi"));
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      try {
        resolve(canvas.toDataURL("image/jpeg", quality));
      } catch (e) {
        reject(e instanceof Error ? e : new Error("Görsel dönüştürülemedi (CORS?)"));
      }
    };
    img.onerror = () => reject(new Error("Görsel okunamadı"));
    img.src = src;
  });
}

/** Dosyayı küçültülmüş data URL'sine çevirir. */
export async function fileToResizedDataUrl(file: File, maxSize = 600, quality = 0.85): Promise<string> {
  const objUrl = URL.createObjectURL(file);
  try {
    return await imageSrcToDataUrl(objUrl, maxSize, quality);
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}
