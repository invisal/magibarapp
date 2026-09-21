// Components shared across windows. Mostly the framed windows (Settings,
// Widget) — WindowFrame, Layout, Form — but the launcher also pulls the
// `Footer` (results count / pin toggle / ⌘K actions menu) from here.
export { WindowFrame } from "./WindowFrame";
export { Breadcrumb } from "./Breadcrumb";
export { Layout } from "./Layout";
export { ListScreen, LIST_SCREEN_ITEM_HEIGHT } from "./ListScreen";
export { Detail } from "./Detail";
export { Footer } from "./Footer";
export type { ButtonProps, FooterMenuItem, FooterMenuProps } from "./Footer";
export { Header } from "./Header";
export { Form, useField } from "./Form";
export { ShortcutLabel, WindowsKeyIcon } from "./ShortcutLabel";
