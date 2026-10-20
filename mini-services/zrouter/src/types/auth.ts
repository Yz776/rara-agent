/**
 * Authentication & Authorization Types
 */

export interface AuthUser {
  id: string;
  username: string;
  passwordHash: string;
  role: "admin" | "user";
  createdAt: number;
  lastLoginAt?: number;
}

export interface Session {
  token: string;
  userId: string;
  expiresAt: number;
  userAgent?: string;
  ip?: string;
}

export interface VirtualKeyWithPermissions {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  rateLimit: number; // req/min
  quotaLimit: number; // lifetime tokens
  usageTokens: number;
  creditLimit: number; // USD
  usageCost: number;
  allowedModels: string[] | null; // null = all models allowed
  denyModels: string[]; // explicit deny list
  roles: ("read" | "write" | "admin")[];
  expiresAt?: number; // key expiry timestamp
  createdAt: number;
}

export interface PermissionCheck {
  allowed: boolean;
  reason?: string;
}

// Role-based access control levels
export const ROLE_LEVELS: Record<string, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

export function hasRole(key: VirtualKeyWithPermissions, requiredRole: string): boolean {
  if (!key.roles || key.roles.length === 0) return false;
  const userLevel = ROLE_LEVELS[key.roles[0]!] ?? 0;
  const requiredLevel = ROLE_LEVELS[requiredRole] ?? 0;
  return userLevel >= requiredLevel;
}

export function isModelAllowed(allowedModels: string[] | null, denyModels: string[], model: string): boolean {
  // Deny list takes precedence
  if (denyModels.includes(model)) return false;
  
  // If no allowlist specified, all models are allowed
  if (!allowedModels || allowedModels.length === 0) return true;
  
  // Check if model matches any in allowlist
  return allowedModels.some((allowed) => {
    if (allowed.endsWith("*")) {
      // Wildcard match: "anthropic/*" matches "anthropic/claude-3"
      const prefix = allowed.slice(0, -1);
      return model.startsWith(prefix);
    }
    return model === allowed || model.startsWith(`${allowed}/`);
  });
}

export function checkExpiry(key: VirtualKeyWithPermissions): boolean {
  if (!key.expiresAt) return true;
  return Date.now() < key.expiresAt;
}
