import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Safety } from "../shared/types.ts";

/** Where a category's data lives. */
export interface Source {
  /** Absolute directory. */
  dir: string;
  /** `children`: every direct entry is its own deletable item. `self`: the
   *  directory itself is the item. */
  mode: "children" | "self";
  /** `self` mode — the row's title. */
  title?: string;
  /** Shown as the subtitle of `children` rows. */
  subtitle?: string;
}

export interface CategorySpec {
  id: string;
  title: string;
  glyph: string;
  safety: Safety;
  consequence: string;
  sources: Source[];
}

/** Every folder Clean Xcode may show and delete from, in display order. */
export function categorySpecs(home: string): CategorySpec[] {
  const xcode = join(home, "Library", "Developer", "Xcode");
  const caches = join(home, "Library", "Caches");
  return [
    {
      id: "device-support",
      title: "Device Support",
      glyph: "📱",
      safety: "caution",
      consequence:
        "Xcode copies these debug symbols off the device again the next time you connect it — expect a few minutes of “Preparing debugger support”.",
      sources: ["iOS", "watchOS", "tvOS", "visionOS", "macOS"].map(
        (platform) => ({
          dir: join(xcode, `${platform} DeviceSupport`),
          mode: "children" as const,
          subtitle: platform,
        }),
      ),
    },
    {
      id: "derived-data",
      title: "Derived Data",
      glyph: "🧱",
      safety: "safe",
      consequence:
        "Build products and indexes. Xcode regenerates them on the next build, which will be a full rebuild.",
      sources: [{ dir: join(xcode, "DerivedData"), mode: "children" }],
    },
    {
      id: "archives",
      title: "Archives",
      glyph: "📦",
      safety: "caution",
      consequence:
        "Your archived app builds, including their dSYMs. They cannot be regenerated — keep any you might still upload or symbolicate.",
      sources: [{ dir: join(xcode, "Archives"), mode: "children" }],
    },
    {
      id: "documentation-cache",
      title: "Documentation Cache",
      glyph: "📚",
      safety: "safe",
      consequence:
        "Xcode rebuilds its documentation index when you next open it.",
      sources: [{ dir: join(xcode, "DocumentationCache"), mode: "children" }],
    },
    {
      id: "old-logs",
      title: "Old Logs",
      glyph: "🗒️",
      safety: "safe",
      consequence: "Device logs collected from connected devices.",
      sources: [{ dir: join(xcode, "DeviceLogs"), mode: "children" }],
    },
    {
      id: "other-caches",
      title: "Other Caches",
      glyph: "🗂️",
      safety: "safe",
      consequence:
        "Downloaded caches that Xcode and Swift Package Manager fetch again on demand.",
      sources: [
        {
          dir: join(caches, "org.swift.swiftpm"),
          mode: "self",
          title: "Swift Package Manager cache",
        },
        {
          dir: join(caches, "com.apple.dt.Xcode"),
          mode: "self",
          title: "Xcode cache",
        },
        {
          dir: join(home, "Library", "Developer", "CoreSimulator", "Caches"),
          mode: "self",
          title: "Simulator caches",
        },
      ],
    },
  ];
}

/** A discovered folder, before it has been sized. */
export interface Candidate {
  path: string;
  title: string;
  subtitle?: string;
  /** The `Source.dir` it was found under — what the cleaner checks against. */
  root: string;
  mode: Source["mode"];
}

/** `DerivedData/App-abcdefgh…` → `App`. */
export function derivedDataName(dirName: string): string {
  const cut = dirName.lastIndexOf("-");
  return cut > 0 ? dirName.slice(0, cut) : dirName;
}

/** `Cache from Xcode …` isn't derivable from the folder name (`v1919`), so name it by version. */
function label(categoryId: string, name: string): string {
  if (categoryId === "documentation-cache") return `Documentation ${name}`;
  if (categoryId === "derived-data") return derivedDataName(name);
  return name;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The folders that exist for `spec` — missing sources are skipped, so a Mac
 *  without Archives shows no "Archives" section rather than a zero row. */
export async function discover(spec: CategorySpec): Promise<Candidate[]> {
  const found: Candidate[] = [];
  for (const source of spec.sources) {
    if (!(await isDirectory(source.dir))) continue;
    if (source.mode === "self") {
      found.push({
        path: source.dir,
        title: source.title ?? basename(source.dir),
        root: source.dir,
        mode: "self",
      });
      continue;
    }
    let names: string[];
    try {
      names = await readdir(source.dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      found.push({
        path: join(source.dir, name),
        title: label(spec.id, name),
        subtitle: source.subtitle,
        root: source.dir,
        mode: "children",
      });
    }
  }
  return found;
}
