import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./App";
import { installCommentFileRouting } from "./lib/comment-file-routing";
import { installProcessPlanCommentDraftGuard } from "./lib/process-plan-comment-draft-guard";
import "./styles.css";
import "./palette.css";
import "./comment-layout.css";
import "./sample-page-layout.css";
import "./processing-form-roles.css";

installCommentFileRouting();
installProcessPlanCommentDraftGuard();

const router = createBrowserRouter([{
  path: "*",
  element: <App />,
}]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
