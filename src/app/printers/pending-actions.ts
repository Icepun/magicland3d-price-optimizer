/**
 * "Hangi yazıcıda hangi komut yolda?" — YAZICI BAŞINA tutulur.
 *
 * Eskiden bu bilgi tek bir mutation gözlemcisinden (`variables` / `isPending`) türetiliyordu.
 * React Query'de bu alanlar YALNIZ en son çağrıyı yansıtır: önceki komut arka planda koşmaya
 * devam eder ama gözlemci onu bırakır. Moonraker'da iptal 45sn istek + 20sn doğrulama, duraklat
 * 30sn + 12sn sürebildiği için pencere gerçekten uzun — o sırada başka bir yazıcıya basılan
 * ışık düğmesi, HÂLÂ duraklatılmakta olan yazıcının düğmelerini yeniden etkinleştiriyordu
 * (kullanıcı iki tıkla basan bir yazıcıyı duraklatıp saniyeler içinde tekrar başlatabiliyordu).
 *
 * Saf ve yan etkisiz: mutation'ın `onMutate`'inde eklenir, `onSettled`'ında silinir.
 */

/** Yazıcı kimliği → o yazıcıda yolda olan komutlar (gönderim sırasıyla). */
export type PendingMap<A extends string = string> = Readonly<Record<string, readonly A[]>>;

export const NO_PENDING: PendingMap<never> = Object.freeze({});

export function addPending<A extends string>(map: PendingMap<A>, id: string, action: A): PendingMap<A> {
  return { ...map, [id]: [...(map[id] ?? []), action] };
}

/** Aynı yazıcıya iki komut gittiyse yalnız BİR tanesi düşer — kilit erken açılmaz. */
export function removePending<A extends string>(map: PendingMap<A>, id: string, action: A): PendingMap<A> {
  const list = map[id];
  if (!list || list.length === 0) return map;
  const at = list.indexOf(action);
  if (at < 0) return map;
  const next = [...list.slice(0, at), ...list.slice(at + 1)];
  const out = { ...map };
  if (next.length === 0) delete out[id];
  else out[id] = next;
  return out;
}

/** Kartta gösterilecek komut — en son gönderilen. Yoksa null. */
export function pendingFor<A extends string>(map: PendingMap<A>, id: string): A | null {
  const list = map[id];
  return list && list.length ? list[list.length - 1] : null;
}

/** Herhangi bir yazıcıda komut yolda mı (yoklamayı duraklatmak için). */
export function anyPending(map: PendingMap): boolean {
  for (const id in map) if ((map[id]?.length ?? 0) > 0) return true;
  return false;
}
