import React from "react";
import ReactDOM from "react-dom/client";
import Coach from "./Coach";
import "../../index.css";

document.documentElement.dataset.platform = window.api.platform;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Coach />
  </React.StrictMode>,
);
