import { createBrowserRouter } from "react-router-dom";
import { AppLayout } from "./layouts/app-layout";
import { ConnectionsPage } from "./routes/connections";
import { HomePage } from "./routes/home";
import { LoginPage } from "./routes/login";
import { NotFoundPage } from "./routes/not-found";
import { SetupPage } from "./routes/setup";
import { requireSessionLoader, setupLoader } from "./auth/require-session";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      {
        index: true,
        element: <HomePage />,
        loader: requireSessionLoader,
      },
      {
        path: "connections",
        element: <ConnectionsPage />,
        loader: requireSessionLoader,
      },
      { path: "setup", element: <SetupPage />, loader: setupLoader },
      { path: "login", element: <LoginPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
