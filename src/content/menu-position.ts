export type MenuAnchor = { left: number; right: number; top: number; bottom: number };

export function calculateMenuPosition(
  anchor: MenuAnchor | null,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const marginX = Math.min(12, viewport.width / 2);
  const marginY = Math.min(12, viewport.height / 2);
  const availableHeight = Math.max(0, viewport.height - marginY * 2);
  const width = Math.min(menu.width, Math.max(0, viewport.width - marginX * 2));
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));
  const visibleAnchor = anchor && anchor.right >= 0 && anchor.left <= viewport.width &&
    anchor.bottom >= 0 && anchor.top <= viewport.height;
  if (!visibleAnchor) {
    const height = Math.min(menu.height, availableHeight);
    return {
      left: (viewport.width - width) / 2,
      top: (viewport.height - height) / 2,
      maxHeight: availableHeight,
    };
  }
  const gap = 8;
  const below = Math.max(0, viewport.height - marginY - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - marginY - gap);
  const useBelow = below >= menu.height || (above < menu.height && below >= above);
  const sideSpace = useBelow ? below : above;
  // Very small viewports may require overlapping the field to retain usable controls.
  const maxHeight = sideSpace >= 160 ? Math.min(availableHeight, sideSpace) : availableHeight;
  const height = Math.min(menu.height, maxHeight);
  return {
    left: clamp(anchor.left, marginX, viewport.width - marginX - width),
    top: clamp(useBelow ? anchor.bottom + gap : anchor.top - gap - height,
      marginY, viewport.height - marginY - height),
    maxHeight,
  };
}
