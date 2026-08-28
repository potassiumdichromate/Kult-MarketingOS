import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import type { StorageConfig } from '@kult/config';
import { NotConfiguredError, ProviderError } from '@kult/shared';

/**
 * S3-compatible object storage.
 *
 * Provider-specific behaviour is confined to this adapter: AWS S3, Cloudflare R2
 * and MinIO differ only in endpoint, region naming, and path-style addressing,
 * all of which are configuration. Nothing outside this file assumes a provider.
 *
 * A note on public URLs: Instagram's Content Publishing API builds a media
 * container from a *publicly reachable URL*, not an upload. Deployments that
 * intend to publish images to Instagram must therefore set
 * STORAGE_PUBLIC_BASE_URL to a bucket/CDN origin that is readable without
 * credentials. `publicUrl()` returns null when that is not configured, and the
 * Instagram provider surfaces the requirement rather than guessing.
 */

export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
  publicUrl: string | null;
}

export interface StorageAdapter {
  readonly configured: boolean;
  put(input: {
    key?: string;
    body: Buffer | Uint8Array;
    contentType: string;
    /** Marks the object for public read where the provider/bucket supports it. */
    cacheControl?: string;
  }): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Time-limited download URL for private objects. */
  signedUrl(key: string, expiresInSeconds?: number): Promise<string>;
  /** Stable, credential-free URL. Null unless STORAGE_PUBLIC_BASE_URL is set. */
  publicUrl(key: string): string | null;
}

const REQUIRED_VARS = [
  'STORAGE_ENDPOINT',
  'STORAGE_REGION',
  'STORAGE_BUCKET',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
];

/**
 * Used when object storage is absent. Every operation raises NotConfiguredError
 * naming the exact variables to set - never a silent no-op that would make a
 * caller believe an upload succeeded.
 */
export class UnconfiguredStorage implements StorageAdapter {
  readonly configured = false;

  private fail(): never {
    throw new NotConfiguredError('Object storage', REQUIRED_VARS);
  }

  async put(): Promise<StoredObject> {
    this.fail();
  }
  async get(): Promise<Buffer> {
    this.fail();
  }
  async delete(): Promise<void> {
    this.fail();
  }
  async exists(): Promise<boolean> {
    this.fail();
  }
  async signedUrl(): Promise<string> {
    this.fail();
  }
  publicUrl(): string | null {
    return null;
  }
}

export class S3CompatibleStorage implements StorageAdapter {
  readonly configured = true;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl?: string;

  constructor(private readonly config: StorageConfig) {
    this.bucket = config.bucket;
    if (config.publicBaseUrl) this.publicBaseUrl = config.publicBaseUrl.replace(/\/$/, '');
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async put(input: {
    key?: string;
    body: Buffer | Uint8Array;
    contentType: string;
    cacheControl?: string;
  }): Promise<StoredObject> {
    const key = input.key ?? `assets/${new Date().toISOString().slice(0, 10)}/${randomUUID()}`;
    const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: input.contentType,
          ...(input.cacheControl ? { CacheControl: input.cacheControl } : {}),
        }),
      );
    } catch (error) {
      throw this.wrap('put', error);
    }

    return {
      key,
      size: body.byteLength,
      contentType: input.contentType,
      publicUrl: this.publicUrl(key),
    };
  }

  async get(key: string): Promise<Buffer> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!result.Body) throw new Error('Empty body');
      const bytes = await result.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (error) {
      throw this.wrap('get', error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw this.wrap('delete', error);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, expiresInSeconds = 900): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: expiresInSeconds },
      );
    } catch (error) {
      throw this.wrap('signedUrl', error);
    }
  }

  publicUrl(key: string): string | null {
    if (!this.publicBaseUrl) return null;
    return `${this.publicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** Normalises SDK failures into ProviderError without leaking credentials. */
  private wrap(operation: string, error: unknown): ProviderError {
    const status =
      typeof error === 'object' && error !== null && '$metadata' in error
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        : undefined;
    const name = error instanceof Error ? error.name : 'UnknownError';
    return new ProviderError('storage', `Object storage ${operation} failed (${name}).`, {
      ...(status !== undefined ? { providerStatus: status } : {}),
      retryable: status === undefined || status >= 500 || status === 429,
      details: { operation, endpoint: this.config.endpoint, bucket: this.bucket },
    });
  }
}

export function createStorage(config: StorageConfig | undefined): StorageAdapter {
  return config ? new S3CompatibleStorage(config) : new UnconfiguredStorage();
}
