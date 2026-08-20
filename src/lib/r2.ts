import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";
import { prisma } from "./prisma";

/**
 * Cloudflare R2 (S3 uyumlu) nesne deposu — model dosyalarını buluta koyar.
 *
 * NEDEN: dosyalar şimdiye dek yalnız yükleyen makinenin diskinde duruyordu → başka cihazdan
 * (Mac) baskı başlatılamıyordu ve her şey kişisel diski şişiriyordu. R2'de duran dosya, Turso'da
 * senkronlanan r2Key sayesinde TÜM cihazlardan erişilir; egress ücretsiz → baskıda tekrar tekrar
 * çekmek bedava.
 *
 * Kimlik: kullanıcı Ayarlar'dan girer (AppSetting). Tarayıcı dosyayı imzalı URL ile DOĞRUDAN
 * R2'ye yükler (creds tarayıcıya gitmez, main process'ten geçmez → pencere donmaz).
 */

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const KEYS = ["r2AccountId", "r2Bucket", "r2AccessKeyId", "r2SecretKey"] as const;

/**
 * R2 AYARI ÖNBELLEĞİ — her çağrı bir veritabanı turuydu.
 *
 * Bu fonksiyon yükleme akışında en az DÖRT kez çağrılıyor (imzalı URL, doğrulama, dosyayı
 * okuma, yazıcıya gönderme) ve her seferi uzak Turso'ya gidiyordu: en iyi ihtimalle ~80 ms,
 * veritabanı takılıyken saniyeler. Kullanıcının "başlıyor… %0" ekranında beklediği süre
 * büyük ölçüde buydu — dosya daha yola çıkmadan önce ayar sorgusu bekleniyordu.
 *
 * ⚠️ YALNIZ DOLU sonuç önbelleklenir. R2 kurulu değilken önbellek tutulsaydı, kullanıcı
 * ayarları yeni girdiğinde bir dakika boyunca "bulut kapalı" görürdü. Kurulumdan sonra
 * ilk çağrı zaten anında dolar.
 */
const R2_TTL_MS = 60_000;
let r2Onbellek: { at: number; cfg: R2Config } | null = null;

/** Ayarlar kaydedilince çağrılır — yeni anahtarlar anında geçerli olsun. */
export function invalidateR2Config(): void {
  r2Onbellek = null;
  s3Onbellek = null;
}

/** Ayarlardan R2 yapılandırmasını oku. Hepsi dolu değilse null (R2 kapalı → yerel diske düş). */
export async function getR2Config(): Promise<R2Config | null> {
  if (r2Onbellek && Date.now() - r2Onbellek.at < R2_TTL_MS) return r2Onbellek.cfg;
  const rows = await prisma.appSetting.findMany({ where: { key: { in: KEYS as unknown as string[] } } });
  const m: Record<string, string> = {};
  for (const r of rows) m[r.key] = (r.value ?? "").trim();
  const accountId = m.r2AccountId;
  const bucket = m.r2Bucket;
  const accessKeyId = m.r2AccessKeyId;
  const secretAccessKey = m.r2SecretKey;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  const cfg = { accountId, bucket, accessKeyId, secretAccessKey };
  r2Onbellek = { at: Date.now(), cfg };
  return cfg;
}

/**
 * S3 istemcisi de yeniden kullanılır. Her çağrıda yeni istemci kurmak imzalama zincirini ve
 * bağlantı havuzunu sıfırdan yaratıyordu; aynı ayarla aynı istemci güvenle paylaşılır.
 */
let s3Onbellek: { anahtar: string; istemci: S3Client } | null = null;

function client(cfg: R2Config): S3Client {
  const anahtar = `${cfg.accountId}|${cfg.bucket}|${cfg.accessKeyId}`;
  if (s3Onbellek && s3Onbellek.anahtar === anahtar) return s3Onbellek.istemci;
  const istemci = yeniIstemci(cfg);
  s3Onbellek = { anahtar, istemci };
  return istemci;
}

function yeniIstemci(cfg: R2Config): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    // R2 wildcard sertifikası tek alt-etiket kapsar → bucket'ı subdomain yapan virtual-host
    // stili tarayıcıda sertifika uyuşmazlığı verir. Path-style ZORUNLU.
    forcePathStyle: true,
    // Yeni AWS SDK'lar PUT'a otomatik x-amz-checksum-* başlığı ekler; bu başlık imzaya girer ama
    // tarayıcı göndermez → imza uyuşmazlığı. "WHEN_REQUIRED" bunu kapatır (presigned tarayıcı PUT şart).
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
}

