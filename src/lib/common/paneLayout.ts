export type DropSide = "left" | "right" | "top" | "bottom";

export interface PlacedPane {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PlacedDivider {
  id: string;
  splitId: string;
  index: number;
  direction: "horizontal" | "vertical";
  posPct: number;
  crossPct: number;
  extentPct: number;
}

export const DIVIDER_SIZE = 10;

interface TreeLeaf {
  type: "leaf";
  id: string;
  size?: number;
}

interface TreeSplit {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  children: TreeNode[];
  size: number;
}

export type TreeNode = TreeLeaf | TreeSplit;

export function countLeaves(node: TreeNode): number {
  if (node.type === "leaf") return 1;
  return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
}

export function computeLayout(
  node: TreeNode,
  left: number,
  top: number,
  width: number,
  height: number,
  panes: PlacedPane[],
  dividers: PlacedDivider[],
) {
  if (node.type === "leaf") {
    panes.push({ id: node.id, left, top, width, height });
    return;
  }
  const sizes = node.children.map((c) => c.size ?? 1);
  const sum = sizes.reduce((a: number, b: number) => a + b, 0) || 1;
  let offset = 0;
  node.children.forEach((child, i) => {
    const frac = (sizes[i] ?? 1) / sum;
    if (node.direction === "horizontal") {
      const cw = width * frac;
      if (i < node.children.length - 1) {
        dividers.push({
          id: `${node.id}_${i}`,
          splitId: node.id,
          index: i,
          direction: "horizontal",
          posPct: left + offset + cw,
          crossPct: top,
          extentPct: height,
        });
      }
      computeLayout(child, left + offset, top, cw, height, panes, dividers);
      offset += cw;
    } else {
      const ch = height * frac;
      if (i < node.children.length - 1) {
        dividers.push({
          id: `${node.id}_${i}`,
          splitId: node.id,
          index: i,
          direction: "vertical",
          posPct: top + offset + ch,
          crossPct: left,
          extentPct: width,
        });
      }
      computeLayout(child, left, top + offset, width, ch, panes, dividers);
      offset += ch;
    }
  });
}

export function previewStyle(side: DropSide): React.CSSProperties {
  const base: React.CSSProperties = {
    position: "absolute",
    pointerEvents: "none",
    backgroundColor: "rgba(14, 165, 233, 0.25)",
    border: "2px solid rgb(14, 165, 233)",
    borderRadius: 4,
    zIndex: 30,
  };
  switch (side) {
    case "left":
      return { ...base, left: 0, top: 0, width: "50%", height: "100%" };
    case "right":
      return { ...base, right: 0, top: 0, width: "50%", height: "100%" };
    case "top":
      return { ...base, left: 0, top: 0, width: "100%", height: "50%" };
    case "bottom":
      return { ...base, left: 0, bottom: 0, width: "100%", height: "50%" };
  }
}
