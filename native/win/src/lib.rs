#![cfg(windows)]
//! Native Windows icon extraction for magibar-launcher.
//!
//! Replaces a PowerShell script that shelled out to `powershell.exe` and JIT-compiled
//! an embedded C# helper via `Add-Type` on every app-list refresh. `Electron`'s
//! `app.getFileIcon()` (backed by Chromium's `SHGetFileInfo`) unreliably falls back to
//! the generic "unknown file" icon for some executables even though they have a proper
//! embedded icon resource; `ExtractIconEx` reads the resource directly and is reliable
//! where `SHGetFileInfo` is not. Packaged (MSIX/UWP) apps have no PE icon resource at
//! all, so their icon has to come from the shell via `IShellItemImageFactory`, and their
//! list comes from enumerating the virtual `shell:AppsFolder`.

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use windows::core::{Interface, PCWSTR, HSTRING};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{
  CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDIBits, SelectObject,
  BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ
};
use windows::Win32::Storage::EnhancedStorage::{PKEY_AppUserModel_ID, PKEY_ItemNameDisplay};
use windows::Win32::UI::Input::KeyboardAndMouse::{
  SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY
};
use windows::Win32::System::Com::{
  CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
  CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ
};
use windows::Win32::System::DataExchange::{
  AddClipboardFormatListener, RemoveClipboardFormatListener
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::{
  BHID_EnumItems, ExtractIconExW, IEnumShellItems, IShellItem, IShellItem2, IShellItemImageFactory,
  IShellLinkW, SHCreateItemFromParsingName, ShellLink, SIGDN_NORMALDISPLAY, SIIGBF_RESIZETOFIT,
  SLGP_RAWPATH
};
use windows::Win32::UI::WindowsAndMessaging::{
  CallNextHookEx, CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyWindow, DispatchMessageW,
  DrawIconEx, GetForegroundWindow, GetMessageW, GetWindowLongPtrW, GetWindowRect, IsIconic,
  IsZoomed, PostMessageW, PostQuitMessage, RegisterClassExW, SetForegroundWindow,
  SetWindowLongPtrW, SetWindowPos, SetWindowsHookExW, ShowWindow, TranslateMessage,
  UnhookWindowsHookEx, DI_NORMAL, GWLP_USERDATA, HHOOK, HICON, HWND_MESSAGE, KBDLLHOOKSTRUCT,
  LLKHF_INJECTED, MSG, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER, SW_MAXIMIZE, SW_RESTORE,
  WH_KEYBOARD_LL, WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLIPBOARDUPDATE, WM_CLOSE, WM_DESTROY,
  WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WNDCLASSEXW
};

/// COM must be initialized on whatever thread calls into these APIs. napi-rs runs
/// `#[napi]` functions on the JS thread by default, which is a single, stable OS
/// thread for the lifetime of the process, so initializing once per call (ignoring
/// "already initialized") and never uninitializing is fine here — this module never
/// runs off-thread.
struct ComGuard(bool);

impl ComGuard {
  fn new() -> Self {
    // S_FALSE ("already initialized on this thread") and RPC_E_CHANGED_MODE both mean
    // we must not pair this with CoUninitialize; only tear down on a clean S_OK init.
    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    Self(hr.is_ok())
  }
}

impl Drop for ComGuard {
  fn drop(&mut self) {
    if self.0 {
      unsafe { CoUninitialize() };
    }
  }
}

/// Converts an HICON to PNG bytes by drawing it onto a top-down 32bpp DIB section and
/// reading the pixels back directly, which (unlike GDI+'s `Icon.ToBitmap()`) preserves
/// per-pixel alpha for modern 32-bit ARGB icons. Falls back to the icon's AND mask for
/// legacy icons that carry no real alpha channel (mask-only transparency).
fn hicon_to_png(hicon: HICON, width: i32, height: i32) -> Option<Vec<u8>> {
  unsafe {
    let hdc_screen = CreateCompatibleDC(None);
    if hdc_screen.is_invalid() {
      return None;
    }
    let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
    if hdc_mem.is_invalid() {
      let _ = DeleteDC(hdc_screen);
      return None;
    }

    let bmi = BITMAPINFO {
      bmiHeader: BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height, // negative = top-down DIB, so row 0 is the top row
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
      },
      ..Default::default()
    };

    let mut bits_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
    let hbitmap = match CreateDIBSection(Some(hdc_screen), &bmi, DIB_RGB_COLORS, &mut bits_ptr, None, 0) {
      Ok(h) if !h.is_invalid() && !bits_ptr.is_null() => h,
      other => {
        eprintln!("[win-icons] CreateDIBSection failed: {other:?}");
        let _ = DeleteDC(hdc_mem);
        let _ = DeleteDC(hdc_screen);
        return None;
      }
    };

    let prev = SelectObject(hdc_mem, HGDIOBJ(hbitmap.0));
    // Icons can have transparent regions; make sure we start from a cleared (fully
    // transparent) buffer rather than whatever CreateDIBSection happened to allocate.
    std::ptr::write_bytes(bits_ptr as *mut u8, 0, (width as usize) * (height as usize) * 4);
    if let Err(e) = DrawIconEx(hdc_mem, 0, 0, hicon, width, height, 0, None, DI_NORMAL) {
      eprintln!("[win-icons] DrawIconEx failed: {e:?}");
    }

    let pixel_count = (width as usize) * (height as usize);
    let mut bgra = vec![0u8; pixel_count * 4];
    std::ptr::copy_nonoverlapping(bits_ptr as *const u8, bgra.as_mut_ptr(), bgra.len());

    let has_alpha = bgra.chunks_exact(4).any(|px| px[3] != 0);
    if !has_alpha {
      // Legacy icon with no real alpha channel: fall back to the icon's AND mask via
      // GetIconInfo so masked-out pixels are still transparent instead of opaque black.
      apply_and_mask_alpha(hicon, width, height, &mut bgra);
    }

    SelectObject(hdc_mem, prev);
    let _ = DeleteObject(HGDIOBJ(hbitmap.0));
    let _ = DeleteDC(hdc_mem);
    let _ = DeleteDC(hdc_screen);

    let mut rgba = bgra;
    for px in rgba.chunks_exact_mut(4) {
      px.swap(0, 2); // BGRA -> RGBA
    }

    let Some(image) = image::RgbaImage::from_raw(width as u32, height as u32, rgba) else {
      eprintln!("[win-icons] RgbaImage::from_raw failed (w={width} h={height})");
      return None;
    };
    let mut out = Vec::new();
    if let Err(e) = image.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png) {
      eprintln!("[win-icons] PNG encode failed: {e:?}");
      return None;
    }
    Some(out)
  }
}

