/** `Image` — only its enum members are runtime values; the rest of real
 *  Raycast's `Image` namespace is types. Masks aren't rendered yet (see
 *  `reconciler.ts`'s `icon()`), but extensions read these at module scope. */
export const Image = {
  Mask: {
    Circle: "circle",
    RoundedRectangle: "roundedRectangle",
  },
} as const;

/** `closeMainWindow({ popToRootType })` / `showHUD(…, { popToRootType })`. */
export const PopToRootType = {
  Default: "default",
  Immediate: "immediate",
  Suspended: "suspended",
} as const;
