// Shaped like `ray build` output: CommonJS, `@raycast/api` left external.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api = require("@raycast/api");
// Read at module-eval time, like many real extensions do.
const prefs = api.getPreferenceValues();
exports.default = async function Command(props) {
  const text = await api.Clipboard.readText();
  await api.showHUD(
    `${prefs.greeting} ${props.arguments.name} from ${api.environment.commandName} (${api.LaunchType.UserInitiated}) clip=${text}`,
  );
  console.log("this must not break anything");
};
