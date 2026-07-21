import { Suspense, useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { NewSamplePage } from "./pages/NewSamplePage";
import { SamplePage } from "./pages/SamplePage";
import { TemplatesPage } from "./pages/TemplatesPage";
import { ExportPage } from "./pages/ExportPage";
import { EntryPage } from "./pages/EntryPage";
import { TemplatePage } from "./pages/TemplatePage";
import { ProcessingPage } from "./pages/ProcessingPage";
import { ProcessingRunPage } from "./pages/ProcessingRunPage";

export function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = window.localStorage.getItem("sample-workflow-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("sample-workflow-theme", theme);
  }, [theme]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <NavLink to="/processing" className="brand">
          <span className="brand-mark">SF</span>
          <span>Sample Fabrication Workflow</span>
        </NavLink>
        <div className="topbar-actions">
          <nav>
            <NavLink to="/processing">Processing</NavLink>
            <NavLink to="/samples">Samples</NavLink>
            <NavLink to="/templates">Templates</NavLink>
            <NavLink to="/export">Export</NavLink>
          </nav>
          <button
            type="button"
            className="theme-toggle"
            aria-label={`Switch to ${theme === "light" ? "night" : "light"} mode`}
            title={`Switch to ${theme === "light" ? "night" : "light"} mode`}
            onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}
          >
            <span aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span>
            <small>{theme === "light" ? "Night" : "Light"}</small>
          </button>
        </div>
      </header>
      <main><Suspense fallback={<div className="page"><p className="muted">Loading…</p></div>}>
        <Routes>
          <Route path="/" element={<Navigate to="/processing" replace />} />
          <Route path="/processing" element={<ProcessingPage />} />
          <Route path="/processing/:sampleId" element={<ProcessingRunPage />} />
          <Route path="/samples" element={<HomePage />} />
          <Route path="/samples/new" element={<NewSamplePage />} />
          <Route path="/entry" element={<EntryPage />} />
          <Route path="/samples/:sampleId" element={<SamplePage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/templates/:templateId" element={<TemplatePage />} />
          <Route path="/imports/fabublox" element={<Navigate to="/templates?import=1" replace />} />
          <Route path="/export" element={<ExportPage />} />
        </Routes>
      </Suspense></main>
    </div>
  );
}
