import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { AppMotion } from "./motion/AppMotion";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppMotion>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </AppMotion>
  </StrictMode>,
);
