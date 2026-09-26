import { Action, ActionPanel, List } from "@raycast/api";

export default function Command() {
  return (
    <List searchBarPlaceholder="Search fixture items…">
      <List.Item
        title="Fixture Item"
        subtitle="from the sample plugin"
        actions={
          <ActionPanel>
            <Action.CopyToClipboard content="fixture-value" />
          </ActionPanel>
        }
      />
    </List>
  );
}
