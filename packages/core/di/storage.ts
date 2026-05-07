/**
 * DI registrations for blob storage (session input uploads, eventually
 * exports). Selects LocalDiskBlobStore or S3BlobStore based on
 * `config.storage.blobBackend`.
 *
 * Registered as a singleton with an awilix disposer so the S3 client
 * socket gets torn down on shutdown.
 *
 * Hosted-mode contract: blobs MUST live in cross-pod-visible storage. A
 * `LocalDiskBlobStore` rooted at `<arkDir>/blobs` would land on the
 * conductor pod's ephemeral disk -- lost on restart, invisible to other
 * pods, and shared across tenants. The factory therefore refuses to build a
 * local-disk blob store when `app.mode.kind === "hosted"` and surfaces a
 * configuration error at boot rather than letting the deployment silently
 * write to local disk.
 */

import { asFunction, Lifetime } from "awilix";
import { join } from "path";
import type { AppContainer } from "../container.js";
import type { ArkConfig } from "../config.js";
import type { AppMode } from "../modes/app-mode.js";
import type { BlobStore } from "../storage/blob-store.js";
import { LocalDiskBlobStore } from "../storage/local-disk.js";
import { S3BlobStore } from "../storage/s3.js";

export function registerStorage(container: AppContainer): void {
  container.register({
    blobStore: asFunction(
      (c: { config: ArkConfig; mode: AppMode }): BlobStore => {
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
        // Hosted mode rejects the local fallback: the conductor pod's
        // ephemeral disk is not a valid place for tenant blobs. The
        // ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE escape hatch keeps the
        // laptop dev loop usable (`make dev-stack` + the control-plane
        // profile) without standing up MinIO. NEVER set this in
        // production -- the loss-of-tenant-isolation bullet in the
        // throw above is real.
        if (c.mode.kind === "hosted" && process.env.ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE !== "1") {
          throw new Error(
            "storage.blobBackend must be 's3' in hosted mode -- LocalDiskBlobStore is " +
              "pod-ephemeral and not tenant-isolated. Set storage.blobBackend=s3 + " +
              "storage.s3.{bucket,region} (or ARK_BLOB_BACKEND=s3 + ARK_S3_BUCKET + ARK_S3_REGION). " +
              "For laptop dev, set ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE=1 (NOT for prod).",
          );
        }
        // Local disk: single tree under arkDir/blobs, tenant id = first path segment.
        return new LocalDiskBlobStore(join(c.config.dirs.ark, "blobs"));
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
