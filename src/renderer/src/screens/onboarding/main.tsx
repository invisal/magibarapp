import React from "react";
import ReactDOM from "react-dom/client";
import Onboarding from "./Onboarding";
import "../../index.css";
import "./onboarding.css";

// Lets CSS key off the OS, same as the launcher entry.
document.documentElement.dataset.platform = window.api.platform;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Onboarding />
  </React.StrictMode>,
);
