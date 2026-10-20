/**
 * Authentication Routes
 * 
 * Endpoints:
 *   POST /api/auth/login           - User login
 *   POST /api/auth/logout          - User logout  
 *   GET  /api/auth/me              - Current user info
 *   POST /api/auth/users           - Create new user (admin only)
 *   GET  /api/auth/users           - List users (admin only)
 *   DELETE /api/auth/users/:id     - Delete user (admin only)
 */

import { Elysia } from "elysia";
import crypto from "node:crypto";
import * as authService from "../services/auth-user";
import * as configStore from "../services/config-store";

export const authRoutes = new Elysia({ prefix: "/api/auth" });

// Helper to extract cookie value from request
function getCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  
  // Parse cookies manually
  for (const cookie of cookieHeader.split(";")) {
    const [key, ...valueParts] = cookie.trim().split("=");
    if (key === name) {
      return valueParts.join("=") || null;
    }
  }
  return null;
}

// Login
authRoutes.post("/login", async (ctx) => {
  const { username, password } = ctx.body;
  
  if (!username || !password) {
    return { error: "Username and password required" };
  }
  
  const user = authService.authenticateUser(username, password);
  if (!user) {
    return { error: "Invalid credentials" };
  }
  
  const session = authService.createSession(user.id, ctx.request.headers.get("user-agent") ?? undefined, ctx.ip ?? undefined);
  
  // Set cookie via Response header
  const headers = new Headers();
  const cookieValue = `kr_session=${session.token}; Path=/; HttpOnly; Max-Age=${7 * 24 * 60 * 60}`;
  
  // Check if HTTPS for secure flag
  const isSecure = ctx.request.headers.get("x-forwarded-proto") === "https";
  if (isSecure) {
    headers.append("Set-Cookie", `${cookieValue}; Secure; SameSite=Lax`);
  } else {
    headers.append("Set-Cookie", `${cookieValue}; SameSite=Lax`);
  }
  
  return new Response(JSON.stringify({
    success: true,
    user: { id: user.id, username: user.username, role: user.role },
    token: session.token,
  }), {
    status: 200,
    headers: { ...Object.fromEntries(headers), "Content-Type": "application/json" },
  });
});

// Logout
authRoutes.post("/logout", async (ctx) => {
  const sessionToken = getCookie(ctx.request, "kr_session");
  if (sessionToken) {
    authService.invalidateSession(sessionToken);
  }
  
  // Set cookie via Response header
  const headers = new Headers();
  headers.append("Set-Cookie", `kr_session=; Path=/; HttpOnly; Max-Age=-1`);
  
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...Object.fromEntries(headers), "Content-Type": "application/json" },
  });
});

// Get current user
authRoutes.get("/me", async (ctx) => {
  const sessionToken = getCookie(ctx.request, "kr_session");
  if (!sessionToken) {
    return { authenticated: false };
  }
  
  const session = authService.validateSession(sessionToken);
  if (!session) {
    return { authenticated: false };
  }
  
  const user = authService.findUserById(session.userId);
  if (!user) {
    return { authenticated: false };
  }
  
  return {
    authenticated: true,
    user: { id: user.id, username: user.username, role: user.role },
    expiresAt: session.expiresAt,
  };
});

// Create user (admin only) — self-registration is disabled.
// This is the ONLY endpoint that creates new users.
authRoutes.post("/users", async (ctx) => {
  // Check admin permission
  const sessionToken = getCookie(ctx.request, "kr_session");
  if (!sessionToken) {
    ctx.set.status = 401;
    return { error: "Unauthorized" };
  }

  const session = authService.validateSession(sessionToken);
  if (!session) {
    ctx.set.status = 401;
    return { error: "Unauthorized — session expired" };
  }

  const user = authService.findUserById(session.userId);
  if (!user || user.role !== "admin") {
    ctx.set.status = 403;
    return { error: "Admin access required" };
  }

  const { username, password, role } = ctx.body as { username?: string; password?: string; role?: string };

  if (!username || !password) {
    ctx.set.status = 400;
    return { error: "Username and password required" };
  }
  if (typeof username !== "string" || !/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    ctx.set.status = 400;
    return { error: "Username must be 3-32 chars, only letters/digits/_/-" };
  }
  if (typeof password !== "string" || password.length < 6) {
    ctx.set.status = 400;
    return { error: "Password must be at least 6 characters" };
  }
  const finalRole: "admin" | "user" = role === "admin" ? "admin" : "user";

  try {
    const newUser = authService.createUser(username, password, finalRole);
    return { success: true, user: { id: newUser.id, username: newUser.username, role: newUser.role } };
  } catch (err) {
    if (err instanceof Error && err.message.includes("already exists")) {
      ctx.set.status = 409;
      return { error: "Username already taken" };
    }
    throw err;
  }
});

