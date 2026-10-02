# Native packages

Private [NAPI-RS](https://napi.rs/) packages used by the Electron app:

| Package | Platform | Native integration |
| --- | --- | --- |
| `native/mac` | macOS | Window discovery, positioning, and fullscreen via CoreGraphics and Accessibility |
| `native/win` | Windows | Win32 window operations and icon extraction |
| `native/linux` | Linux | X11/XWayland window discovery, positioning, and fullscreen via EWMH |

The root `package.json` lists all three as optional file dependencies; npm picks the one matching the host's `os` field. Normal development just runs `npm install` from the repo root.

## Prerequisites

- Node.js, npm, and Rust/Cargo (`rustup` recommended)
- Repo JS dependencies: `npm install` from the root (also installs the NAPI-RS CLI)

Packages use Rust 2024 edition and NAPI9 bindings, with committed `Cargo.lock` files for reproducible builds.

## Building

Build on the OS you're targeting, from the package directory:

```sh
cd native/mac       # or native/win, native/linux
npm run build       # release build (npx napi build --platform --release)
npm run build:debug # debug build
```

This writes a `*.node` file into the package directory, loaded by that package's `index.js`. Declared targets:

- macOS: `aarch64-apple-darwin`, `x86_64-apple-darwin`
- Windows: `x86_64-pc-windows-msvc`
- Linux: `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`

## Platform notes

**macOS** — needs Xcode Command Line Tools (`xcode-select --install`). Links `ApplicationServices`, `CoreGraphics`, and `AppKit`. At runtime, grant the app Accessibility permission (**System Settings > Privacy & Security > Accessibility**) or focused-window reads/changes may return nothing.

**Windows** — needs the MSVC Rust toolchain (`rustup default stable-x86_64-pc-windows-msvc`) and Visual Studio Build Tools with **Desktop development with C++**. Uses Win32, COM, Shell, GDI, and DWM APIs; the GNU target isn't supported.

**Linux** — needs a glibc system with an X11 dev/runtime environment (uses `x11rb`, so no `libxcb` dev package needed). Requires an X11 display at runtime; XWayland-backed windows work, but native Wayland windows can't be moved/resized. musl-based distros (e.g. Alpine) aren't supported.

Building on a non-Linux host is a no-op — `native/linux/scripts/guard-build.js` skips `napi build` to protect the hand-written `index.js`/`index.d.ts` loader from a broken cross-build. Build Linux binaries on a real Linux machine or CI runner. Don't remove this guard unless cross-compilation is set up.

## Root project workflow

```sh
npm install   # resolves the matching native package and runs its install hook
npm run dev
```

The root `npm run build` only builds the Electron app — rebuild a native package from its own `native/<platform>` directory. `npm run dist` builds a Windows distributable (`electron-builder --win`); macOS and Linux packaging live in `electron-builder.yml` (`dist:linux`, `release:linux`).

## Generated files

Keep `*.node` binaries and NAPI-RS-generated `index.js`/`index.d.ts` with the package, except Linux's hand-written loader (never regenerate it from macOS/Windows). When changing Rust exports, update the TypeScript declarations and loader, then build and test on the target OS.

## Troubleshooting

**`napi: command not found`** — run `npm install` from the repo root.

**Native module won't load** — check the `*.node` file matches the OS/arch, then rebuild:

```sh
rm -rf native/<platform>/target native/<platform>/*.node
cd native/<platform> && npm run build
```

**Linux: no X11 window available** — confirm `DISPLAY` is set and an X11 server or XWayland is running; a pure Wayland session without XWayland windows isn't supported.