fn apply_and_mask_alpha(hicon: HICON, width: i32, height: i32, bgra: &mut [u8]) {
  use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

  unsafe {
    let mut info = ICONINFO::default();
    if GetIconInfo(hicon, &mut info).is_err() {
      return;
    }
    if !info.hbmColor.is_invalid() {
      let _ = DeleteObject(HGDIOBJ(info.hbmColor.0));
    }
    if info.hbmMask.is_invalid() {
      return;
    }

    // The AND mask is a 1bpp DIB; for icons with no separate XOR mask its height is
    // 2x the icon height (color rows followed by mask rows) — request just the mask.
    let hdc = CreateCompatibleDC(None);
    let stride = ((width + 31) / 32) * 4; // 1bpp rows are DWORD-aligned
    let mut mask_bits = vec![0u8; (stride as usize) * (height as usize)];
    let mut mask_bmi = BITMAPINFO {
      bmiHeader: BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 1,
        biCompression: BI_RGB.0,
        ..Default::default()
      },
      ..Default::default()
    };
    let got = GetDIBits(
      hdc,
      info.hbmMask,
      0,
      height as u32,
      Some(mask_bits.as_mut_ptr() as *mut core::ffi::c_void),
      &mut mask_bmi,
      DIB_RGB_COLORS
    );
    let _ = DeleteObject(HGDIOBJ(info.hbmMask.0));
    let _ = DeleteDC(hdc);
    if got == 0 {
      return;
    }

    for y in 0..height as usize {
      for x in 0..width as usize {
        let byte = mask_bits[y * stride as usize + x / 8];
        let bit_set = (byte >> (7 - (x % 8))) & 1 == 1; // 1 = transparent in an AND mask
        let idx = (y * width as usize + x) * 4;
        bgra[idx + 3] = if bit_set { 0 } else { 255 };
      }
    }
  }
}

/// Extracts the icon embedded in a PE file (.exe/.dll) at the given resource index and
/// returns it as PNG bytes, or `null` if the file has no icon at that index.
#[napi]
pub fn extract_icon_png(path: String, index: i32) -> Option<Buffer> {
  let _com = ComGuard::new();
  let wpath = HSTRING::from(&path);
  unsafe {
    let mut large: [HICON; 1] = [HICON::default()];
    let mut small: [HICON; 1] = [HICON::default()];
    let count = ExtractIconExW(&wpath, index, Some(large.as_mut_ptr()), Some(small.as_mut_ptr()), 1);
    if count == 0 {
      return None;
    }

    let (hicon, size) = if !large[0].is_invalid() {
      (large[0], 32)
    } else if !small[0].is_invalid() {
      (small[0], 16)
    } else {
      return None;
    };

    let png = hicon_to_png(hicon, size, size);
    if !large[0].is_invalid() {
      let _ = DestroyIcon(large[0]);
    }
    if !small[0].is_invalid() {
      let _ = DestroyIcon(small[0]);
    }
    png.map(Buffer::from)
  }
}

#[napi(object)]
pub struct ShortcutInfo {
  pub target_path: String,
  pub icon_path: String,
  pub icon_index: i32,
}

/// Reads a `.lnk` shortcut's target path and icon location, replacing the
/// `WScript.Shell` COM object previously driven from PowerShell.
#[napi]
pub fn resolve_shortcut(path: String) -> Option<ShortcutInfo> {
  let _com = ComGuard::new();
  unsafe {
    let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
    let persist_file: IPersistFile = link.cast().ok()?;
    let wpath = HSTRING::from(&path);
    persist_file.Load(&wpath, STGM_READ).ok()?;

    let mut target_buf = [0u16; 4096];
    link.GetPath(&mut target_buf, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32).ok()?;
    let target_path = pwstr_to_string(&target_buf);

    let mut icon_buf = [0u16; 4096];
    let mut icon_index = 0i32;
    let icon_path = if link.GetIconLocation(&mut icon_buf, &mut icon_index).is_ok() {
      pwstr_to_string(&icon_buf)
    } else {
      String::new()
    };

    Some(ShortcutInfo { target_path, icon_path, icon_index })
  }
}

fn pwstr_to_string(buf: &[u16]) -> String {
  let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
  String::from_utf16_lossy(&buf[..len])
}

/// Renders the tile icon for a packaged (MSIX/UWP) app via the same
/// `IShellItemImageFactory` mechanism Explorer uses, addressed by its
/// AppUserModelID under the virtual `shell:AppsFolder`.
#[napi]
pub fn extract_packaged_icon_png(app_id: String, size: u32) -> Option<Buffer> {
  let _com = ComGuard::new();
  unsafe {
    let parsing_name = format!("shell:AppsFolder\\{app_id}");
    let wname = HSTRING::from(&parsing_name);
    let item: IShellItem = SHCreateItemFromParsingName(&wname, None).ok()?;
    let factory: IShellItemImageFactory = item.cast().ok()?;

    let sz = windows::Win32::Foundation::SIZE { cx: size as i32, cy: size as i32 };
    let hbitmap = factory.GetImage(sz, SIIGBF_RESIZETOFIT).ok()?;
    let png = hbitmap_to_png(hbitmap, size as i32, size as i32);
    let _ = DeleteObject(HGDIOBJ(hbitmap.0));
    png.map(Buffer::from)
  }
}

fn hbitmap_to_png(hbitmap: HBITMAP, width: i32, height: i32) -> Option<Vec<u8>> {
  unsafe {
    let hdc = CreateCompatibleDC(None);
    let mut bmi = BITMAPINFO {
      bmiHeader: BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
      },
      ..Default::default()
    };
    let mut bgra = vec![0u8; (width as usize) * (height as usize) * 4];
    let got = GetDIBits(
      hdc,
      hbitmap,
      0,
      height as u32,
      Some(bgra.as_mut_ptr() as *mut core::ffi::c_void),
      &mut bmi,
      DIB_RGB_COLORS
    );
    let _ = DeleteDC(hdc);
    if got == 0 {
      return None;
    }

    for px in bgra.chunks_exact_mut(4) {
      px.swap(0, 2);
    }

    let image = image::RgbaImage::from_raw(width as u32, height as u32, bgra)?;
    let mut out = Vec::new();
    image
      .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
      .ok()?;
    Some(out)
  }
}

/// The current foreground window handle, as an i64 (USER handles fit in 32 bits even
/// on 64-bit Windows). The launcher captures this just before it shows itself, so the
/// window-snap commands act on whatever the user was working in, not on the launcher.
#[napi]
pub fn foreground_window() -> i64 {
  unsafe { GetForegroundWindow().0 as i64 }
}

/// The invisible resize border around a window — the gap between its window rect
/// (what `SetWindowPos` controls) and the pixels DWM actually paints. On a standard
/// window this is ~7px on the left/right/bottom and 0 on top. Returns `(left, top,
/// right, bottom)` padding to add so the *visible* window lands where we want and
/// adjacent tiled windows sit flush (their invisible borders overlapping), the way
/// Windows' own Snap does it. All zero when DWM can't report it (custom-framed apps).
unsafe fn invisible_border(hwnd: HWND) -> (i32, i32, i32, i32) {
  let mut window = RECT::default();
  let mut frame = RECT::default();
  let ok = unsafe {
    GetWindowRect(hwnd, &mut window).is_ok()
      && DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        &mut frame as *mut RECT as *mut core::ffi::c_void,
        std::mem::size_of::<RECT>() as u32
      )
      .is_ok()
  };
  if !ok {
    return (0, 0, 0, 0);
  }
  (
    (frame.left - window.left).max(0),
    (frame.top - window.top).max(0),
    (window.right - frame.right).max(0),
    (window.bottom - frame.bottom).max(0)
  )
}

