import { z } from "zod";

/**
 * Gram fiyatına üst sınır: filament ~0,3–2 TL/g. 20 TL/g'nin üstü neredeyse her zaman kg fiyatının
 * yanlış alana yazılmasıdır (650 TL/kg → 650 TL/g) — o arada gelen siparişlerin kârı kalıcı yazılıyordu.
 */
export const FilamentSemasi = z.object({
  name: z.string().trim().min(1, "Filament adı boş olamaz").max(80, "Ad en çok 80 karakter olabilir"),
  costPerGram: z
    .number({ message: "Gram fiyatı bir sayı olmalı" })
    .positive("Gram fiyatı sıfırdan büyük olmalı")
    .max(20, "Gram fiyatı çok yüksek — kg fiyatı mı girdin? (1 kg = 1000 g)"),
  isActive: z.boolean().default(true),
});
