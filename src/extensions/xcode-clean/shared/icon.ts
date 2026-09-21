const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#3fa9ff"/><stop offset="1" stop-color="#1667e8"/>
</linearGradient></defs>
<rect width="64" height="64" rx="14" fill="url(#g)"/>
<path d="M39 11 30 32" stroke="#f3c56b" stroke-width="5" stroke-linecap="round" fill="none"/>
<path d="M22 30h17l5 4-4 19H21L17 34z" fill="#fff"/>
<path d="M24 38v11M30 38v11M36 38v11" stroke="#1667e8" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;

/** The "Clean Xcode" command's icon: a white broom head on Xcode blue. Inlined as
 *  a `data:` URI because the launcher's CSP is `img-src 'self' data:`. */
export const XCODE_CLEAN_ICON = `data:image/svg+xml,${encodeURIComponent(SVG)}`;
