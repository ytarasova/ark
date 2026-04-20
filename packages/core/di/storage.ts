/**
 * DI registrations for blob storage (session input uploads, eventually
 * exports). Selects LocalDiskBlobStore or S3BlobStore based on
 * `config.storage.blobBackend`.
 *
 * Registered as a singleton with an awilix disposer so the S3 client
 * socket gets torn down on shutdown.
 */

import { asFunction, Lifetime } from "awilix";
import { join } from "path";
import type { AppContainer } from "../container.js";
import type { ArkConfig } from "../config.js";
import type { BlobStore } from "../storage/blob-store.js";
import { LocalDiskBlobStore } from "../storage/local-disk.js";
import { S3BlobStore } from "../storage/s3.js";

export function registerStorage(container: AppContainer): void {
  container.register({
    blobStore: asFunction(
      (c: { config: ArkConfig }): BlobStore => {
        const backend = c.config.storage?.blobBackend ?? "local";
        if (backend === "s3") {
          const s3 = c.config.storage?.s3;
          if (!s3?.bucket || !s3?.region) {
            throw new Error(
              "storage.blobBackend=s3 requires storage.s3.bucket + storage.s3.region " +
                "(or ARK_S3_BUCKET + ARK_S3_REGION env vars)",
            );
          }
          return new S3BlobStore({
            bucket: s3.bucket,
            region: s3.region,
            prefix: s3.prefix ?? "ark",
            endpoint: s3.endpoint,
          });
        }
        // Local disk: single tree under arkDir/blobs, tenant id = first path segment.
        return new LocalDiskBlobStore(join(c.config.arkDir, "blobs"));
      },
      {
        lifetime: Lifetime.SINGLETON,
        dispose: async (store) => {
          await store.dispose?.();
        },
      },
    ),
  });
}
