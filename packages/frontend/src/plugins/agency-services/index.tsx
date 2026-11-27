// Agency Services frontend registration: the catalog, orders and
// subscriptions pages (each guarded by PluginGuard), their sidebar entries in
// an "Agency" section, i18n, and the settings panel shown in the plugin's
// detail view at /settings/plugins/agency-services.

import { Briefcase, CalendarClock, Layers, ShoppingBag } from "lucide-react";
import type { ReactElement } from "react";
import { registerNavItem } from "@/nav-registry";
import { registerRoute } from "@/route-registry";
import { PluginGuard } from "../PluginGuard";
import { registerPlugin } from "../registry";
import { AgencySettings } from "./AgencySettings";
import CatalogPage from "./CatalogPage";
import "./i18n";
import OrderBuilder from "./OrderBuilder";
import OrdersPage from "./OrdersPage";
import SubscriptionsPage from "./SubscriptionsPage";

const PLUGIN_ID = "agency-services";
const SECTION = "agency_services.section";

const guarded = (element: ReactElement) => (
  <PluginGuard pluginId={PLUGIN_ID}>{element}</PluginGuard>
);

// Optional :tab segments keep a page mounted while its tabs change.
registerRoute({
  path: "/agency/catalog/:tab?",
  element: guarded(<CatalogPage />),
  scope: "protected",
});
registerRoute({
  path: "/agency/orders/new",
  element: guarded(<OrderBuilder />),
  scope: "protected",
});
registerRoute({
  path: "/agency/orders/:tab?",
  element: guarded(<OrdersPage />),
  scope: "protected",
});
registerRoute({
  path: "/agency/subscriptions",
  element: guarded(<SubscriptionsPage />),
  scope: "protected",
});

registerNavItem({
  to: "/agency/catalog",
  labelKey: "agency_services.nav_catalog",
  icon: Layers,
  section: SECTION,
  pluginId: PLUGIN_ID,
});
registerNavItem({
  to: "/agency/orders",
  labelKey: "agency_services.nav_orders",
  icon: ShoppingBag,
  section: SECTION,
  pluginId: PLUGIN_ID,
});
registerNavItem({
  to: "/agency/subscriptions",
  labelKey: "agency_services.nav_subscriptions",
  icon: CalendarClock,
  section: SECTION,
  pluginId: PLUGIN_ID,
});

registerPlugin({
  id: PLUGIN_ID,
  nameKey: "agency_services.name",
  descriptionKey: "agency_services.description",
  icon: Briefcase,
  settings: AgencySettings,
});
