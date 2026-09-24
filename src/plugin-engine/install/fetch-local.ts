/** Local-path install: copy a folder on disk into `<pluginId>/source/`. */
import { cp } from "node:fs/promises";

export async function fetchLocalFolder(
  localPath: string,
  destDir: string,
): Promise<void> {
  await cp(localPath, destDir, { recursive: true });
}