#[napi(object)]
pub struct WinRect {
  pub x: i32,
  pub y: i32,
  pub width: i32,
  pub height: i32
}

/// The window's current visible frame — DWM's extended frame bounds, i.e. the
/// painted pixels, not the underlying window rect (which can carry several px of
/// invisible resize border on the left/right/bottom). This is the same
/// screen-coordinate space Electron's `screen` module reports display work areas
/// in, so callers (TS `window/layout.ts` via `screen.getDisplayNearestPoint`) can
/// use it directly with no translation. Returns `null` if `hwnd` is invalid or DWM
/// can't report its frame (e.g. a custom-framed app).
#[napi]
pub fn get_window_rect(hwnd: i64) -> Option<WinRect> {
  if hwnd == 0 {
    return None;
  }
  let hwnd = HWND(hwnd as *mut core::ffi::c_void);
  let mut frame = RECT::default();
  let ok = unsafe {
    DwmGetWindowAttribute(
      hwnd,
      DWMWA_EXTENDED_FRAME_BOUNDS,
      &mut frame as *mut RECT as *mut core::ffi::c_void,
      std::mem::size_of::<RECT>() as u32
    )
    .is_ok()
  };
  if !ok {
    return None;
  }
  Some(WinRect {
    x: frame.left,
    y: frame.top,
    width: frame.right - frame.left,
    height: frame.bottom - frame.top
  })
}

/// Restores a maximized/minimized window, then moves/resizes it so its *visible*
/// frame (see `get_window_rect`) exactly matches `rect` — expanding by the
/// invisible resize border so adjacent tiled windows still sit flush, the way
/// Windows' own Snap does — and brings it to the foreground. `rect` is expected to
/// already be a valid target the caller computed (from `window/layout.ts`); this
/// function does no region math of its own. Returns whether the window was moved.
#[napi]
pub fn apply_window_rect(hwnd: i64, rect: WinRect) -> bool {
  if hwnd == 0 {
    return false;
  }
  let hwnd = HWND(hwnd as *mut core::ffi::c_void);

  unsafe {
    // A maximized or minimized window has to be restored first, or SetWindowPos
    // fights the placement state and the window snaps back.
    if IsZoomed(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
      let _ = ShowWindow(hwnd, SW_RESTORE);
    }

    // Expand the window rect by the invisible border so the painted window fills the
    // target region exactly, instead of sitting inset by a few pixels on each side.
    let (bl, bt, br, bb) = invisible_border(hwnd);
    let placed = SetWindowPos(
      hwnd,
      None,
      rect.x - bl,
      rect.y - bt,
      rect.width + bl + br,
      rect.height + bt + bb,
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED
    )
    .is_ok();

    // The launcher hid itself before running this, so focus is already drifting
    // back toward this window; make that deterministic.
    if placed {
      let _ = SetForegroundWindow(hwnd);
    }
    placed
  }
}

/// Windows has no equivalent of macOS's Spaces-based fullscreen, so "Toggle
/// Fullscreen" maps to the closest native analogue: maximize the window (or
/// restore it, if already maximized). Returns whether the state changed.
#[napi]
pub fn toggle_maximize(hwnd: i64) -> bool {
  if hwnd == 0 {
    return false;
  }
  let hwnd = HWND(hwnd as *mut core::ffi::c_void);

  unsafe {
    // `ShowWindow`'s BOOL return is whether the window was *previously* visible,
    // not whether this call succeeded, so it isn't a usable success signal here —
    // matching the rest of this file, we just issue the call and report success
    // once we've confirmed `hwnd` was valid.
    let target = if IsZoomed(hwnd).as_bool() { SW_RESTORE } else { SW_MAXIMIZE };
    let _ = ShowWindow(hwnd, target);
    let _ = SetForegroundWindow(hwnd);
    true
  }
}

#[napi(object)]
pub struct StartApp {
  pub name: String,
  pub app_id: String,
}

/// Enumerates packaged (MSIX/UWP) Start Menu apps by walking the virtual
/// `shell:AppsFolder`, replacing the `Get-StartApps` PowerShell cmdlet. Only items
/// whose AppUserModelID contains `!` (PackageFamilyName!AppId) are packaged apps;
/// classic desktop apps also show up in this folder but are already covered by the
/// `.lnk` shortcuts collected separately, so they're filtered out here.
#[napi]
pub fn list_start_apps() -> Vec<StartApp> {
  let _com = ComGuard::new();
  let mut results = Vec::new();
  unsafe {
    let wname = HSTRING::from("shell:AppsFolder");
    let folder: IShellItem = match SHCreateItemFromParsingName(&wname, None) {
      Ok(f) => f,
      Err(_) => return results,
    };
    let enum_items: IEnumShellItems = match folder.BindToHandler(None, &BHID_EnumItems) {
      Ok(e) => e,
      Err(_) => return results,
    };

    loop {
      let mut items: [Option<IShellItem>; 1] = [None];
      let mut fetched = 0u32;
      if enum_items.Next(&mut items, Some(&mut fetched)).is_err() || fetched == 0 {
        break;
      }
      let Some(item) = items[0].take() else { break };

      let Ok(item2) = item.cast::<IShellItem2>() else { continue };
      let Ok(app_id_pwstr) = item2.GetString(&PKEY_AppUserModel_ID) else { continue };
      let app_id = app_id_pwstr.to_string().unwrap_or_default();
      CoTaskMemFree(Some(app_id_pwstr.0 as *const core::ffi::c_void));
      if !app_id.contains('!') {
        continue;
      }

      let name = match item2.GetString(&PKEY_ItemNameDisplay) {
        Ok(p) => {
          let s = p.to_string().unwrap_or_default();
          CoTaskMemFree(Some(p.0 as *const core::ffi::c_void));
          s
        }
        Err(_) => match item.GetDisplayName(SIGDN_NORMALDISPLAY) {
          Ok(p) => {
            let s = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0 as *const core::ffi::c_void));
            s
          }
          Err(_) => String::new(),
        }
      };

      if name.is_empty() {
        continue;
      }
      results.push(StartApp { name, app_id });
    }
  }
  results
}

/// Stashed behind the watcher window's `GWLP_USERDATA` slot so the (`extern "system"`, so
/// state-free by construction) `clipboard_watcher_wndproc` can reach the callback the window
/// exists for. Boxed on creation (`start_clipboard_watcher`) and freed on `WM_CLOSE`.
struct WatcherContext {
  tsfn: ThreadsafeFunction<()>,
}

/// Window procedure for the hidden, message-only window `start_clipboard_watcher` creates.
/// `WM_CLIPBOARDUPDATE` is Win32's push notification for "the clipboard just changed",
/// delivered here because the window registered itself via `AddClipboardFormatListener`.
/// `WM_CLOSE` (sent by `ClipboardWatcher::stop`) tears the listener/context down and destroys
/// the window; `WM_DESTROY` (fired by that `DestroyWindow`) posts `WM_QUIT` to end this thread's
/// message loop.
unsafe extern "system" fn clipboard_watcher_wndproc(
  hwnd: HWND,
  msg: u32,
  wparam: WPARAM,
  lparam: LPARAM
) -> LRESULT {
  match msg {
    WM_CLIPBOARDUPDATE => {
      let ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *const WatcherContext;
      if let Some(ctx) = unsafe { ptr.as_ref() } {
        ctx.tsfn.call(Ok(()), ThreadsafeFunctionCallMode::NonBlocking);
      }
      LRESULT(0)
    }
    WM_CLOSE => {
      unsafe {
        let _ = RemoveClipboardFormatListener(hwnd);
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WatcherContext;
        if !ptr.is_null() {
          SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
          drop(Box::from_raw(ptr));
        }
        let _ = DestroyWindow(hwnd);
      }
      LRESULT(0)
    }
    WM_DESTROY => {
      unsafe { PostQuitMessage(0) };
      LRESULT(0)
    }
    _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
  }
}

