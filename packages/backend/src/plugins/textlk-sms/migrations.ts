import type { PluginMigration } from "../registry";

// text.lk SMS schema, tracked in plugin_schema_migrations under
// plugin_id = "textlk-sms". Config lives here rather than in the settings KV
// store so the API token never appears in GET /api/v1/settings.
export const textlkSmsMigrations: PluginMigration[] = [
  {
    version: 1,
    name: "textlk_sms_tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS textlk_sms_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT DEFAULT (datetime('now'))
        );

        -- One row per SMS attempt. ref_key makes automatic sends idempotent
        -- (e.g. "issued:<invoice_id>", "reminder:<rule_id>:<invoice_id>");
        -- custom and test sends leave it NULL.
        CREATE TABLE IF NOT EXISTS textlk_sms_log (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          event TEXT NOT NULL,
          ref_key TEXT UNIQUE,
          customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
          invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
          recipient TEXT NOT NULL,
          message TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          provider_uid TEXT,
          error TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_textlk_sms_log_created ON textlk_sms_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_textlk_sms_log_customer ON textlk_sms_log(customer_id);
        CREATE INDEX IF NOT EXISTS idx_textlk_sms_log_invoice ON textlk_sms_log(invoice_id);
      `);
    },
  },
];
