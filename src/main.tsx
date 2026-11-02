import { createRoot } from "react-dom/client";
import { Buffer } from "buffer";
import App from "./App";
import "./styles.css";
import "./document-filename-polish.css";
import "./cloudvault-polish.css";
import "./miki-light-premium.css";
import "./miki-mobile-professional.css";
import "./miki-app-redesign.css";

globalThis.Buffer = Buffer;

if ("serviceWorker" in navigator) {
  const serviceWorkerUrl = new URL("service-worker.js", document.baseURI);
  serviceWorkerUrl.searchParams.set("v", "52");
  if (import.meta.env.DEV) serviceWorkerUrl.searchParams.set("dev", "1");
  void navigator.serviceWorker.register(serviceWorkerUrl, { scope: "./" });
}

createRoot(document.getElementById("root")!).render(<App />);
