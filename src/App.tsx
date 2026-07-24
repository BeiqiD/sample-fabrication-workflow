import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { ActionIcon } from "./components/ActionIcon";
import { NavigationIcon, type NavigationIconName } from "./components/NavigationIcon";

const SamplesPage = lazy(() => import("./pages/SamplesPage").then((module) => ({ default: module.SamplesPage })));
const NewSamplePage = lazy(() => import("./pages/NewSamplePage").then((module) => ({ default: module.NewSamplePage })));
const SamplePage = lazy(() => import("./pages/SamplePage").then((module) => ({ default: module.SamplePage })));
const TemplatesPage = lazy(() => import("./pages/TemplatesPage").then((module) => ({ default: module.TemplatesPage })));
const ExportPage = lazy(() => import("./pages/ExportPage").then((module) => ({ default: module.ExportPage })));
const TemplatePage = lazy(() => import("./pages/TemplatePage").then((module) => ({ default: module.TemplatePage })));
const MetrologyTemplatePage = lazy(() => import("./pages/MetrologyTemplatePage").then((module) => ({ default: module.MetrologyTemplatePage })));
const ProcessingPage = lazy(() => import("./pages/ProcessingPage").then((module) => ({ default: module.ProcessingPage })));
const ProcessingWorkspacePage = lazy(() => import("./pages/ProcessingWorkspacePage").then((module) => ({ default: module.ProcessingWorkspacePage })));
const SampleTimelinePage = lazy(() => import("./pages/SampleTimelinePage").then((module) => ({ default: module.SampleTimelinePage })));

const primaryNavigation: Array<{ to: string; label: string; icon: NavigationIconName }> = [
  { to: "/processing", label: "Processing", icon: "processing" },
  { to: "/samples", label: "Samples", icon: "samples" },
  { to: "/templates", label: "Templates", icon: "templates" },
  { to: "/export", label: "Export", icon: "export" },
];

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
        <NavLink to="/processing" className="brand" aria-label="Sample Fabrication Workflow" title="Sample Fabrication Workflow">
          <span className="brand-mark"><NavigationIcon name="brand" /></span>
          <span className="brand-title">Sample Fabrication Workflow</span>
        </NavLink>
        <div className="topbar-actions">
          <nav aria-label="Primary navigation">
            {primaryNavigation.map(({ to, label, icon }) => <NavLink key={to} to={to} aria-label={label} title={label}>
              <NavigationIcon name={icon} />
              <span className="nav-link-label">{label}</span>
            </NavLink>)}
          </nav>
          <button
            type="button"
            className="theme-toggle"
            aria-label={`Switch to ${theme === "light" ? "night" : "light"} mode`}
            title={`Switch to ${theme === "light" ? "night" : "light"} mode`}
            onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}
          >
            <ActionIcon name={theme === "light" ? "moon" : "sun"} />
            <small>{theme === "light" ? "Night" : "Light"}</small>
          </button>
        </div>
      </header>
      <main>
        <Suspense fallback={<div className="page route-loading"><p className="muted">Loading…</p></div>}>
          <Routes>
            <Route path="/" element={<Navigate to="/processing" replace />} />
            <Route path="/processing" element={<ProcessingPage />} />
            <Route path="/processing/:sampleId" element={<ProcessingWorkspacePage />} />
            <Route path="/samples" element={<SamplesPage />} />
            <Route path="/samples/new" element={<NewSamplePage />} />
            <Route path="/samples/:sampleId/timeline" element={<SampleTimelinePage />} />
            <Route path="/samples/:sampleId" element={<SamplePage />} />
            <Route path="/templates" element={<TemplatesPage />} />
            <Route path="/templates/metrology/:templateId" element={<MetrologyTemplatePage />} />
            <Route path="/templates/:templateId" element={<TemplatePage />} />
            <Route path="/imports/fabublox" element={<Navigate to="/templates?import=1" replace />} />
            <Route path="/export" element={<ExportPage />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
