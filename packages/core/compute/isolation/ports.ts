/**
 * Auto-discovery for the workspace's user-declared ports.
 *
 * The legacy `arc.json` per-repo config used to carry an explicit `ports`
 * block. We deleted it: each workspace now has at most a `docker-compose.yml`
 * and/or `.devcontainer/devcontainer.json`, both of which already declare the
 * ports they want forwarded in their native formats. This module is the thin
 * unifier that reads from the two format-native helpers and dedupes.
 */

import { discoverDevcontainerPorts, type PortDecl } from "./devcontainer.js";
import { discoverComposePorts } from "./docker-compose.js";

/**
 * Merge ports from `.devcontainer/devcontainer.json` `forwardPorts` and
 * `docker-compose.yml` service ports. Duplicates (same port number) are
 * de-duplicated; the devcontainer entry wins because `forwardPorts` is the
 * more explicit signal -- compose ports are often a side-effect of how a
 * service self-publishes, while a devcontainer's `forwardPorts` is the
 * deliberate "expose this to the host" list.
 */
export function discoverWorkspacePorts(workdir: string): PortDecl[] {
  const all = [...discoverDevcontainerPorts(workdir), ...discoverComposePorts(workdir)];
  const seen = new Set<number>();
  return all.filter((p) => {
    if (seen.has(p.port)) return false;
    seen.add(p.port);
    return true;
  });
}

export type { PortDecl } from "./devcontainer.js";
