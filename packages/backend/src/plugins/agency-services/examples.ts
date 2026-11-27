// A starter catalog for a web, marketing, software and design agency, loaded
// on request from the empty catalog so the structure (packages with feature
// lists, included hosting and domain, recurring retainers) is there to edit
// rather than to invent. Prices are placeholders: rupee amounts when the base
// currency is LKR, dollar-scale amounts for any other currency.

import { getDb } from "../../database/connection";
import { getBaseCurrency } from "../../services/exchange-rate.service";
import {
  type Billing,
  type CatalogItem,
  type Category,
  catalogIsEmpty,
  createItem,
  type ItemKind,
  listItems,
  setPackageAddons,
} from "./catalog";
import type { IntervalUnit } from "./periods";

interface Example {
  key: string;
  kind: ItemKind;
  name: string;
  category: Category;
  description?: string;
  features?: string[];
  billing?: Billing;
  /** [LKR, other currencies] */
  price: [number, number];
  setup_fee?: [number, number];
  interval_unit?: IntervalUnit;
  unit?: string;
}

const EXAMPLES: Example[] = [
  // Add-ons first, so packages can pair with them.
  {
    key: "domain_lk",
    kind: "addon",
    name: ".lk domain name",
    category: "domains",
    description: "Registration or renewal of a .lk domain name.",
    billing: "recurring",
    interval_unit: "year",
    price: [5500, 40],
  },
  {
    key: "domain_com",
    kind: "addon",
    name: ".com domain name",
    category: "domains",
    billing: "recurring",
    interval_unit: "year",
    price: [4500, 18],
  },
  {
    key: "hosting_basic",
    kind: "addon",
    name: "Web hosting – Basic",
    category: "hosting",
    features: ["5 GB SSD storage", "5 email accounts", "Free SSL certificate", "Daily backups"],
    billing: "recurring",
    interval_unit: "year",
    price: [12000, 60],
  },
  {
    key: "hosting_business",
    kind: "addon",
    name: "Web hosting – Business",
    category: "hosting",
    features: [
      "20 GB SSD storage",
      "25 email accounts",
      "Free SSL certificate",
      "Daily backups",
      "Priority support",
    ],
    billing: "recurring",
    interval_unit: "year",
    price: [24000, 120],
  },
  {
    key: "amc",
    kind: "addon",
    name: "Annual maintenance",
    category: "maintenance",
    features: [
      "Core, plugin and security updates",
      "Monthly backups and uptime monitoring",
      "Up to 12 content updates a year",
      "Priority bug fixes",
    ],
    billing: "recurring",
    interval_unit: "year",
    price: [30000, 200],
  },
  {
    key: "extra_page",
    kind: "addon",
    name: "Additional page",
    category: "web_design",
    price: [5000, 35],
    unit: "page",
  },
  {
    key: "multilingual",
    kind: "addon",
    name: "Sinhala / Tamil language version",
    category: "web_design",
    description: "The whole site in a second language, with a language switcher.",
    price: [25000, 175],
  },
  {
    key: "payments",
    kind: "addon",
    name: "Online payment gateway integration",
    category: "development",
    description: "PayHere, card or bank payment gateway set up and tested.",
    price: [20000, 150],
  },
  {
    key: "logo",
    kind: "addon",
    name: "Logo design",
    category: "graphic_design",
    features: ["3 concepts", "2 revision rounds", "PNG, SVG and PDF files"],
    price: [15000, 100],
  },
  {
    key: "gbp",
    kind: "addon",
    name: "Google Business Profile setup",
    category: "marketing",
    price: [7500, 50],
  },

  // Packages.
  {
    key: "web_starter",
    kind: "package",
    name: "Starter Website",
    category: "web_design",
    features: [
      "Up to 5 pages",
      "Mobile-friendly design",
      "Contact form and Google Maps",
      "Basic on-page SEO",
      "Social media links",
      "1 revision round",
    ],
    price: [45000, 300],
  },
  {
    key: "web_business",
    kind: "package",
    name: "Business Website",
    category: "web_design",
    features: [
      "Up to 12 pages",
      "Custom design to your brand",
      "Blog or news section",
      "Contact and quote request forms",
      "On-page SEO and Google Search Console",
      "Google Analytics setup",
      "WhatsApp chat button",
      "3 revision rounds",
    ],
    price: [95000, 650],
  },
  {
    key: "web_shop",
    kind: "package",
    name: "E-commerce Website",
    category: "web_design",
    features: [
      "Up to 100 products",
      "Online payments",
      "Order and stock management",
      "Delivery zones and shipping rates",
      "Customer accounts",
      "Staff training session",
    ],
    price: [185000, 1200],
  },
  {
    key: "brand_identity",
    kind: "package",
    name: "Brand Identity",
    category: "graphic_design",
    features: [
      "Logo (3 concepts, 3 revision rounds)",
      "Colour palette and typography",
      "Business card and letterhead",
      "Brand guidelines PDF",
      "Source files",
    ],
    price: [60000, 400],
  },
  {
    key: "smm_starter",
    kind: "package",
    name: "Social Media – Starter",
    category: "marketing",
    features: [
      "Facebook and Instagram",
      "12 designed posts a month",
      "Monthly content calendar",
      "Community management (business hours)",
      "Monthly performance report",
    ],
    billing: "recurring",
    interval_unit: "month",
    price: [35000, 250],
    setup_fee: [10000, 75],
  },
  {
    key: "smm_growth",
    kind: "package",
    name: "Social Media – Growth",
    category: "marketing",
    features: [
      "Facebook, Instagram and TikTok",
      "20 posts and 4 reels a month",
      "Paid campaign management (ad spend billed separately)",
      "Monthly strategy call",
      "Monthly performance report",
    ],
    billing: "recurring",
    interval_unit: "month",
    price: [65000, 450],
    setup_fee: [15000, 100],
  },

  // Standalone services.
  {
    key: "dev_hourly",
    kind: "service",
    name: "Custom software development",
    category: "development",
    description: "Bespoke web apps, integrations and automation, billed by the hour.",
    price: [4500, 30],
    unit: "hour",
  },
  {
    key: "uiux",
    kind: "service",
    name: "UI/UX design",
    category: "graphic_design",
    description: "App or website screens designed in Figma, billed per screen.",
    price: [6000, 40],
    unit: "screen",
  },
  {
    key: "post_design",
    kind: "service",
    name: "Social media post design",
    category: "graphic_design",
    price: [2500, 20],
    unit: "post",
  },
  {
    key: "seo",
    kind: "service",
    name: "SEO retainer",
    category: "marketing",
    features: [
      "Keyword research and rank tracking",
      "On-page optimisation",
      "2 blog articles a month",
      "Monthly ranking report",
    ],
    billing: "recurring",
    interval_unit: "month",
    price: [40000, 300],
  },
  {
    key: "ads",
    kind: "service",
    name: "Google Ads management",
    category: "marketing",
    description: "Campaign setup, optimisation and reporting. Ad spend is billed separately.",
    billing: "recurring",
    interval_unit: "month",
    price: [25000, 175],
  },
  {
    key: "support",
    kind: "service",
    name: "Website care plan",
    category: "maintenance",
    features: ["Updates and backups", "Uptime monitoring", "1 hour of changes a month"],
    billing: "recurring",
    interval_unit: "month",
    price: [5000, 35],
  },
];

