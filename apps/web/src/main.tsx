import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./theme.css";
import { Shell } from "./components/Shell";

const t = new URLSearchParams(location.search).get("t");
if (t) { localStorage.setItem("cgToken", t); history.replaceState(null, "", location.pathname); }

const qc = new QueryClient();
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={qc}><Shell /></QueryClientProvider>
);
