import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";

import "@fontsource-variable/spline-sans";
import "@fontsource-variable/spline-sans-mono";

import { router } from "./router";
import { queryClient } from "./query-client";
import { ErrorBoundary } from "./components/ui/error-boundary";
import { ToastProvider } from "./components/ui/toast";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("root element missing");
}

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
