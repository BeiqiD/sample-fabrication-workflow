import { lazy, Suspense } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { NewSamplePage } from "./pages/NewSamplePage";
import { SamplePage } from "./pages/SamplePage";
import { TemplatesPage } from "./pages/TemplatesPage";
import { ExportPage } from "./pages/ExportPage";
import { EntryPage } from "./pages/EntryPage";
import { TemplatePage } from "./pages/TemplatePage";

const ImportPage = lazy(() => import("./pages/ImportPage").then((module) => ({ default: module.ImportPage })));

export function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <NavLink to="/" className="brand">
          <span className="brand-mark">SL</span>
          <span>Sample Log</span>
        </NavLink>
        <nav>
          <NavLink to="/" end>Samples</NavLink>
          <NavLink to="/entry">Record</NavLink>
          <NavLink to="/templates">Templates</NavLink>
          <NavLink to="/imports/fabublox">Import</NavLink>
          <NavLink to="/export">Export</NavLink>
        </nav>
      </header>
      <main><Suspense fallback={<div className="page"><p className="muted">Loading…</p></div>}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/samples/new" element={<NewSamplePage />} />
          <Route path="/entry" element={<EntryPage />} />
          <Route path="/samples/:sampleId" element={<SamplePage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/templates/:templateId" element={<TemplatePage />} />
          <Route path="/imports/fabublox" element={<ImportPage />} />
          <Route path="/export" element={<ExportPage />} />
        </Routes>
      </Suspense></main>
    </div>
  );
}