/// Handle for the background clipboard watcher `start_clipboard_watcher` starts. Dropping this
/// without calling `stop()` leaks the watcher window and its message-loop thread for the rest of
/// the process's life — callers must `stop()` it explicitly (e.g. on app quit), matching
/// `ClipboardPoller.stop()` on the TS side.
#[napi]
pub struct ClipboardWatcher {
  hwnd: isize,
  thread: Option<std::thread::JoinHandle<()>>
}

#[napi]
impl ClipboardWatcher {
  /// Unregisters the clipboard listener, closes the hidden watcher window, and joins its
  /// message-loop thread. Idempotent — a second call is a no-op.
  #[napi]
  pub fn stop(&mut self) {
    if self.hwnd != 0 {
      let hwnd = HWND(self.hwnd as *mut core::ffi::c_void);
      unsafe {
        let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
      }
      self.hwnd = 0;
    }
    if let Some(thread) = self.thread.take() {
      let _ = thread.join();
    }
  }
}

/// Starts watching the system clipboard for changes via a true OS push notification instead of
/// polling: a background thread creates a hidden, message-only window, registers it for
/// `WM_CLIPBOARDUPDATE` via `AddClipboardFormatListener` (the Win32 mechanism the Windows Clipboard
/// History pane itself is built on), and invokes `callback` with no arguments once for every
/// clipboard write. This is what lets the TS `ClipboardPoller` (see
/// `main/pasteboard-change-win.ts`) skip its `setInterval` fallback entirely on Windows, unlike the
/// cheap-but-still-polled `pasteboardChangeCount()` this addon's macOS counterpart offers.
///
/// Blocks briefly (microseconds — one window creation) waiting for the background thread to
/// finish setting up before returning, so a failure (window/class creation, or registering the
/// listener) can be reported by returning a watcher whose `hwnd` is already 0 rather than a
/// handle that silently never calls back.
#[napi]
pub fn start_clipboard_watcher(callback: ThreadsafeFunction<()>) -> ClipboardWatcher {
  let (tx, rx) = std::sync::mpsc::channel::<isize>();

  let thread = std::thread::spawn(move || {
    let hinstance = unsafe {
      match GetModuleHandleW(None) {
        Ok(h) => windows::Win32::Foundation::HINSTANCE::from(h),
        Err(_) => {
          let _ = tx.send(0);
          return;
        }
      }
    };

    let class_name = HSTRING::from("MagibarClipboardWatcherClass");
    static CLASS_REGISTERED: std::sync::Once = std::sync::Once::new();
    CLASS_REGISTERED.call_once(|| unsafe {
      let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(clipboard_watcher_wndproc),
        hInstance: hinstance,
        lpszClassName: PCWSTR(class_name.as_ptr()),
        ..Default::default()
      };
      RegisterClassExW(&wc);
    });

    let hwnd = unsafe {
      CreateWindowExW(
        WINDOW_EX_STYLE(0),
        &class_name,
        &HSTRING::from(""),
        WINDOW_STYLE(0),
        0,
        0,
        0,
        0,
        Some(HWND_MESSAGE),
        None,
        Some(hinstance),
        None
      )
    };
    let hwnd = match hwnd {
      Ok(h) => h,
      Err(_) => {
        let _ = tx.send(0);
        return;
      }
    };

    let ctx = Box::new(WatcherContext { tsfn: callback });
    unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(ctx) as isize) };

    let listening = unsafe { AddClipboardFormatListener(hwnd) };
    if listening.is_err() {
      unsafe {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WatcherContext;
        if !ptr.is_null() {
          SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
          drop(Box::from_raw(ptr));
        }
        let _ = DestroyWindow(hwnd);
      }
      let _ = tx.send(0);
      return;
    }

    let _ = tx.send(hwnd.0 as isize);

    let mut msg = MSG::default();
    unsafe {
      while GetMessageW(&mut msg, None, 0, 0).as_bool() {
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
      }
    }
  });

  let hwnd = rx.recv().unwrap_or(0);
  ClipboardWatcher {
    hwnd,
    thread: Some(thread)
  }
}

// -- Process listing / termination (Activity Monitor), via `sysinfo` --
// Same shape as `native/mac/src/lib.rs` and `native/linux/src/lib.rs` — see
// the comment there. `sysinfo` has no real SIGTERM equivalent on Windows
// (there is none at the OS level), so both `kill_process(pid, false)` and
// `kill_process(pid, true)` end up calling `TerminateProcess` here: `Signal::
// Term` isn't supported by `kill_with` on this platform and falls back to
// `Process::kill()`, which is exactly what `Signal::Kill` does too.

use std::sync::{Mutex, OnceLock};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System};

/// One process's identity and live resource usage, as reported by the last
/// `list_processes()` refresh.
#[napi(object)]
pub struct NativeProcess {
  pub pid: i32,
  pub name: String,
  /// Percentage of a single CPU core (0–100 per core, so a busy multi-core
  /// process can exceed 100), matching Task Manager's own convention.
  pub cpu_usage: f64,
  pub memory_bytes: f64,
  /// Full path to the executable, when readable — lets the TS side resolve
  /// an icon for it via Electron's `app.getFileIcon`. `None` for a process
  /// whose executable path isn't readable (permission-restricted, or exited
  /// between the refresh and this read).
  pub path: Option<String>,
}

/// A process-wide `System`, reused across every `list_processes()`/
/// `kill_process()` call rather than recreated per call. `sysinfo`'s CPU
/// percentages are a delta against the *previous* refresh of the same
/// instance — a fresh `System` every call would always report ~0% on its
/// first (and only) read.
fn system() -> &'static Mutex<System> {
  static SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();
  SYSTEM.get_or_init(|| Mutex::new(System::new()))
}

/// A snapshot of every currently running process's pid, name, CPU% and
/// working-set memory. Cheap to call on a poll interval (a couple of times a
/// second).
#[napi]
pub fn list_processes() -> Vec<NativeProcess> {
  let mut sys = system().lock().unwrap();
  sys.refresh_processes_specifics(
    ProcessesToUpdate::All,
    true,
    ProcessRefreshKind::everything(),
  );
  sys
    .processes()
    .values()
    .map(|process| NativeProcess {
      pid: process.pid().as_u32() as i32,
      name: process.name().to_string_lossy().into_owned(),
      cpu_usage: process.cpu_usage() as f64,
      memory_bytes: process.memory() as f64,
      path: process
        .exe()
        .map(|path| path.to_string_lossy().into_owned()),
    })
    .collect()
}

