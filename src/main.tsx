import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found — check index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
