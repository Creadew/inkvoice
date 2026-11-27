import type { PluginMigration } from "../registry";

// Agency Services schema, tracked in plugin_schema_migrations under
// plugin_id = "agency-services". Every reference into core tables carries an
// ON DELETE action: foreign keys are enforced, and a plugin row must never
// block a core delete (a customer, an invoice, a tax rate, a product).
export const agencyServicesMigrations: PluginMigration[] = [
  {
    version: 1,
    name: "agency_services_tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agency_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT DEFAULT (datetime('now'))
        );

        -- The service catalog: packages, add-ons and standalone services.
        -- features is a JSON array of strings. product_id links the core
        -- product kept in sync with this item, so invoice lines carry it and
        -- the product reports group renewals under one name.
        CREATE TABLE IF NOT EXISTS agency_items (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'other',
          description TEXT,
          features TEXT NOT NULL DEFAULT '[]',
          billing TEXT NOT NULL DEFAULT 'one_time',
          price REAL NOT NULL DEFAULT 0,
          setup_fee REAL NOT NULL DEFAULT 0,
          interval_unit TEXT,
          interval_count INTEGER NOT NULL DEFAULT 1,
          unit TEXT NOT NULL DEFAULT 'piece',
          tax_id TEXT REFERENCES tax_definitions(id) ON DELETE SET NULL,
          product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        -- Which add-ons a package offers. 'included' add-ons come with the
        -- package; a recurring one is free for free_months, then billed.
        CREATE TABLE IF NOT EXISTS agency_package_addons (
          package_id TEXT NOT NULL REFERENCES agency_items(id) ON DELETE CASCADE,
          addon_id TEXT NOT NULL REFERENCES agency_items(id) ON DELETE CASCADE,
          mode TEXT NOT NULL DEFAULT 'optional',
          free_months INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (package_id, addon_id)
        );

        -- A sale built from the catalog. lines is the JSON snapshot the
        -- quote or invoice was made from; activating a quoted order turns
        -- its recurring lines into subscriptions. initial_total is what the
        -- first document bills (one-time lines, setup fees, first periods).
        CREATE TABLE IF NOT EXISTS agency_orders (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'quoted',
          title TEXT NOT NULL,
          currency TEXT NOT NULL,
          lines TEXT NOT NULL,
          initial_total REAL NOT NULL DEFAULT 0,
          monthly_recurring REAL NOT NULL DEFAULT 0,
          notes TEXT,
          quote_id TEXT REFERENCES quotes(id) ON DELETE SET NULL,
          invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
          start_date TEXT,
          activated_at TEXT,
          created_by TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        -- A client's recurring service. next_billing_date is the first day of
        -- the next period to invoice (the renewal date); anchor_day keeps a
        -- monthly renewal on the 31st from drifting to the 28th for good.
        CREATE TABLE IF NOT EXISTS agency_subscriptions (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          item_id TEXT REFERENCES agency_items(id) ON DELETE SET NULL,
          order_id TEXT REFERENCES agency_orders(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          reference TEXT,
          category TEXT NOT NULL DEFAULT 'other',
          price REAL NOT NULL DEFAULT 0,
          quantity REAL NOT NULL DEFAULT 1,
          currency TEXT NOT NULL,
          tax_id TEXT REFERENCES tax_definitions(id) ON DELETE SET NULL,
          interval_unit TEXT NOT NULL,
          interval_count INTEGER NOT NULL DEFAULT 1,
          start_date TEXT NOT NULL,
          next_billing_date TEXT NOT NULL,
          anchor_day INTEGER NOT NULL,
          end_date TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          notes TEXT,
          last_invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
          last_billed_at TEXT,
          cancelled_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        -- One row per billed period: the billing history, and the guard that
        -- stops the same period being invoiced twice.
        CREATE TABLE IF NOT EXISTS agency_billing_log (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          subscription_id TEXT NOT NULL REFERENCES agency_subscriptions(id) ON DELETE CASCADE,
          invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
          period_start TEXT NOT NULL,
          period_end TEXT NOT NULL,
          amount REAL NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE (subscription_id, period_start)
        );

        CREATE INDEX IF NOT EXISTS idx_agency_items_kind ON agency_items(kind, is_active);
        CREATE INDEX IF NOT EXISTS idx_agency_pairs_addon ON agency_package_addons(addon_id);
        CREATE INDEX IF NOT EXISTS idx_agency_orders_customer ON agency_orders(customer_id);
        CREATE INDEX IF NOT EXISTS idx_agency_orders_status ON agency_orders(status);
        CREATE INDEX IF NOT EXISTS idx_agency_subs_customer ON agency_subscriptions(customer_id);
        CREATE INDEX IF NOT EXISTS idx_agency_subs_due ON agency_subscriptions(status, next_billing_date);
        CREATE INDEX IF NOT EXISTS idx_agency_billing_sub ON agency_billing_log(subscription_id);
      `);
    },
  },
];