/// Terminates `pid` via `TerminateProcess` — `force` has no effect on
/// Windows (see the module comment above); kept for a call-shape identical
/// to macOS/Linux. Returns `false` if the process no longer exists or
/// access is denied; the caller can't tell those apart from the bool alone
/// and doesn't need to — both are surfaced as the same inline error.
#[napi]
pub fn kill_process(pid: i32, force: bool) -> bool {
  let mut sys = system().lock().unwrap();
  let target = Pid::from_u32(pid as u32);
  sys.refresh_processes_specifics(
    ProcessesToUpdate::Some(&[target]),
    true,
    ProcessRefreshKind::new(),
  );
  let Some(process) = sys.process(target) else {
    return false;
  };
  let signal = if force { Signal::Kill } else { Signal::Term };
  process.kill_with(signal).unwrap_or_else(|| process.kill())
}

/// One listening TCP socket and the process that owns it. Cheap enough (a few
/// ms) to fetch alongside `list_processes()` on every poll tick.
#[napi(object)]
pub struct NativePort {
  pub pid: i32,
  pub port: u32,
}

/// Every TCP port something is listening on, with the owning pid. Empty if the
/// OS refuses to enumerate (e.g. missing permission).
#[napi]
pub fn list_listening_ports() -> Vec<NativePort> {
  listeners::get_all()
    .map(|set| {
      set
        .into_iter()
        .map(|l| NativePort {
          pid: l.process.pid as i32,
          port: l.socket.port() as u32,
        })
        .collect()
    })
    .unwrap_or_default()
}

// -- Global hotkeys via a low-level keyboard hook --
//
// `RegisterHotKey` (what Electron's `globalShortcut` wraps) can't win against
// Explorer's own hardcoded `Win+<key>` shortcuts (`Win+Space` switches input
// language, `Win+E`/`L`/`D` are shell commands, …) — Explorer's shell hook
// consumes those combos before a `RegisterHotKey` registration ever fires —
// and it has no way to represent "a modifier alone" at all, which a bare-`Win`
// binding needs. A `WH_KEYBOARD_LL` hook sees every keystroke system-wide
// *before* Explorer does, so it can both detect and suppress what
// `RegisterHotKey` can't reach. This mirrors `ClipboardWatcher` above
// (background thread, hidden message-only window, `ThreadsafeFunction`
// callback) but installs a keyboard hook instead of a clipboard listener.

/// Physical side of a `Win` key press — only meaningful for the lone-tap
/// (no other key pressed before release) case; a combo (`Win+Space`) doesn't
/// care which side was held.
#[derive(Clone, Copy, PartialEq, Eq)]
enum WinSide {
  Left,
  Right,
}

fn win_side(vk: u16) -> Option<WinSide> {
  match vk {
    0x5B => Some(WinSide::Left),  // VK_LWIN
    0x5C => Some(WinSide::Right), // VK_RWIN
    _ => None,
  }
}

fn is_ctrl_vk(vk: u16) -> bool {
  matches!(vk, 0x11 | 0xA2 | 0xA3) // VK_CONTROL, VK_LCONTROL, VK_RCONTROL
}
fn is_alt_vk(vk: u16) -> bool {
  matches!(vk, 0x12 | 0xA4 | 0xA5) // VK_MENU, VK_LMENU, VK_RMENU
}
fn is_shift_vk(vk: u16) -> bool {
  matches!(vk, 0x10 | 0xA0 | 0xA1) // VK_SHIFT, VK_LSHIFT, VK_RSHIFT
}

/// Electron-accelerator-token -> Win32 virtual-key code, for every token
/// `src/renderer/src/lib/shortcut.ts`'s `eventToAccelerator`/`CODE_TO_KEY` can
/// produce. Letters/digits are their own ASCII codes (Win32 convention);
/// everything else is a stable, well-known VK constant, inlined as a literal
/// rather than pulled in via `Win32_UI_Input_KeyboardAndMouse` so this module
/// doesn't need that Cargo feature just for two dozen named constants.
fn key_name_to_vk(token: &str) -> Option<u16> {
  let mut chars = token.chars();
  if let (Some(c), None) = (chars.next(), chars.next()) {
    if c.is_ascii_alphabetic() {
      return Some(c.to_ascii_uppercase() as u16);
    }
    if c.is_ascii_digit() {
      return Some(c as u16);
    }
    return Some(match c {
      ',' => 0xBC,  // VK_OEM_COMMA
      '.' => 0xBE,  // VK_OEM_PERIOD
      '/' => 0xBF,  // VK_OEM_2
      '\\' => 0xDC, // VK_OEM_5
      ';' => 0xBA,  // VK_OEM_1
      '\'' => 0xDE, // VK_OEM_7
      '[' => 0xDB,  // VK_OEM_4
      ']' => 0xDD,  // VK_OEM_6
      '-' => 0xBD,  // VK_OEM_MINUS
      '=' => 0xBB,  // VK_OEM_PLUS
      '`' => 0xC0,  // VK_OEM_3
      _ => return None,
    });
  }
  if let Some(rest) = token.strip_prefix('f') {
    if let Ok(n) = rest.parse::<u16>() {
      if (1..=24).contains(&n) {
        return Some(0x70 + (n - 1)); // VK_F1..VK_F24
      }
    }
  }
  Some(match token {
    "space" => 0x20,           // VK_SPACE
    "up" => 0x26,               // VK_UP
    "down" => 0x28,              // VK_DOWN
    "left" => 0x25,              // VK_LEFT
    "right" => 0x27,             // VK_RIGHT
    "escape" | "esc" => 0x1B, // VK_ESCAPE
    "tab" => 0x09,               // VK_TAB
    "return" | "enter" => 0x0D, // VK_RETURN
    "backspace" => 0x08,      // VK_BACK
    "delete" => 0x2E,           // VK_DELETE
    _ => return None,
  })
}

/// The reverse of `key_name_to_vk` — used only while *capturing* a new
/// accelerator (see `HotkeyWatcher::start_capture`), to report the key the
/// user just pressed back to JS in the same token vocabulary
/// `eventToAccelerator` produces. `None` for a VK with no accelerator
/// equivalent (mirrors `key_name_to_vk` returning `None` for an unmapped
/// token) — such a key is simply not reported, same as `eventToAccelerator`
/// silently ignoring it.
fn vk_to_key_token(vk: u16) -> Option<String> {
  if (0x41..=0x5A).contains(&vk) || (0x30..=0x39).contains(&vk) {
    return Some(((vk as u8) as char).to_string()); // 'A'..'Z' / '0'..'9'
  }
  if (0x70..=0x87).contains(&vk) {
    return Some(format!("F{}", vk - 0x70 + 1)); // VK_F1..VK_F24
  }
  Some(
    match vk {
      0x20 => "Space",
      0x26 => "Up",
      0x28 => "Down",
      0x25 => "Left",
      0x27 => "Right",
      0x1B => "Escape",
      0x09 => "Tab",
      0x0D => "Return",
      0x08 => "Backspace",
      0x2E => "Delete",
      0xBC => ",",
      0xBE => ".",
      0xBF => "/",
      0xDC => "\\",
      0xBA => ";",
      0xDE => "'",
      0xDB => "[",
      0xDD => "]",
      0xBD => "-",
      0xBB => "=",
      0xC0 => "`",
      _ => return None,
    }
    .to_string(),
  )
}

