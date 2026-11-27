// Plugin configuration, one JSON document in agency_config. Missing fields fall
// back to DEFAULT_CONFIG, so adding a field later needs no data migration.

import { getDb } from "../../database/connection";

export interface AgencyConfig {
  /** Renewal invoices are created this many days before the renewal date. */
  lead_days: number;
  /** Issue and email renewal invoices instead of leaving drafts for review. */
  auto_send: boolean;
  /** One invoice per client for renewals falling due in the same run. */
  bundle: boolean;
}

export const DEFAULT_CONFIG: AgencyConfig = {
  lead_days: 14,
  auto_send: false,
  bundle: true,
};

const KEY = "config";

export function getConfig(): AgencyConfig {
  const row = getDb().query("SELECT value FROM agency_config WHERE key = ?").get(KEY) as {
    value: string;
  } | null;
  let stored: Partial<AgencyConfig> = {};
  if (row) {
    try {
      stored = JSON.parse(row.value) as Partial<AgencyConfig>;
    } catch {
      stored = {};
    }
  }
  return { ...DEFAULT_CONFIG, ...stored };
}

export function updateConfig(update: Partial<AgencyConfig>): AgencyConfig {
  const next: AgencyConfig = { ...getConfig(), ...update };
  getDb().run(
    `INSERT INTO agency_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [KEY, JSON.stringify(next)],
  );
  return next;
}
