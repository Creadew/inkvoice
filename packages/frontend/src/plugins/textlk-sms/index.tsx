// text.lk SMS frontend registration: the /sms page (guarded by PluginGuard),
// its sidebar item under Extensions, i18n, and the settings panel shown in the
// plugin's detail view at /settings/plugins/textlk-sms.

import { MessageSquare } from "lucide-react";
import { registerNavItem } from "@/nav-registry";
import { registerRoute } from "@/route-registry";
import { PluginGuard } from "../PluginGuard";
import { registerPlugin } from "../registry";
import "./i18n";
import SmsPage from "./SmsPage";
import { SmsSettings } from "./SmsSettings";

const PLUGIN_ID = "textlk-sms";

registerRoute({
  path: "/sms",
  element: (
    <PluginGuard pluginId={PLUGIN_ID}>
      <SmsPage />
    </PluginGuard>
  ),
  scope: "protected",
});

registerNavItem({
  to: "/sms",
  labelKey: "textlk_sms.nav",
  icon: MessageSquare,
  section: "nav.plugins",
  pluginId: PLUGIN_ID,
});

registerPlugin({
  id: PLUGIN_ID,
  nameKey: "textlk_sms.name",
  descriptionKey: "textlk_sms.description",
  icon: MessageSquare,
  settings: SmsSettings,
});
