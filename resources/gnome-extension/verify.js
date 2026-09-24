// Verifies the GNOME Shell extension's logic outside of GNOME Shell.
//
// The extension can't be covered by `npm test`: it runs inside the compositor,
// in GJS, against Mutter's own types, and GNOME only loads a newly-installed
// extension at login — so a mistake in it would otherwise only surface after a
// log out, in a process with no console the user ever sees. This stubs
// `global` and the `Meta.Window` methods the extension calls, then drives the
// real `extension.js` against the real `Meta` typelib, which is what makes it
// catch Mutter API drift (`get_maximized()` was removed in GNOME 50's
// libmutter-18, and this is how that was found).
//
// Run against the installed Mutter typelib:
//
//   GI_TYPELIB_PATH=/usr/lib/x86_64-linux-gnu/mutter-18 \
//     gjs -m resources/gnome-extension/verify.js \
//     resources/gnome-extension/magibar@magibar.app
//
// The typelib path and `Meta` version track the host's GNOME release
// (`mutter-18` is GNOME 50); adjust both for another version.

imports.gi.versions.Meta = '18';
const Meta = imports.gi.Meta;
const Gio = imports.gi.Gio;

function fakeWindow(opts) {
  const w = {
    _rect: opts.rect ?? { x: 0, y: 0, width: 100, height: 100 },
    _maximized: opts.maximized ?? false,
    _fullscreen: opts.fullscreen ?? false,
    minimized: opts.minimized ?? false,
    unminimizeCalled: false,
    unmaximizeCalled: false,
    get_stable_sequence: () => opts.id,
    is_override_redirect: () => opts.overrideRedirect ?? false,
    get_window_type: () => opts.type ?? Meta.WindowType.NORMAL,
    get_wm_class: () => opts.wmClass ?? null,
    get_wm_class_instance: () => opts.wmInstance ?? null,
    get_gtk_application_id: () => opts.gtkId ?? null,
    get_frame_rect: () => w._rect,
    is_maximized: () => w._maximized,
    is_fullscreen: () => w._fullscreen,
    unmake_fullscreen: () => { w._fullscreen = false; },
    make_fullscreen: () => { w._fullscreen = true; },
    unmaximize: (flags) => { w.unmaximizeCalled = flags; w._maximized = false; },
    unminimize: () => { w.unminimizeCalled = true; w.minimized = false; },
    move_resize_frame: (userOp, x, y, width, height) => {
      w.lastUserOp = userOp;
      w._rect = { x, y, width, height };
    },
  };
  return w;
}

let windows = [];
let focused = null;
globalThis.global = {
  get_window_actors: () => windows.map((meta_window) => ({ meta_window })),
  get display() { return { get_focus_window: () => focused }; },
};

// Resolved through Gio so the extension directory can be given relative to
// the working directory, not just as an absolute path.
const extensionUri = Gio.File.new_for_commandline_arg(ARGV[0])
  .get_child('extension.js')
  .get_uri();
const mod = await import(extensionUri);
const ext = new mod.default();
// enable() would claim a real bus name; reach the service directly instead.
ext.enable();
const svc = ext._service;

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) print(`  PASS  ${name}`);
  else { failures++; print(`  FAIL  ${name}\n          got ${a}\n          want ${e}`); }
}

const normal = fakeWindow({ id: 11, rect: { x: 5, y: 6, width: 300, height: 400 }, wmClass: 'Firefox' });
const maxed = fakeWindow({ id: 22, maximized: true, minimized: true, wmClass: 'Code' });
const popup = fakeWindow({ id: 33, overrideRedirect: true, wmClass: 'Menu' });
const magibar = fakeWindow({ id: 44, wmClass: 'Magibar' });
windows = [normal, maxed, popup, magibar];

check('Version', svc.Version(), 1);
check('HasWindows', svc.HasWindows(), true);

check('GetRect(11)', svc.GetRect(11), [true, 5, 6, 300, 400]);
check('GetRect(unknown)', svc.GetRect(999), [false, 0, 0, 0, 0]);
check('GetRect skips override-redirect', svc.GetRect(33), [false, 0, 0, 0, 0]);

focused = normal;
check('GetFocused', svc.GetFocused('Magibar'), 11);
focused = magibar;
check('GetFocused excludes own app (case-insensitive)', svc.GetFocused('magibar'), 0);
focused = fakeWindow({ id: 55, gtkId: 'app.magibar' });
check('GetFocused matches gtk application id', svc.GetFocused('app.Magibar'), 0);
focused = null;
check('GetFocused with nothing focused', svc.GetFocused('Magibar'), 0);

check('MoveResize(11)', svc.MoveResize(11, 10, 20, 640, 480), true);
check('  applied rect', normal._rect, { x: 10, y: 20, width: 640, height: 480 });
check('  used user-op flag', normal.lastUserOp, true);
check('MoveResize(unknown)', svc.MoveResize(999, 0, 0, 1, 1), false);

check('MoveResize on maximized+minimized', svc.MoveResize(22, 1, 2, 3, 4), true);
check('  cleared maximize with BOTH', maxed.unmaximizeCalled, Meta.MaximizeFlags.BOTH);
check('  unminimized first', maxed.unminimizeCalled, true);
check('  applied rect', maxed._rect, { x: 1, y: 2, width: 3, height: 4 });

check('ToggleFullscreen on', svc.ToggleFullscreen(11), true);
check('  now fullscreen', normal._fullscreen, true);
check('ToggleFullscreen off', svc.ToggleFullscreen(11), true);
check('  now windowed', normal._fullscreen, false);
check('ToggleFullscreen(unknown)', svc.ToggleFullscreen(999), false);

windows = [popup];
check('HasWindows ignores override-redirect', svc.HasWindows(), false);

ext.disable();
print(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
if (failures) imports.system.exit(1);
