import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  findLinuxExecutable,
  isMachO,
  linuxInvocation,
  wrapChildProcess,
} from "./linux-binaries.ts";

const MACH_O = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);

function fixture(): { dir: string; macBinary: string } {
  const dir = mkdtempSync(join(tmpdir(), "linux-bin-"));
  const macBinary = join(dir, "mytool");
  writeFileSync(macBinary, MACH_O, { mode: 0o755 });
  return { dir, macBinary };
}

test("isMachO spots Mach-O headers only", () => {
  const { dir, macBinary } = fixture();
  assert.equal(isMachO(macBinary), true);
  const script = join(dir, "script");
  writeFileSync(script, "#!/bin/sh\necho hi\n");
  assert.equal(isMachO(script), false);
  assert.equal(isMachO(join(dir, "missing")), false);
});

test("non-Mach-O invocations are left alone", () => {
  assert.deepEqual(linuxInvocation("/bin/echo", ["a"], undefined, false), {
    file: "/bin/echo",
    args: ["a"],
  });
});

test("a Mach-O spawn uses a same-named Linux executable on PATH", () => {
  const { dir, macBinary } = fixture();
  const bin = mkdtempSync(join(dir, "bin-"));
  const linux = join(bin, "mytool");
  writeFileSync(linux, '#!/bin/sh\necho linux "$@"\n', { mode: 0o755 });
  assert.equal(findLinuxExecutable("mytool", bin, macBinary), linux);
  assert.deepEqual(linuxInvocation(macBinary, ["--x"], { PATH: bin }, false), {
    file: linux,
    args: ["--x"],
  });
});

test("an unknown Mach-O binary fails with an explanation", async () => {
  const { macBinary } = fixture();
  const cp = wrapChildProcess();
  await assert.rejects(
    promisify(cp.execFile)(macBinary, [], { env: { PATH: "/usr/bin:/bin" } }),
    (error: { code?: number; stderr?: string }) =>
      error.code === 126 && /macOS-only binary/.test(error.stderr ?? ""),
  );
});

test("the wrapped execFile runs the substitute and keeps promisify's shape", async () => {
  const { dir, macBinary } = fixture();
  const bin = mkdtempSync(join(dir, "bin-"));
  writeFileSync(join(bin, "mytool"), '#!/bin/sh\necho linux "$@"\n', {
    mode: 0o755,
  });
  const cp = wrapChildProcess();
  const { stdout } = await promisify(cp.execFile)(macBinary, ["ok"], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
  });
  assert.equal(stdout, "linux ok\n");
  assert.equal(
    cp.spawnSync(macBinary, ["sync"], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
    }).stdout,
    "linux sync\n",
  );
});
