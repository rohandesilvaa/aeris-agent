import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

function mount() {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// Opened in a plain browser during development (no Tauri backend), the app
// runs against a simulated backend so the interface can be designed there.
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  void import("./devMock").then(({ installDevMock }) => { installDevMock(); mount(); });
} else {
  mount();
}
