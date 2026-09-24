import { Cache, LocalStorage, showHUD } from "@raycast/api";

export default async function Command() {
  // Exercises `LocalStorage` and `Cache` — the shim APIs backed by real
  // files — rather than only `showHUD`.
  const previous = (await LocalStorage.getItem<number>("greet-count")) ?? 0;
  await LocalStorage.setItem("greet-count", previous + 1);
  new Cache().set("greeted-at", "fixture-run");
  await showHUD("Hello from the fixture plugin");
}
