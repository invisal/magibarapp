"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { jsx, jsxs } = require("react/jsx-runtime");
const { useState } = require("react");
const api = require("@raycast/api");
const { List, ActionPanel, Action, Detail, useNavigation } = api;

function Child({ name }) {
  const { pop } = useNavigation();
  return jsx(Detail, {
    markdown: `# ${name}`,
    actions: jsx(ActionPanel, {
      children: jsx(Action, { title: "Back", onAction: pop }),
    }),
  });
}

function Row({ name }) {
  // Wrapped in the extension's own component — filtering must still apply.
  return jsx(List.Item, {
    title: name,
    icon: { source: api.Icon.Star, tintColor: api.Color.Red },
    accessories: [{ text: { value: "acc", color: api.Color.Blue } }, { tag: "t" }],
    actions: jsx(ActionPanel, {
      children: jsx(Action.Push, { title: "Open", target: jsx(Child, { name }) }),
    }),
  });
}

exports.default = function Command(props) {
  const [count] = useState(props.arguments.start ?? 0);
  return jsxs(List, {
    navigationTitle: `count ${count}`,
    children: [jsx(Row, { name: "Alpha" }, "a"), jsx(Row, { name: "Beta" }, "b")],
  });
};