// List users (admin only)
authRoutes.get("/users", async (ctx) => {
  const sessionToken = getCookie(ctx.request, "kr_session");
  if (!sessionToken) {
    ctx.set.status = 401;
    return { error: "Unauthorized" };
  }

  const session = authService.validateSession(sessionToken);
  if (!session) {
    ctx.set.status = 401;
    return { error: "Unauthorized — session expired" };
  }

  const user = authService.findUserById(session.userId);
  if (!user || user.role !== "admin") {
    ctx.set.status = 403;
    return { error: "Admin access required" };
  }

  const users = authService.listUsers();
  return {
    users: users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    })),
  };
});

// Delete user (admin only)
authRoutes.delete("/users/:id", async (ctx) => {
  const sessionToken = getCookie(ctx.request, "kr_session");
  if (!sessionToken) {
    ctx.set.status = 401;
    return { error: "Unauthorized" };
  }

  const session = authService.validateSession(sessionToken);
  if (!session) {
    ctx.set.status = 401;
    return { error: "Unauthorized — session expired" };
  }

  const currentUser = authService.findUserById(session.userId);
  if (!currentUser || currentUser.role !== "admin") {
    ctx.set.status = 403;
    return { error: "Admin access required" };
  }

  const targetId = ctx.params.id;
  if (targetId === session.userId) {
    ctx.set.status = 400;
    return { error: "Cannot delete yourself" };
  }

  authService.deleteUser(targetId);
  return { success: true };
});

// Change password
authRoutes.put("/password", async (ctx) => {
  const sessionToken = getCookie(ctx.request, "kr_session");
  if (!sessionToken) {
    ctx.set.status = 401;
    return { error: "Unauthorized" };
  }

  const session = authService.validateSession(sessionToken);
  if (!session) {
    ctx.set.status = 401;
    return { error: "Unauthorized — session expired" };
  }

  const { oldPassword, newPassword } = ctx.body as { oldPassword?: string; newPassword?: string };
  if (!oldPassword || !newPassword) {
    ctx.set.status = 400;
    return { error: "Old and new passwords required" };
  }
  if (typeof newPassword !== "string" || newPassword.length < 6) {
    ctx.set.status = 400;
    return { error: "New password must be at least 6 characters" };
  }

  const user = authService.findUserById(session.userId);
  if (!user) {
    ctx.set.status = 404;
    return { error: "User not found" };
  }

  // Verify old password by re-authenticating
  const authResult = authService.authenticateUser(user.username, oldPassword);
  if (!authResult) {
    ctx.set.status = 401;
    return { error: "Current password incorrect" };
  }

  authService.changePassword(user.id, newPassword);
  return { success: true };
});

// Change password from the login page. No session required — proving the old
// password IS the authentication. The login panel never accepts admin API keys
// (zr-/kr-): those are for /v1 and MCP clients only, never for dashboard login.
authRoutes.post("/change-password", async (ctx) => {
  const { username, oldPassword, newPassword } = ctx.body as {
    username?: string;
    oldPassword?: string;
    newPassword?: string;
  };
  if (!username || !oldPassword || !newPassword) {
    ctx.set.status = 400;
    return { error: "Username, current password, and new password are required" };
  }
  if (typeof newPassword !== "string" || newPassword.length < 6) {
    ctx.set.status = 400;
    return { error: "New password must be at least 6 characters" };
  }
  const user = authService.authenticateUser(username, oldPassword);
  if (!user) {
    ctx.set.status = 401;
    return { error: "Username or current password is incorrect" };
  }
  authService.changePassword(user.id, newPassword);
  return { success: true, message: "Password changed. Login with the new password." };
});

// Active sessions list
authRoutes.get("/sessions", async (ctx) => {
  const sessionToken = getCookie(ctx.request, "kr_session");
  if (!sessionToken) {
    return { error: "Unauthorized" };
  }
  
  const session = authService.validateSession(sessionToken);
  if (!session) {
    return { error: "Unauthorized" };
  }
  
  const sessions = authService.listActiveSessions();
  // Only show sessions belonging to the current user (compare by userId since
  // SessionRecord exposes userId, not username).
  return {
    sessions: sessions.filter((s) => s.userId === session.userId),
  };
});
