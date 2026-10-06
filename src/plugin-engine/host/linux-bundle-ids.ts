/**
 * Raycast extensions find apps by macOS bundle id —
 * `getApplications().find((a) => a.bundleId === "com.microsoft.VSCode")`,
 * `open(url, "com.google.Chrome")`. On Linux an app's identity is its
 * desktop file ID, so `getApplications()` reports the macOS bundle id for
 * the apps below (deb/rpm, snap and Flatpak names alike) and the desktop ID
 * for everything else.
 */
const MAC_BUNDLE_IDS: Record<string, string[]> = {
  // Editors
  "com.microsoft.VSCode": ["code", "com.visualstudio.code", "code_code"],
  "com.microsoft.VSCodeInsiders": ["code-insiders"],
  "com.vscodium": ["codium", "com.vscodium.codium"],
  "com.todesktop.230313mzl4w4u92": ["cursor", "co.anysphere.cursor"],
  "com.exafunction.windsurf": ["windsurf"],
  "dev.zed.Zed": ["dev.zed.zed", "zed"],
  "com.sublimetext.4": ["sublime_text", "com.sublimetext.three"],
  "com.jetbrains.toolbox": ["jetbrains-toolbox"],
  // Browsers
  "com.google.Chrome": ["google-chrome", "com.google.chrome"],
  "com.google.Chrome.beta": ["google-chrome-beta"],
  "com.google.Chrome.dev": ["google-chrome-unstable"],
  "org.chromium.Chromium": [
    "chromium",
    "chromium-browser",
    "chromium_chromium",
    "org.chromium.chromium",
  ],
  "org.mozilla.firefox": ["firefox", "firefox_firefox", "org.mozilla.firefox"],
  "org.mozilla.firefoxdeveloperedition": ["firefox-developer-edition"],
  "org.mozilla.librewolf": ["librewolf", "io.gitlab.librewolf-community"],
  "com.brave.Browser": ["brave-browser", "brave_brave", "com.brave.browser"],
  "com.microsoft.edgemac": ["microsoft-edge", "com.microsoft.edge"],
  "com.microsoft.edgemac.Beta": ["microsoft-edge-beta"],
  "com.microsoft.edgemac.Dev": ["microsoft-edge-dev"],
  "com.vivaldi.Vivaldi": ["vivaldi-stable", "vivaldi", "com.vivaldi.vivaldi"],
  "com.operasoftware.Opera": ["opera", "com.opera.opera"],
  "app.zen-browser.zen": ["zen", "zen-browser", "app.zen_browser.zen"],
  // Terminals
  "net.kovidgoyal.kitty": ["kitty"],
  "com.mitchellh.ghostty": ["com.mitchellh.ghostty", "ghostty"],
  "dev.warp.Warp-Stable": ["dev.warp.warp", "warp-terminal"],
  "org.alacritty": ["alacritty", "org.alacritty.alacritty"],
  "com.github.wez.wezterm": ["org.wezfurlong.wezterm", "wezterm"],
  // Everything else
  "com.spotify.client": ["spotify", "spotify_spotify", "com.spotify.client"],
  "com.tinyspeck.slackmacgap": ["slack", "slack_slack", "com.slack.slack"],
  "com.hnc.Discord": ["discord", "discord_discord", "com.discordapp.discord"],
  "md.obsidian": ["obsidian", "obsidian_obsidian", "md.obsidian.obsidian"],
  "com.todoist.mac.Todoist": [
    "todoist",
    "todoist_todoist",
    "com.todoist.todoist",
  ],
  "us.zoom.xos": ["zoom", "zoom-client_zoom-client", "us.zoom.zoom"],
  "ru.keepcoder.Telegram": [
    "org.telegram.desktop",
    "telegram-desktop_telegram-desktop",
  ],
  "org.whispersystems.signal-desktop": ["signal-desktop", "org.signal.signal"],
  "com.1password.1password": ["1password", "com.onepassword.onepassword"],
  "org.mozilla.thunderbird": ["thunderbird", "org.mozilla.thunderbird"],
  "com.figma.Desktop": ["figma-linux", "io.github.figma_linux.figma_linux"],
  "notion.id": ["notion-app", "notion-snap-reborn_notion-snap-reborn"],
};

const BY_DESKTOP_ID = new Map<string, string>(
  Object.entries(MAC_BUNDLE_IDS).flatMap(([bundleId, desktopIds]) =>
    desktopIds.map((id): [string, string] => [id.toLowerCase(), bundleId]),
  ),
);

/** The macOS bundle id extensions know `desktopId`'s app by, if any. */
export function macBundleIdFor(desktopId: string): string | undefined {
  return BY_DESKTOP_ID.get(desktopId.toLowerCase());
}
