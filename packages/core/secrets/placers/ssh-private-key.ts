import type { TypedSecret, TypedSecretPlacer, PlacementCtx } from "../placement-types.js";
import { requireMetadata } from "../placement-types.js";
import {
  runKeyScan as defaultRunKeyScan,
  buildSshConfigBlock as defaultBuildSshConfigBlock,
  validateMetadataPath as defaultValidateMetadataPath,
} from "../placer-helpers.js";

/**
 * Dependency-injection shape for the ssh-private-key placer. Tests construct
 * a placer with stubbed deps to avoid hitting the network via ssh-keyscan.
 * Production callers use the singleton `sshPrivateKeyPlacer` below which is
 * wired to the real helpers.
 */
export interface SshPrivateKeyPlacerDeps {
  runKeyScan: typeof defaultRunKeyScan;
  buildSshConfigBlock: typeof defaultBuildSshConfigBlock;
  validateMetadataPath: typeof defaultValidateMetadataPath;
}

const DEFAULT_DEPS: SshPrivateKeyPlacerDeps = {
  runKeyScan: defaultRunKeyScan,
  buildSshConfigBlock: defaultBuildSshConfigBlock,
  validateMetadataPath: defaultValidateMetadataPath,
};

/**
 * Build an ssh-private-key placer with injectable dependencies. Exported
 * primarily for tests; production code should use `sshPrivateKeyPlacer`.
 */
export function _makeSshPrivateKeyPlacer(deps: Partial<SshPrivateKeyPlacerDeps> = {}): TypedSecretPlacer {
  const { runKeyScan, buildSshConfigBlock, validateMetadataPath } = { ...DEFAULT_DEPS, ...deps };
  return {
    type: "ssh-private-key",
    async place(secret: TypedSecret, ctx: PlacementCtx) {
      requireMetadata(secret, ["host"]);
      if (typeof secret.value !== "string") {
        throw new Error(`ssh-private-key '${secret.name}' has no value`);
      }
      const host = secret.metadata.host;
      const aliases = secret.metadata.aliases
        ? secret.metadata.aliases
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const username = secret.metadata.username || "git";
      const targetPath = secret.metadata.target_path || `~/.ssh/id_${secret.name.toLowerCase()}`;
      validateMetadataPath(targetPath);

      const expandedKeyPath = ctx.expandHome(targetPath);

      // 1. Write the private key with 0600 permissions. PEM keys MUST end
      // with a newline -- without it OpenSSL's libcrypto rejects the key
      // with "error in libcrypto" and ssh treats it as unloadable. Common
      // capture paths (`cat ~/.ssh/id_rsa | ark secrets set`) strip the
      // trailing newline through stdin, so guarantee one here.
      const keyBytes = Buffer.from(secret.value.endsWith("\n") ? secret.value : secret.value + "\n", "utf-8");
      await ctx.writeFile(expandedKeyPath, 0o600, keyBytes);

      // 2. Append the config block (idempotent via marker).
      const configBlock = buildSshConfigBlock({
        name: secret.name,
        host,
        aliases,
        keyPath: expandedKeyPath,
        username,
      });
      await ctx.appendFile(
        ctx.expandHome("~/.ssh/config"),
        `ark:secret:${secret.name}`,
        Buffer.from(configBlock, "utf-8"),
      );

      // 3. Append known_hosts entries (skip if ssh-keyscan returned nothing).
      const knownHosts = await runKeyScan([host, ...aliases]);
      if (knownHosts.length > 0) {
        await ctx.appendFile(ctx.expandHome("~/.ssh/known_hosts"), `ark:secret:${secret.name}`, knownHosts);
      }
    },
  };
}

/** Production placer wired to the real helpers. */
export const sshPrivateKeyPlacer: TypedSecretPlacer = _makeSshPrivateKeyPlacer();
