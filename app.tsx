import { definePluginApp } from "@bb/plugin-sdk/app";

const CSS_CLASS_TOKENS = "relative";

export default definePluginApp((app) => {
  app.slots.sidebarFooterAction({
    id: "bb-collab-settings",
    title: "bb-collab settings",
    icon: "Settings",
    run: ({ openSettings }) => openSettings(),
  });
});
