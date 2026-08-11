import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root")!;

/**
 * `/compose` is the headless composer the durable build workflow drives inside
 * Browser Run. It is a route rather than a second HTML entry because the
 * Cloudflare Vite plugin owns the client build and rejects extra entries.
 *
 * The composer is loaded lazily so a normal visit never pays for it.
 */
if (window.location.pathname === "/compose") {
  void import("./compose").then(({ mountComposer }) => mountComposer(root));
} else if (window.location.pathname === "/embed") {
  // The embeddable editor a host page loads in an iframe. Also a route rather
  // than an entry, and also lazy — the studio never pays for it.
  void import("./embed").then(({ mountEmbed }) => mountEmbed(root));
} else {
  createRoot(root).render(
    <StrictMode><App /></StrictMode>
  );
}