/** Yeni bir model dosyası için benzersiz R2 anahtarı (örn. "models/uuid.gcode"). */
export function makeModelKey(originalName: string): string {
  const ext = (originalName.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `models/${crypto.randomUUID()}.${ext || "bin"}`;
}

/**
 * KAYNAK MODEL (görüntüleme) anahtarı — baskı dosyalarından AYRI önekte.
 *
 * ⚠️ Önek bilerek farklı: `storage-janitor` "models/" altında `ProductModelFile.r2Key`'in
 * referans vermediği her nesneyi SİLİYOR. Mesh'ler oraya konsaydı, farklı bir kolondan
 * referans verildikleri için sahipsiz sanılıp silinirlerdi.
 */
export function makeMeshKey(originalName: string): string {
  const ext = (originalName.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `meshes/${crypto.randomUUID()}.${ext || "bin"}`;
}

export function isValidMeshKey(key: string): boolean {
  return /^meshes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i.test(key);
}

/** Tarayıcının DOĞRUDAN R2'ye PUT edebileceği imzalı URL (1 saat geçerli). */
export async function presignPutUrl(key: string, cfg: R2Config): Promise<string> {
  // ContentType İMZALANMAZ → tarayıcı herhangi bir Content-Type (veya hiç) gönderebilir, imza bozulmaz.
  return getSignedUrl(client(cfg), new PutObjectCommand({ Bucket: cfg.bucket, Key: key }), {
    expiresIn: 3600,
  });
}

/**
 * Nesnenin YALNIZ bir aralığını çek.
 *
 * ⚠️ NEDEN VAR: gcode'un gramajı başlıkta ve altbilgide yazılı — ilgili kısım baş/son 400 KB.
 * Kütüphanedeki 470 dosya 8,4 GB tutuyor; gramajları doldurmak için hepsini indirmek
 * kabul edilemezdi. Aralıkla okuyunca dosya başına ~800 KB iniyor (178 MB'lık dosyada
 * bile), yani toplam ~370 MB yerine 8,4 GB.
 *
 * `end` DAHİLDİR (HTTP Range semantiği). Dosya sonundan okurken `end` dosya boyunu aşabilir;
 * S3/R2 bunu sorun etmez, eldeki kadarını döner.
 */
export async function getObjectRange(
  key: string,
  cfg: R2Config,
  start: number,
  end: number
): Promise<Buffer> {
  const res = await client(cfg).send(
    new GetObjectCommand({ Bucket: cfg.bucket, Key: key, Range: `bytes=${start}-${end}` })
  );
  if (!res.Body) throw new Error("R2: boş yanıt");
  return Buffer.from(await res.Body.transformToByteArray());
}

/** Nesnenin boyutu — aralık okumasında sonu bulmak için (gövde indirilmez). */
export async function getObjectSize(key: string, cfg: R2Config): Promise<number> {
  const res = await client(cfg).send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
  return Number(res.ContentLength) || 0;
}

/** R2'den nesne baytlarını çek (baskı anında, sunucu tarafı). */
export async function getObjectBytes(key: string, cfg: R2Config): Promise<Buffer> {
  const res = await client(cfg).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  if (!res.Body) throw new Error("R2: boş yanıt");
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
}

/** R2'den nesneyi GERÇEK yüzde ilerlemesiyle çek — baskı akışındaki "buluttan indiriliyor"
 *  aşaması için (eskiden indirme akış başlamadan yapılıyordu → kullanıcı ölü ekran görüyordu). */
export async function getObjectBytesWithProgress(
  key: string,
  cfg: R2Config,
  onPct?: (pct: number) => void,
): Promise<Buffer> {
  const res = await client(cfg).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  if (!res.Body) throw new Error("R2: boş yanıt");
  const total = Number(res.ContentLength) || 0;
  const chunks: Buffer[] = [];
  let got = 0;
  let lastPct = -1;
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
    got += chunk.length;
    if (total > 0 && onPct) {
      const pct = Math.min(100, Math.floor((got / total) * 100));
      if (pct !== lastPct) { lastPct = pct; onPct(pct); }
    }
  }
  return Buffer.concat(chunks);
}

/** R2'den nesneyi sil (son referans gidince). */
export async function deleteObject(key: string, cfg: R2Config): Promise<void> {
  await client(cfg).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
}

/** Kimlik/bucket doğru mu? (Ayarlar'daki "Bağlantıyı test et" — sunucu tarafı creds kontrolü.) */
export async function headBucket(cfg: R2Config): Promise<void> {
  await client(cfg).send(new HeadBucketCommand({ Bucket: cfg.bucket }));
}

/** Uygulamanın ürettiği anahtar şekli mi? (confirm doğrulaması — keyfi/yabancı key kabul edilmez.) */
export function isValidModelKey(key: string): boolean {
  return /^models\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i.test(key);
}

/** Nesne gerçekten var mı + boyutu ne? (confirm'de PUT'un başarıyla indiğini doğrular.) */
export async function headObjectSize(key: string, cfg: R2Config): Promise<number | null> {
  try {
    const res = await client(cfg).send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
    return Number(res.ContentLength) || 0;
  } catch {
    return null; // yok / erişilemedi
  }
}

/** "models/" önekindeki nesneleri listele (orphan süpürücü için). */
export async function listModelObjects(
  cfg: R2Config,
  /** Hangi önek taranacak. Varsayılan baskı dosyaları; kaynak modeller "meshes/" altında. */
  prefix: "models/" | "meshes/" = "models/",
): Promise<{ key: string; lastModified: Date | null; size: number }[]> {
  const out: { key: string; lastModified: Date | null; size: number }[] = [];
  let token: string | undefined;
  do {
    const res = await client(cfg).send(
      new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 })
    );
    for (const o of res.Contents ?? []) {
      if (o.Key) out.push({ key: o.Key, lastModified: o.LastModified ?? null, size: Number(o.Size) || 0 });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token && out.length < 20_000);
  return out;
}

/**
 * Nesnenin YALNIZ İLK N BAYTI (HTTP Range).
 *
 * Slicer'ın gömülü önizlemesi dosyanın en başında; 140 MB'lık gcode'u tamamen indirmek
 * hem yavaş hem gereksiz. R2 aralık isteğini destekliyor.
 */
export async function getObjectHead(key: string, cfg: R2Config, bytes: number): Promise<Buffer> {
  const res = await client(cfg).send(
    new GetObjectCommand({ Bucket: cfg.bucket, Key: key, Range: `bytes=0-${Math.max(0, bytes - 1)}` })
  );
  if (!res.Body) throw new Error("R2: boş yanıt");
  return Buffer.from(await res.Body.transformToByteArray());
}

