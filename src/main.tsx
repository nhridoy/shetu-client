import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import { installLogForwarding } from "@/lib/logging/logging";
import "./index.css";

installLogForwarding();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
