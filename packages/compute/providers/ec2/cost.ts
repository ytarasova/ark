/**
 * EC2 cost tracking - pricing tables and AWS Cost Explorer integration.
 */

import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";

// ── Pricing tables (us-east-1 on-demand, approximate) ───────────────────────

export const PRICING: Record<string, number> = {
  // Intel (m6i)
  "m6i.large": 0.096,
  "m6i.xlarge": 0.192,
  "m6i.2xlarge": 0.384,
  "m6i.4xlarge": 0.768,
  "m6i.8xlarge": 1.536,
  "m6i.12xlarge": 2.304,
  "m6i.16xlarge": 3.072,
  // ARM / Graviton (m6g)
  "m6g.large": 0.077,
  "m6g.xlarge": 0.154,
  "m6g.2xlarge": 0.308,
  "m6g.4xlarge": 0.616,
  "m6g.8xlarge": 1.232,
  "m6g.12xlarge": 1.848,
  "m6g.16xlarge": 2.464,
};

/** gp3 EBS cost per GB per month. */
export const EBS_GB_MONTH = 0.08;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Return the hourly on-demand rate for an instance type, or 0 if unknown.
 */
export function hourlyRate(instanceType: string): number {
  return PRICING[instanceType] ?? 0;
}

/**
 * Estimate daily cost: compute (hourly rate x 24) + storage (EBS pro-rated).
 */
export function estimateDailyCost(
  instanceType: string,
  diskGb: number,
): number {
  const compute = hourlyRate(instanceType) * 24;
  const storage = diskGb * EBS_GB_MONTH / 30;
  return compute + storage;
}

// ── Cost Explorer ───────────────────────────────────────────────────────────

interface CacheEntry {
  value: number;
  ts: number;
}

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const costCache = new Map<string, CacheEntry>();

/**
 * Query AWS Cost Explorer for the month-to-date cost of a host,
 * filtered by the Name tag "ark-{hostName}".
 *
 * Results are cached for 4 hours. Returns null on any error.
 */
export async function fetchAwsCost(
  hostName: string,
  opts?: { region?: string },
): Promise<number | null> {
  const cacheKey = `${hostName}:${opts?.region ?? "us-east-1"}`;
  const cached = costCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const client = new CostExplorerClient({
      region: opts?.region ?? "us-east-1",
    });

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    const startDate = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const endDate = `${tomorrow.getUTCFullYear()}-${String(tomorrow.getUTCMonth() + 1).padStart(2, "0")}-${String(tomorrow.getUTCDate()).padStart(2, "0")}`;

    const command = new GetCostAndUsageCommand({
      TimePeriod: { Start: startDate, End: endDate },
      Granularity: "MONTHLY",
      Metrics: ["BlendedCost"],
      Filter: {
        Tags: {
          Key: "Name",
          Values: [`ark-${hostName}`],
        },
      },
    });

    const resp = await client.send(command);
    const amount = parseFloat(
      resp.ResultsByTime?.[0]?.Total?.BlendedCost?.Amount ?? "0",
    );

    costCache.set(cacheKey, { value: amount, ts: Date.now() });
    return amount;
  } catch {
    return null;
  }
}
