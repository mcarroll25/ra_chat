import { flatRoutes } from "@remix-run/fs-routes";

export default flatRoutes({
  appDirectory: "app",
  ignoredRouteFiles: ["**/.*", "**/*.css", "**/*.test.{js,jsx,ts,tsx}"]
});