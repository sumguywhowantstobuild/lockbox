import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installDropGuard } from "./dropGuard";
import { installDropProbe } from "./dropProbe";

// The probe first, so it sees a drop before the guard cancels it; both before anything renders.
installDropProbe();
installDropGuard();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
