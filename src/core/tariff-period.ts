/**
 * TARİFE DÖNEMİ SINIRI — yeni bir kargo tarifesi başlarken eski dönem ne zaman kapanır?
 *
 * Kural eşleşmesi KAPSAYICI (`cargo-calculator.ts`: `date > validTo` ise elenir, `date < validFrom`
 * ise elenir). Dolayısıyla eski dönem yeninin başlangıcıyla AYNI ana kapatılırsa o an iki kural
 * birden eşleşir; bir milisaniyeden fazla önce kapatılırsa arada HİÇBİR kuralın uymadığı bir
 * boşluk kalır ve kargo sessizce 0 sayılır.
 *
 * Doğrusu tam olarak bir milisaniye öncesi: milisaniye çözünürlüğünde her an tek bir döneme düşer.
 * (14 Ağu 2026'da TEX tarifesinde bu 999 ms'lik boşluk gerçekten vardı.)
 */
export function tarifeDonemSiniri(baslangic: Date): { baslangic: Date; eskiBitis: Date } {
  return {
    baslangic,
    eskiBitis: new Date(baslangic.getTime() - 1),
  };
}
