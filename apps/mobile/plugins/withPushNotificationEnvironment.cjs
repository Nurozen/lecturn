"use strict";

const { withEntitlementsPlist } = require("expo/config-plugins");

// Register before expo-widgets so this runs after its entitlement mod, which
// otherwise hardcodes development even for App Store builds.
module.exports = function withPushNotificationEnvironment(config, { mode }) {
  return withEntitlementsPlist(config, (cfg) => {
    cfg.modResults["aps-environment"] = mode;
    return cfg;
  });
};