/// Builds the same accelerator-string shape `eventToAccelerator`'s non-mac
/// branch does — `Ctrl`, `Alt`, `Super`, `Shift`, then the key token, in that
/// order — for reporting a captured combo back to JS.
fn format_accelerator(mods: Modifiers, key: &str) -> String {
  let mut parts: Vec<&str> = Vec::with_capacity(5);
  if mods.ctrl {
    parts.push("Ctrl");
  }
  if mods.alt {
    parts.push("Alt");
  }
  if mods.win {
    parts.push("Super");
  }
  if mods.shift {
    parts.push("Shift");
  }
  parts.push(key);
  parts.join("+")
}

/// Mirrors `LONE_SUPER_HOTKEY` in `main/native/hotkeys.ts` / `shortcut.ts`.
const LONE_SUPER_ACCELERATOR: &str = "Super";

fn keyboard_input(vk: u16, flags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS) -> INPUT {
  INPUT {
    r#type: INPUT_KEYBOARD,
    Anonymous: INPUT_0 {
      ki: KEYBDINPUT {
        wVk: VIRTUAL_KEY(vk),
        wScan: 0,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  }
}

/// Injects a "mask key" — a harmless keypress+release — mirroring exactly
/// what AutoHotkey's `#MenuMaskKey`/`A_MenuMaskKey` does for the identical
/// problem: "if the system detects only a `Win` (or `Alt`) keydown and keyup
/// with no intervening keypress, it activates a menu [the Start Menu, or a
/// focused window's own menu bar]." An intervening keystroke — real or
/// synthetic — is enough to make that detector stand down.
///
/// Needed anywhere this module suppresses something between a real `Win`
/// keydown and its eventual (real or synthetic) keyup, so Explorer never
/// sees a "clean" tap:
///
///  - A firing lone tap itself, since the real `Win` keyup gets suppressed
///    (paired with `inject_win_keyup`, see its own doc comment for why both
///    are needed together — this module shipped a stuck-key bug from having
///    only that half, and a Start-Menu-still-opens bug from having neither).
///  - A firing `Win+<key>` combo, since the *other* key's own down/up get
///    suppressed entirely so it never reaches whatever app is focused —
///    meaning Explorer never sees anything happen between `Win` going down
///    and its real (never suppressed, for a combo) eventual keyup either,
///    so without this it still reads as a clean lone tap and opens the
///    Start Menu regardless of the combo firing correctly.
///
/// `0xFF` is Microsoft's own "no mapping" placeholder virtual-key code —
/// documented to mean *no key at all*, so nothing anywhere is bound to it.
/// `0x07` (this module's very first attempt) looks similarly "undefined" but
/// isn't safe anymore: Windows 10 1909 repurposed it to open the Xbox Game
/// Bar, which is presumably why that attempt didn't reliably suppress the
/// Start Menu either.
///
/// `LLKHF_INJECTED` (checked at the top of `low_level_keyboard_proc`, the
/// same convention this module's own capture/matching logic relies on to
/// ignore its own injected input) is what stops this from being mistaken —
/// by our own hook, or the desktop's own Start-Menu detector — for a real
/// keystroke.
fn inject_mask_keypress() {
  const VK_NO_MAPPING: u16 = 0xFF;
  let inputs = [
    keyboard_input(VK_NO_MAPPING, Default::default()),
    keyboard_input(VK_NO_MAPPING, KEYEVENTF_KEYUP),
  ];
  unsafe {
    SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
  }
}

/// Injects a synthetic keyup for `Win` itself (`side`'s own `VK_LWIN`/
/// `VK_RWIN`) — only ever needed right after `inject_mask_keypress`, for a
/// firing lone tap specifically (where the *real* `Win` keyup itself is what
/// gets suppressed, unlike a combo, where `Win`'s own keyup is never touched
/// — see the `win_side` branch of `handle_key_event`).
///
/// Suppressing the real `Win` keyup without this leaves Windows' own "is
/// `Win` currently held" key-state stuck "down" forever, since nothing ever
/// told it `Win` came back up — every following keystroke then reads as
/// `Win+<key>` until the user taps `Win` again (this module's second bug).
/// Sending this *after* the mask key (rather than before, or as the only
/// injected event, this module's third bug) matters: by the time this
/// reaches Explorer's detector, it has already stood down because of the
/// mask key, so a second `Win` keyup here doesn't re-arm it.
fn inject_win_keyup(side: WinSide) {
  let win_vk = match side {
    WinSide::Left => 0x5B,  // VK_LWIN
    WinSide::Right => 0x5C, // VK_RWIN
  };
  unsafe {
    SendInput(
      &[keyboard_input(win_vk, KEYEVENTF_KEYUP)],
      std::mem::size_of::<INPUT>() as i32,
    );
  }
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct Modifiers {
  ctrl: bool,
  alt: bool,
  shift: bool,
  win: bool,
}

/// A parsed accelerator: a modifier set plus an optional non-modifier key.
/// `key: None` with `win: true` and nothing else is the lone-`Win`-tap case
/// (`LONE_SUPER_HOTKEY` on the TS side); no other modifier-only combination is
/// reachable from the capture UI.
struct ParsedAccelerator {
  mods: Modifiers,
  key: Option<u16>,
}

/// Parses the same accelerator vocabulary `eventToAccelerator`/`matchesShortcut`
/// (`shortcut.ts`) produce/accept — `Ctrl`/`Control`, `Alt`/`Option`, `Shift`,
/// `Super`/`Meta`/`Command`/`Cmd`, `CommandOrControl`/`CmdOrCtrl` (-> Ctrl on
/// Windows) plus one key token. Returns `None` for an unmapped key token or a
/// bare key with no modifier at all (never valid as a global shortcut).
fn parse_accelerator(accelerator: &str) -> Option<ParsedAccelerator> {
  let mut mods = Modifiers::default();
  let mut key: Option<u16> = None;
  for token in accelerator.split('+').filter(|t| !t.is_empty()) {
    match token.to_lowercase().as_str() {
      "commandorcontrol" | "cmdorctrl" | "control" | "ctrl" => mods.ctrl = true,
      "command" | "cmd" | "meta" | "super" => mods.win = true,
      "alt" | "option" => mods.alt = true,
      "shift" => mods.shift = true,
      other => key = Some(key_name_to_vk(other)?),
    }
  }
  if !mods.ctrl && !mods.alt && !mods.shift && !mods.win {
    return None;
  }
  Some(ParsedAccelerator { mods, key })
}

struct HotkeyEntry {
  id: String,
  parsed: ParsedAccelerator,
}

/// Live state the hook proc reads/updates on every keystroke. A single
/// process-wide instance — `start_hotkey_watcher` only ever runs once (one
/// `HotkeyWatcher` per app, same as `ClipboardWatcher`) — behind a `Mutex`
/// since the hook thread and whichever thread calls `register`/`unregister`
/// (the JS/napi thread) both touch it.
#[derive(Default)]
struct HookState {
  entries: Vec<HotkeyEntry>,
  ctrl: bool,
  alt: bool,
  shift: bool,
  win_left: bool,
  win_right: bool,
  /// Set on a `Win` keydown that hasn't yet seen another key while held; a
  /// matching keyup with this still set is a solo tap. Cleared by any other
  /// key event (modifier or not) — that's what tells `Win+Space` apart from a
  /// tap.
  win_tap_candidate: Option<WinSide>,
  /// The non-modifier VK a combo last fired for, so its own key-repeat
  /// keydowns and its eventual keyup stay suppressed too (rather than only
  /// the first keydown), without re-firing the callback.
  fired_vk: Option<u16>,
  /// Set by `HotkeyWatcher::start_capture`/`stop_capture`. While true, a
  /// `Win`-involving keystroke is reported to `capture_callback` instead of
  /// checked against `entries` (see `handle_key_event`) — used by the
  /// shortcut-recorder UI, which otherwise can never observe a lone `Win` tap
  /// or a `Win+<key>` combo at all: Explorer/the shell consumes those before
  /// a normal (non-hooked) focused window ever receives them, the same
  /// problem `RegisterHotKey` has for *registering* one. A key that doesn't
  /// involve `Win` is left completely alone here — the existing DOM-level
  /// capture in the renderer already handles those fine.
  capturing: bool,
}

fn hook_state() -> &'static Mutex<HookState> {
  static STATE: OnceLock<Mutex<HookState>> = OnceLock::new();
  STATE.get_or_init(|| Mutex::new(HookState::default()))
}

fn hook_callback() -> &'static Mutex<Option<ThreadsafeFunction<String>>> {
  static CALLBACK: OnceLock<Mutex<Option<ThreadsafeFunction<String>>>> = OnceLock::new();
  CALLBACK.get_or_init(|| Mutex::new(None))
}

fn fire_hotkey(id: &str) {
  if let Some(tsfn) = hook_callback().lock().unwrap().as_ref() {
    tsfn.call(Ok(id.to_string()), ThreadsafeFunctionCallMode::NonBlocking);
  }
}

fn capture_callback() -> &'static Mutex<Option<ThreadsafeFunction<String>>> {
  static CALLBACK: OnceLock<Mutex<Option<ThreadsafeFunction<String>>>> = OnceLock::new();
  CALLBACK.get_or_init(|| Mutex::new(None))
}

