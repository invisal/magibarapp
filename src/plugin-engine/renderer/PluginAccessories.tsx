/**
 * A `List.Item`'s `accessories`, drawn the way Raycast does: each one an
 * optional icon, text, and/or colored tag, in a row at the end of the item.
 */
import type { ReactNode } from "react";
import { iconSrc, isGlyphIcon } from "@renderer/lib/icon";
import type { PluginAccessory } from "@plugin-engine/host/protocol";

function AccessoryIcon({ icon }: { icon: string }): ReactNode {
  const src = iconSrc(icon);
  if (src) {
    return <img src={src} alt="" className="h-3.5 w-3.5 object-contain" />;
  }
  return isGlyphIcon(icon) ? <span>{icon}</span> : null;
}

export function PluginAccessories({
  accessories,
}: {
  accessories: PluginAccessory[] | undefined;
}): ReactNode {
  if (!accessories) return undefined;
  return (
    <span className="flex items-center gap-3">
      {accessories.map((accessory, i) => (
        <span key={i} className="flex items-center gap-1">
          {accessory.icon && <AccessoryIcon icon={accessory.icon} />}
          {accessory.text && <span>{accessory.text}</span>}
          {accessory.tag && (
            <span
              className="rounded px-1.5 py-px text-[11px]"
              style={
                accessory.tag.color
                  ? {
                      color: accessory.tag.color,
                      backgroundColor: `color-mix(in srgb, ${accessory.tag.color} 15%, transparent)`,
                    }
                  : { backgroundColor: "var(--color-input)" }
              }
            >
              {accessory.tag.value}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}
