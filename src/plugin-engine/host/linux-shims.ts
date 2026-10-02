/**
 * Stand-ins for macOS command-line tools that Raycast extensions shell out
 * to, put on the plugin hosts' PATH on Linux only. Ordinary Unix tools (git,
 * curl, grep…) already exist there; these cover the macOS-only ones that have
 * a sensible Linux equivalent, and make `osascript` fail with an explanation
 * rather than a bare ENOENT.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const OPEN = `#!/bin/sh
# macOS \`open\`: drop -a/-b <app> and flags, hand the targets to xdg-open.
status=0
while [ $# -gt 0 ]; do
  case "$1" in
    -a|-b|--args) shift; [ $# -gt 0 ] && shift; continue ;;
    -*) shift; continue ;;
  esac
  xdg-open "$1" || status=$?
  shift
done
exit $status
`;

const PBCOPY = `#!/bin/sh
if [ -n "$WAYLAND_DISPLAY" ] && command -v wl-copy >/dev/null 2>&1; then exec wl-copy
elif command -v xclip >/dev/null 2>&1; then exec xclip -selection clipboard
elif command -v xsel >/dev/null 2>&1; then exec xsel --clipboard --input
fi
echo "pbcopy: install wl-clipboard, xclip or xsel" >&2
exit 127
`;

const PBPASTE = `#!/bin/sh
if [ -n "$WAYLAND_DISPLAY" ] && command -v wl-paste >/dev/null 2>&1; then exec wl-paste --no-newline
elif command -v xclip >/dev/null 2>&1; then exec xclip -selection clipboard -o
elif command -v xsel >/dev/null 2>&1; then exec xsel --clipboard --output
fi
echo "pbpaste: install wl-clipboard, xclip or xsel" >&2
exit 127
`;

const OSASCRIPT = `#!/bin/sh
echo "osascript: AppleScript isn't available on Linux — this Raycast extension feature only works on macOS" >&2
exit 1
`;

export const LINUX_SHIMS: Record<string, string> = {
  open: OPEN,
  pbcopy: PBCOPY,
  pbpaste: PBPASTE,
  osascript: OSASCRIPT,
};

/** Writes the shims (idempotently) and returns their directory. */
export function ensureLinuxShimDir(
  base: string = join(tmpdir(), `magibar-shims-${process.getuid?.() ?? 0}`),
): string {
  mkdirSync(base, { recursive: true, mode: 0o700 });
  for (const [name, body] of Object.entries(LINUX_SHIMS)) {
    const file = join(base, name);
    writeFileSync(file, body, { mode: 0o755 });
    chmodSync(file, 0o755);
  }
  return base;
}

/** `PATH` with the shim directory *after* the real one, so a real `open` or
 *  `pbcopy` (there are none on stock Linux) would still win. */
export function withLinuxShimPath(
  path: string | undefined,
  shimDir: string,
): string {
  return path ? `${path}${delimiter}${shimDir}` : shimDir;
}
