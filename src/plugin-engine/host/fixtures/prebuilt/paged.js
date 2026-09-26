"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { jsx } = require("react/jsx-runtime");
const { useState } = require("react");
const { List } = require("@raycast/api");

// Two pages of two items; the List echoes its last selection as a row.
exports.default = function Command() {
  const [pages, setPages] = useState(1);
  const [selected, setSelected] = useState("none");
  const items = [];
  for (let i = 0; i < pages * 2; i++) {
    items.push(jsx(List.Item, { id: `item-${i}`, title: `Item ${i}` }, i));
  }
  items.push(jsx(List.Item, { title: `selected: ${selected}` }, "sel"));
  return jsx(List, {
    isShowingDetail: true,
    throttle: true,
    selectedItemId: "item-1",
    onSelectionChange: (id) => setSelected(String(id)),
    pagination: {
      hasMore: pages < 2,
      pageSize: 2,
      onLoadMore: () => setPages((p) => p + 1),
    },
    children: items,
  });
};
