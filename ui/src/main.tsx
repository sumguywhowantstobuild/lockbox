import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installDropGuard } from "./dropGuard";

// Before anything renders, so no drop can land on the page first.
installDropGuard();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