type Pairing = [addon: string, mode: "optional" | "included", freeMonths?: number];

const PAIRINGS: Record<string, Pairing[]> = {
  web_starter: [
    ["domain_lk", "included", 12],
    ["hosting_basic", "included", 12],
    ["extra_page", "optional"],
    ["logo", "optional"],
    ["gbp", "optional"],
    ["domain_com", "optional"],
    ["amc", "optional"],
  ],
  web_business: [
    ["domain_lk", "included", 12],
    ["hosting_business", "included", 12],
    ["extra_page", "optional"],
    ["multilingual", "optional"],
    ["payments", "optional"],
    ["logo", "optional"],
    ["gbp", "optional"],
    ["domain_com", "optional"],
    ["amc", "optional"],
  ],
  web_shop: [
    ["domain_lk", "included", 12],
    ["hosting_business", "included", 12],
    ["payments", "included"],
    ["extra_page", "optional"],
    ["multilingual", "optional"],
    ["domain_com", "optional"],
    ["amc", "optional"],
  ],
  brand_identity: [["gbp", "optional"]],
  smm_starter: [["gbp", "optional"]],
  smm_growth: [["gbp", "optional"]],
};

/** Load the example catalog into an empty catalog. Returns null when the
 *  catalog already has items, so it can never mix into real data. */
export function seedExampleCatalog(): CatalogItem[] | null {
  if (!catalogIsEmpty()) return null;
  const column = getBaseCurrency().toUpperCase() === "LKR" ? 0 : 1;
  const ids = new Map<string, string>();

  getDb().transaction(() => {
    for (const ex of EXAMPLES) {
      const item = createItem({
        kind: ex.kind,
        name: ex.name,
        category: ex.category,
        description: ex.description ?? null,
        features: ex.features ?? [],
        billing: ex.billing ?? "one_time",
        price: ex.price[column],
        setup_fee: ex.setup_fee?.[column] ?? 0,
        interval_unit: ex.interval_unit ?? null,
        interval_count: 1,
        unit: ex.unit,
      });
      ids.set(ex.key, item.id);
    }
    for (const [pkg, pairs] of Object.entries(PAIRINGS)) {
      setPackageAddons(
        ids.get(pkg)!,
        pairs.map(([addon, mode, freeMonths]) => ({
          addon_id: ids.get(addon)!,
          mode,
          free_months: freeMonths ?? 0,
        })),
      );
    }
  })();

  return listItems();
}