fn report_capture(accelerator: &str) {
  if let Some(tsfn) = capture_callback().lock().unwrap().as_ref() {
    tsfn.call(
      Ok(accelerator.to_string()),
      ThreadsafeFunctionCallMode::NonBlocking,
    );
  }
}

/// Returns whether this keystroke should be suppressed (kept from reaching
/// Explorer/any other app). Runs on the hook thread, inside the low-level
/// hook's timeout budget, so this only ever does `O(entries)` comparisons and
/// a non-blocking callback post — never anything that can block.
fn handle_key_event(vk: u16, is_down: bool) -> bool {
  let mut state = hook_state().lock().unwrap();

  if let Some(side) = win_side(vk) {
    let already_down = match side {
      WinSide::Left => state.win_left,
      WinSide::Right => state.win_right,
    };
    if is_down {
      // Ignore key-repeat (the side is already down) — only a fresh press
      // starts a new tap candidacy.
      if !already_down {
        state.win_tap_candidate = Some(side);
      }
      match side {
        WinSide::Left => state.win_left = true,
        WinSide::Right => state.win_right = true,
      }
      return false;
    }
    match side {
      WinSide::Left => state.win_left = false,
      WinSide::Right => state.win_right = false,
    }
    let was_candidate = state.win_tap_candidate == Some(side);
    state.win_tap_candidate = None;
    if !was_candidate {
      return false;
    }
    if state.capturing {
      drop(state);
      inject_mask_keypress();
      inject_win_keyup(side);
      report_capture(LONE_SUPER_ACCELERATOR);
      return true;
    }
    let matched = state
      .entries
      .iter()
      .find(|e| e.parsed.key.is_none() && e.parsed.mods == (Modifiers { win: true, ..Default::default() }))
      .map(|e| e.id.clone());
    drop(state);
    match matched {
      Some(id) => {
        inject_mask_keypress();
        inject_win_keyup(side);
        fire_hotkey(&id);
        true
      }
      None => false,
    }
  } else if is_ctrl_vk(vk) {
    state.ctrl = is_down;
    state.win_tap_candidate = None;
    false
  } else if is_alt_vk(vk) {
    state.alt = is_down;
    state.win_tap_candidate = None;
    false
  } else if is_shift_vk(vk) {
    state.shift = is_down;
    state.win_tap_candidate = None;
    false
  } else {
    // Any other key cancels a live Win-tap candidacy — this is what lets
    // `Win+Space` fall through to the combo branch below instead of also
    // counting as (or interfering with) a lone Win tap.
    state.win_tap_candidate = None;
    let win = state.win_left || state.win_right;

    if is_down {
      if state.fired_vk == Some(vk) {
        return true; // key-repeat of an already-fired/-captured combo's key
      }
      let mods = Modifiers {
        ctrl: state.ctrl,
        alt: state.alt,
        shift: state.shift,
        win,
      };

      if state.capturing {
        // Not `Win`-involving — the renderer's own DOM keydown listener
        // already sees this one fine (Explorer never intercepts a plain
        // Ctrl/Alt/Shift combo before delivery), so leave it alone entirely
        // rather than duplicate that path.
        if !win {
          return false;
        }
        let Some(token) = vk_to_key_token(vk) else {
          return false;
        };
        state.fired_vk = Some(vk);
        drop(state);
        // Suppressing this key (below) means Explorer never sees anything
        // happen between `Win` going down and its own eventual real keyup —
        // without this, it still reads as a clean lone tap and opens the
        // Start Menu regardless (see `inject_mask_keypress`'s doc comment).
        inject_mask_keypress();
        report_capture(&format_accelerator(mods, &token));
        return true;
      }

      let matched = state
        .entries
        .iter()
        .find(|e| e.parsed.key == Some(vk) && e.parsed.mods == mods)
        .map(|e| e.id.clone());
      match matched {
        Some(id) => {
          state.fired_vk = Some(vk);
          drop(state);
          // Same reasoning as the `capturing` branch above — this key gets
          // suppressed too, so `Win`'s eventual real keyup needs the same
          // mask key to not read as a clean lone tap.
          if win {
            inject_mask_keypress();
          }
          fire_hotkey(&id);
          true
        }
        None => false,
      }
    } else if state.fired_vk == Some(vk) {
      state.fired_vk = None;
      true // suppress the matching keyup too, so the key doesn't leak to whatever has focus
    } else {
      false
    }
  }
}

