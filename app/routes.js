import { index, route } from "@remix-run/route-config";

export default [
  index("routes/_index.jsx"),
  route("app", "routes/app._index.jsx"),
  route("auth/*", "routes/auth.$.jsx"),
  route("auth/callback", "routes/auth.callback.jsx"),
  route("auth/login", "routes/auth.login.jsx"),
  route("auth/token-status", "routes/auth.token-status.jsx"),
  route("chat", "routes/chat.jsx"),
];