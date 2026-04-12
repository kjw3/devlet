import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App.js";
import { TrpcProvider, queryClient } from "./trpc.js";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <TrpcProvider>
          <App />
        </TrpcProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>
);
