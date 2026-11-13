/** Mesajı OLDUĞU GİBİ kullanıcıya gösterilebilen hata (kısa, Türkçe, teknik ayrıntısız). */
export class KullaniciHatasi extends Error {
  constructor(mesaj: string, public readonly ayrinti?: unknown) {
    super(mesaj);
    this.name = "KullaniciHatasi";
  }
}
