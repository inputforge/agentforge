import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// eslint-disable-next-line import/no-unassigned-import
import "./index.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