unsafe extern "system" fn low_level_keyboard_proc(
  code: i32,
  wparam: WPARAM,
  lparam: LPARAM
) -> LRESULT {
  if code >= 0 {
    let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
    // Ignore synthetic input (our own or another tool's `SendInput`) so this
    // never reacts to injected keystrokes, only what the user actually typed.
    if info.flags.0 & LLKHF_INJECTED.0 == 0 {
      let msg = wparam.0 as u32;
      let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
      let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
      if (is_down || is_up) && handle_key_event(info.vkCode as u16, is_down) {
        return LRESULT(1);
      }
    }
  }
  unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// Stashed behind the hotkey watcher window's `GWLP_USERDATA` slot, mirroring
/// `WatcherContext` above — just the hook handle, so `WM_CLOSE` can unhook it.
struct HotkeyWindowContext {
  hook: HHOOK,
}

unsafe extern "system" fn hotkey_watcher_wndproc(
  hwnd: HWND,
  msg: u32,
  wparam: WPARAM,
  lparam: LPARAM
) -> LRESULT {
  match msg {
    WM_CLOSE => {
      unsafe {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut HotkeyWindowContext;
        if !ptr.is_null() {
          SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
          let ctx = Box::from_raw(ptr);
          let _ = UnhookWindowsHookEx(ctx.hook);
        }
        let _ = DestroyWindow(hwnd);
      }
      {
        let mut state = hook_state().lock().unwrap();
        state.entries.clear();
        state.capturing = false;
      }
      *hook_callback().lock().unwrap() = None;
      *capture_callback().lock().unwrap() = None;
      LRESULT(0)
    }
    WM_DESTROY => {
      unsafe { PostQuitMessage(0) };
      LRESULT(0)
    }
    _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
  }
}

/// Handle for the background hotkey watcher `start_hotkey_watcher` starts.
/// Dropping this without calling `stop()` leaks the watcher window, the
/// keyboard hook, and its message-loop thread for the rest of the process's
/// life — callers must `stop()` it explicitly (e.g. on app quit).
#[napi]
pub struct HotkeyWatcher {
  hwnd: isize,
  thread: Option<std::thread::JoinHandle<()>>
}

#[napi]
impl HotkeyWatcher {
  /// Parses and stores `accelerator` under `id`, replacing whatever was
  /// previously registered under that id. Returns `false` only if
  /// `accelerator` doesn't parse (an unmapped key token, or no modifier at
  /// all) — unlike `RegisterHotKey`, there's no "already in use by another
  /// app" failure mode here, since this never asks Windows for exclusive
  /// ownership of the combo; it just watches every keystroke itself.
  #[napi]
  pub fn register(&self, id: String, accelerator: String) -> bool {
    let Some(parsed) = parse_accelerator(&accelerator) else {
      return false;
    };
    let mut state = hook_state().lock().unwrap();
    state.entries.retain(|e| e.id != id);
    state.entries.push(HotkeyEntry { id, parsed });
    true
  }

  /// Idempotent — removing an id that isn't registered is a no-op.
  #[napi]
  pub fn unregister(&self, id: String) {
    hook_state().lock().unwrap().entries.retain(|e| e.id != id);
  }

  /// Starts reporting every `Win`-involving keystroke to `callback` as a
  /// captured accelerator string (`"Super"` for a lone tap, `"Super+Space"`
  /// for a combo, …) instead of matching it against registered entries —
  /// for a shortcut-recorder UI, which otherwise has no way to see a `Win`
  /// keystroke at all (see `HookState::capturing`). A key that doesn't
  /// involve `Win` is untouched and keeps reaching the focused window's own
  /// keydown handler exactly as before. Replaces any previous capture
  /// callback if already capturing.
  #[napi]
  pub fn start_capture(&self, callback: ThreadsafeFunction<String>) {
    *capture_callback().lock().unwrap() = Some(callback);
    let mut state = hook_state().lock().unwrap();
    state.capturing = true;
    state.win_tap_candidate = None;
    state.fired_vk = None;
  }

  /// Stops capture mode and resumes normal entry-matching. Idempotent.
  #[napi]
  pub fn stop_capture(&self) {
    let mut state = hook_state().lock().unwrap();
    state.capturing = false;
    state.win_tap_candidate = None;
    state.fired_vk = None;
    *capture_callback().lock().unwrap() = None;
  }

  /// Unhooks, closes the hidden watcher window, and joins its message-loop
  /// thread. Idempotent.
  #[napi]
  pub fn stop(&mut self) {
    if self.hwnd != 0 {
      let hwnd = HWND(self.hwnd as *mut core::ffi::c_void);
      unsafe {
        let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
      }
      self.hwnd = 0;
    }
    if let Some(thread) = self.thread.take() {
      let _ = thread.join();
    }
  }
}

/// Starts the global-hotkey watcher: a background thread creates a hidden,
/// message-only window, installs a system-wide `WH_KEYBOARD_LL` hook on that
/// thread (required — Windows delivers low-level hook callbacks only to the
/// thread that installed them, via its message loop), and invokes `callback`
/// with the registered id whenever a bound accelerator fires. Entries are
/// registered/unregistered afterward via the returned `HotkeyWatcher`.
///
/// Blocks briefly (microseconds — one window + hook creation) waiting for the
/// background thread to finish setting up, so a failure can be reported by
/// returning a watcher whose `hwnd` is already 0 rather than one that
/// silently never calls back — same contract as `start_clipboard_watcher`.
#[napi]
pub fn start_hotkey_watcher(callback: ThreadsafeFunction<String>) -> HotkeyWatcher {
  *hook_callback().lock().unwrap() = Some(callback);
  hook_state().lock().unwrap().entries.clear();

  let (tx, rx) = std::sync::mpsc::channel::<isize>();

  let thread = std::thread::spawn(move || {
    let hinstance = unsafe {
      match GetModuleHandleW(None) {
        Ok(h) => windows::Win32::Foundation::HINSTANCE::from(h),
        Err(_) => {
          let _ = tx.send(0);
          return;
        }
      }
    };

    let class_name = HSTRING::from("MagibarHotkeyWatcherClass");
    static CLASS_REGISTERED: std::sync::Once = std::sync::Once::new();
    CLASS_REGISTERED.call_once(|| unsafe {
      let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(hotkey_watcher_wndproc),
        hInstance: hinstance,
        lpszClassName: PCWSTR(class_name.as_ptr()),
        ..Default::default()
      };
      RegisterClassExW(&wc);
    });

    let hwnd = unsafe {
      CreateWindowExW(
        WINDOW_EX_STYLE(0),
        &class_name,
        &HSTRING::from(""),
        WINDOW_STYLE(0),
        0,
        0,
        0,
        0,
        Some(HWND_MESSAGE),
        None,
        Some(hinstance),
        None
      )
    };
    let hwnd = match hwnd {
      Ok(h) => h,
      Err(_) => {
        let _ = tx.send(0);
        return;
      }
    };

    // `hMod` is `None`/NULL for a *_LL hook per MSDN: the hook procedure lives
    // in this same process, and `dwThreadId` is always 0 for a low-level hook
    // (Windows treats it as global regardless of what's passed).
    let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(low_level_keyboard_proc), None, 0) };
    let hook = match hook {
      Ok(h) => h,
      Err(_) => {
        unsafe {
          let _ = DestroyWindow(hwnd);
        }
        let _ = tx.send(0);
        return;
      }
    };

    let ctx = Box::new(HotkeyWindowContext { hook });
    unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(ctx) as isize) };

    let _ = tx.send(hwnd.0 as isize);

    let mut msg = MSG::default();
    unsafe {
      while GetMessageW(&mut msg, None, 0, 0).as_bool() {
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
      }
    }
  });

  let hwnd = rx.recv().unwrap_or(0);
  HotkeyWatcher {
    hwnd,
    thread: Some(thread)
  }
}
