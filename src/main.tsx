import { createRoot } from "react-dom/client";
import { Buffer } from "buffer";
import App from "./App";
import "./styles.css";

globalThis.Buffer = Buffer;

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    const serviceWorkerUrl = new URL("service-worker.js", document.baseURI);
    void navigator.serviceWorker.register(serviceWorkerUrl, { scope: "./" });
  });
}

createRoot(document.getElementById("root")!).render(<App />);
