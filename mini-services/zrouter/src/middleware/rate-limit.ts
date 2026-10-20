/**
 * Rate limiting middleware with Redis support (future)
 * Currently using in-memory rate limiting for simplicity
 */

import type { Context } from "elysia";
import type { VirtualKey } from "../services/db";

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

const rateLimits = new Map<string, RateLimitRecord>();

// Virtual key usage tracking: per-key request count in a sliding window
const vkeyUsage = new Map<string, { requests: number; windowStart: number }>();

export interface RateLimitOptions {
  windowMs: number;      // Time window in milliseconds
  maxRequests: number;   // Maximum requests per window
  message?: string;      // Custom error message
  skipPaths?: string[];  // Paths to skip rate limiting
}

const DEFAULT_OPTIONS: RateLimitOptions = {
  windowMs: 60 * 1000,   // 1 minute
  maxRequests: 100,      // 100 requests per minute
  message: "Too many requests, please try again later",
  skipPaths: ["/health"],
};

let options: RateLimitOptions = DEFAULT_OPTIONS;

// Get client IP from context
function getClientIp(ctx: any): string {
  return ctx.ip?.remote ?? ctx.request.headers.get("x-forwarded-for") 
    ?.split(",")[0]?.trim() ?? "unknown";
}

/**
 * Check rate limit for a virtual key. Accepts the VirtualKey object so we can
 * use its `rateLimit` (req/min) field directly.
 *
 * Returns `{ ok, retryAfterSec? }` to match what the chat route expects.
 */
export function checkRateLimit(
  vkey: Pick<VirtualKey, "id" | "rateLimit">,
  clientIp: string
): { ok: boolean; retryAfterSec?: number } {
  if (!vkey) return { ok: true };
  // 0 means unlimited
  if (!vkey.rateLimit || vkey.rateLimit <= 0) return { ok: true };

  const now = Date.now();
  const windowMs = options.windowMs;
  const key = `${vkey.id}:${clientIp}`;
  let record = vkeyUsage.get(key);

  if (!record || now > record.windowStart + windowMs) {
    record = { requests: 0, windowStart: now };
    vkeyUsage.set(key, record);
  }

  if (record.requests >= vkey.rateLimit) {
    const retryAfterSec = Math.ceil((record.windowStart + windowMs - now) / 1000);
    return { ok: false, retryAfterSec: Math.max(retryAfterSec, 1) };
  }

  record.requests += 1;
  vkeyUsage.set(key, record);
  return { ok: true };
}

/**
 * Check quota (lifetime tokens) and credit (USD) for a virtual key.
 * Returns `{ ok, reason? }` to match what the chat route expects.
 */
export function checkQuota(
  vkey: Pick<VirtualKey, "id" | "quotaLimit" | "usageTokens" | "creditLimit" | "usageCost">
): { ok: boolean; reason?: "quota_exceeded" | "insufficient_credit" } {
  if (!vkey) return { ok: true };
  if (vkey.quotaLimit && vkey.quotaLimit > 0 && vkey.usageTokens >= vkey.quotaLimit) {
    return { ok: false, reason: "quota_exceeded" };
  }
  if (vkey.creditLimit && vkey.creditLimit > 0 && vkey.usageCost >= vkey.creditLimit) {
    return { ok: false, reason: "insufficient_credit" };
  }
  return { ok: true };
}

/**
 * Check if model is allowed for this key. `allowedModels` is null (all) or a
 * list of patterns: `*`, `provider/*`, or `provider/model`.
 *
 * NOTE: argument order is (allowedModels, model) to match the call site in
 * chat.ts. (We keep the legacy name for compatibility.)
 */
export function isModelAllowed(
  allowedModels: string[] | null | undefined,
  model: string
): boolean {
  if (!allowedModels || allowedModels.length === 0) return true; // No restrictions

  return allowedModels.some(pattern => {
    if (pattern === "*") return true; // Allow all
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return model.startsWith(prefix);
    }
    return pattern === model;
  });
}

export function setRateLimit(opt: Partial<RateLimitOptions>) {
  options = { ...DEFAULT_OPTIONS, ...opt };
}

export function rateLimiter() {
  return async (ctx: Context, next: () => Promise<any>) => {
    const clientIP = ctx.ip?.remote ?? ctx.request.headers.get("x-forwarded-for") ?? "unknown";
    
    // Skip rate limiting for health checks and selected paths
    if (options.skipPaths?.includes(ctx.path)) {
      return await next();
    }
    
    const now = Date.now();
    const key = `${clientIP}:${ctx.path}`;
    const record = rateLimits.get(key);
    
    if (!record || now > record.resetTime) {
      // New window
      rateLimits.set(key, {
        count: 1,
        resetTime: now + options.windowMs,
      });
      return await next();
    }
    
    if (record.count >= options.maxRequests) {
      // Rate limit exceeded
      const retryAfter = Math.ceil((record.resetTime - now) / 1000);
      
      return new Response(
        JSON.stringify({
          error: {
            message: options.message || "Rate limit exceeded",
            type: "rate_limit_error",
            code: null,
            retryAfter,
          },
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfter),
          },
        }
      );
    }
    
    // Increment count
    record.count += 1;
    rateLimits.set(key, record);
    return await next();
  };
}

export async function getRateLimitStatus(clientIP: string): Promise<{
  remaining: number;
  windowMs: number;
  maxRequests: number;
  resetTime: number;
}> {
  const key = `${clientIP}:*`;
  let totalCount = 0;
  
  for (const [routeKey, record] of rateLimits.entries()) {
    if (routeKey.startsWith(clientIP)) {
      if (Date.now() <= record.resetTime) {
        totalCount += record.count;
      } else {
        rateLimits.delete(routeKey); // Cleanup expired entries
      }
    }
  }
  
  const remaining = Math.max(0, options.maxRequests - totalCount);
  
  return {
    remaining,
    windowMs: options.windowMs,
    maxRequests: options.maxRequests,
    resetTime: options.windowMs,
  };
}
