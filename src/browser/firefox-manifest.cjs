'use strict';
const FIREFOX_EXTENSION_ID = 'flowdm@local.invalid';
function firefoxManifest(chromium) {
  return {
    manifest_version: 2,
    name: chromium.name,
    version: chromium.version,
    description: chromium.description,
    browser_specific_settings: { gecko: { id: FIREFOX_EXTENSION_ID, strict_min_version: '115.0' } },
    permissions: [...chromium.permissions, ...chromium.host_permissions],
    optional_permissions: [...chromium.optional_permissions, ...chromium.optional_host_permissions],
    background: { scripts: ['capture.js', 'media.js', 'background.js'], persistent: true },
    browser_action: structuredClone(chromium.action),
    content_scripts: structuredClone(chromium.content_scripts)
  };
}
module.exports = { firefoxManifest, FIREFOX_EXTENSION_ID };
