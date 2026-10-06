/**
 * The platform Magibar really runs on, captured before `host/runtime.ts`
 * presents Linux to extensions as macOS. Shim code about Magibar's own UI
 * (labels, shortcut glyphs) reads this — never `process.platform`.
 */
export const hostPlatform: NodeJS.Platform = process.platform;
