import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { SamplesPage } from "./pages/SamplesPage";
import { NewSamplePage } from "./pages/NewSamplePage";
import { SamplePage } from "./pages/SamplePage";
import { TemplatesPage } from "./pages/TemplatesPage";
import { ExportPage } from "./pages/ExportPage";
import { TemplatePage } from "./pages/TemplatePage";
import { ProcessingPage } from "./pages/ProcessingPage";
import { ProcessingWorkspacePage } from "./pages/ProcessingWorkspacePage";
import { NavigationIcon, type NavigationIconName } from "./components/NavigationIcon";

const primaryNavigation: Array<{ to: string; label: string; icon: NavigationIconName }> = [
  { to: "/processing", label: "Processing", icon: "processing" },
  { to: "/samples", label: "Samples", icon: "samples" },
  { to: "/templates", label: "Process templates", icon: "templates" },
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
            <span aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span>
            <small>{theme === "light" ? "Night" : "Light"}</small>
          </button>
        </div>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/processing" replace />} />
          <Route path="/processing" element={<ProcessingPage />} />
          <Route path="/processing/:sampleId" element={<ProcessingWorkspacePage />} />
          <Route path="/samples" element={<SamplesPage />} />
          <Route path="/samples/new" element={<NewSamplePage />} />
          <Route path="/samples/:sampleId" element={<SamplePage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/templates/:templateId" element={<TemplatePage />} />
          <Route path="/imports/fabublox" element={<Navigate to="/templates?import=1" replace />} />
          <Route path="/export" element={<ExportPage />} />
        </Routes>
      </main>
    </div>
  );
}
