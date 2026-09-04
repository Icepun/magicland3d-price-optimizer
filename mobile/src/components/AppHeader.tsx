/**
 * KÖPRÜ — eski ekranlar `AppHeader`/`NotificationBell` adıyla içe aktarıyor; gövde artık kit'te.
 * Ekranlar yeniden yazıldıkça doğrudan `@/components/kit` kullanılır ve bu dosya silinir.
 */
export { Header as AppHeader, Bell as NotificationBell } from "@/components/kit/Header";
