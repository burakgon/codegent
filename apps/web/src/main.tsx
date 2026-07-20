import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./theme.css";
import { Shell } from "./components/Shell";

// Token intake: FRAGMENT first (#t= never leaves the browser — it is not part
// of the HTTP request, so tunnels/proxies/logs never see it; review B-Imp),
// query kept only for old bookmarks. Both are stripped after storage.
const fromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("t");
const fromQuery = new URLSearchParams(location.search).get("t");
const t = fromHash ?? fromQuery;
if (t) { localStorage.setItem("cgToken", t); history.replaceState(null, "", location.pathname); }

const qc = new QueryClient();
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={qc}><Shell /></QueryClientProvider>
);
