/**
 * YAML source: load `~/.ark/config.yaml` (or `{arkDir}/config.yaml`) and
 * produce a partial overrides object layered with profile-aware keys.
 *
 * Spring-style profile overlays:
 *
 *   # top-level defaults
 *   ports:
 *     conductor: 19100
 *   profiles:
 *     control-plane:
 *       ports:
 *         conductor: 19101
 *     test:
 *       # usually empty; test profile allocates its own ports dynamically.
 *
 * The top-level keys apply to every profile. Keys under `profiles.<name>`
 * merge on top of the top level when that profile is active. Missing file
 * or malformed YAML is non-fatal: we return an empty overrides object and
 * keep going.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { ArkProfile } from "./types.js";
import type { EnvOverrides } from "./env-source.js";

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function pickInt(x: unknown): number | undefined {
  return typeof x === "number" && Number.isInteger(x) ? x : undefined;
}

function pickBool(x: unknown): boolean | undefined {
  return typeof x === "boolean" ? x : undefined;
}

function pickStr(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined;
}

/** Extract partial overrides from a parsed YAML chunk. */
function chunkToOverrides(chunk: Record<string, unknown>): EnvOverrides {
  const out: EnvOverrides = {
    ports: {},
    channels: {},
    observability: {},
    auth: {},
    features: {},
    storage: {},
  };

  const ports = chunk.ports;
  if (isObj(ports)) {
    const c = pickInt(ports.conductor);
    if (c !== undefined) out.ports.conductor = c;
    const a = pickInt(ports.arkd);
    if (a !== undefined) out.ports.arkd = a;
    const s = pickInt(ports.server);
    if (s !== undefined) out.ports.server = s;
    const w = pickInt(ports.web);
    if (w !== undefined) out.ports.web = w;
  }

  const channels = chunk.channels;
  if (isObj(channels)) {
    const b = pickInt(channels.basePort ?? channels.base_port);
    if (b !== undefined) out.channels.basePort = b;
    const r = pickInt(channels.range);
    if (r !== undefined) out.channels.range = r;
  }

  const obs = chunk.observability;
  if (isObj(obs)) {
    const lvl = pickStr(obs.logLevel ?? obs.log_level);
    if (lvl === "debug" || lvl === "info" || lvl === "warn" || lvl === "error") {
      out.observability.logLevel = lvl;
    }
    const ep = pickStr(obs.otlpEndpoint ?? obs.otlp_endpoint);
    if (ep) out.observability.otlpEndpoint = ep;
  }

  const auth = chunk.auth;
  if (isObj(auth)) {
    const rt = pickBool(auth.requireToken ?? auth.require_token);
    if (rt !== undefined) out.auth.requireToken = rt;
    const dt = pickStr(auth.defaultTenant ?? auth.default_tenant);
    if (dt) out.auth.defaultTenant = dt;
  }

  const features = chunk.features;
  if (isObj(features)) {
    const ar = pickBool(features.autoRebase ?? features.auto_rebase);
    if (ar !== undefined) out.features.autoRebase = ar;
    const cg = pickBool(features.codegraph);
    if (cg !== undefined) out.features.codegraph = cg;
    const civ2 = pickBool(features.codeIntelV2 ?? features.code_intel_v2);
    if (civ2 !== undefined) out.features.codeIntelV2 = civ2;
  }

  const storage = chunk.storage;
  if (isObj(storage)) {
    const backend = pickStr(storage.blobBackend ?? storage.blob_backend);
    if (backend === "local" || backend === "s3") {
      out.storage.blobBackend = backend;
    }
    const s3 = storage.s3;
    if (isObj(s3)) {
      const bucket = pickStr(s3.bucket);
      const region = pickStr(s3.region);
      const prefix = pickStr(s3.prefix);
      const endpoint = pickStr(s3.endpoint);
      if (bucket || region || prefix || endpoint) {
        out.storage.s3 = {
          bucket: bucket ?? "",
          region: region ?? "",
          prefix,
          endpoint,
        };
      }
    }
  }

  const ark = pickStr(chunk.arkDir ?? chunk.ark_dir);
  if (ark) out.arkDir = ark;

  const db = pickStr(chunk.databaseUrl ?? chunk.database_url);
  if (db) out.databaseUrl = db;
  const redis = pickStr(chunk.redisUrl ?? chunk.redis_url);
  if (redis) out.redisUrl = redis;

  return out;
}

/**
 * Load `{arkDir}/config.yaml` if it exists and return profile-layered
 * overrides. Missing file / malformed YAML -> empty overrides.
 */
export function loadYamlOverrides(arkDir: string, profile: ArkProfile): EnvOverrides {
  const path = join(arkDir, "config.yaml");
  if (!existsSync(path)) return emptyOverrides();

  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(path, "utf-8")) ?? {};
  } catch {
    return emptyOverrides();
  }
  if (!isObj(parsed)) return emptyOverrides();

  // Top-level defaults
  const base = chunkToOverrides(parsed);

  // Profile overlay
  const profiles = parsed.profiles;
  if (isObj(profiles)) {
    const overlay = profiles[profile];
    if (isObj(overlay)) {
      return mergeOverrides(base, chunkToOverrides(overlay));
    }
  }

  return base;
}

function emptyOverrides(): EnvOverrides {
  return { ports: {}, channels: {}, observability: {}, auth: {}, features: {}, storage: {} };
}

/** Shallow-merge with `b` winning per section. */
export function mergeOverrides(a: EnvOverrides, b: EnvOverrides): EnvOverrides {
  return {
    arkDir: b.arkDir ?? a.arkDir,
    databaseUrl: b.databaseUrl ?? a.databaseUrl,
    redisUrl: b.redisUrl ?? a.redisUrl,
    ports: { ...a.ports, ...b.ports },
    channels: { ...a.channels, ...b.channels },
    observability: { ...a.observability, ...b.observability },
    auth: { ...a.auth, ...b.auth },
    features: { ...a.features, ...b.features },
    storage: {
      blobBackend: b.storage?.blobBackend ?? a.storage?.blobBackend,
      s3: b.storage?.s3 ?? a.storage?.s3,
    },
  };
}
