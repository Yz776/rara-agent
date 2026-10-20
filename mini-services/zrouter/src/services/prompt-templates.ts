/**
 * Prompt Templates Library — save & reuse prompts with template variables.
 *
 * Templates have a name, category, content (with {{variable}} placeholders),
 * and optional metadata (tags, expected output format). Variables are
 * substituted at request time.
 *
 * Stored in a SQLite table `prompt_templates` so they survive restarts.
 */

import { Database } from "bun:sqlite";
import { getDb } from "./db";
import crypto from "node:crypto";

export interface PromptTemplate {
  id: string;
  name: string;
  description?: string;
  category: string;
  content: string;
  /** Default values for variables (used when not provided at render time). */
  defaultVars?: Record<string, string>;
  tags: string[];
  /** Suggested model to use with this prompt. */
  suggestedModel?: string;
  createdAt: number;
  updatedAt: number;
}

let initialized = false;

function ensureSchema(): void {
  if (initialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'general',
      content TEXT NOT NULL,
      default_vars TEXT,
      tags TEXT DEFAULT '[]',
      suggested_model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_templates_category ON prompt_templates(category);
    CREATE INDEX IF NOT EXISTS idx_prompt_templates_name ON prompt_templates(name);
  `);
  initialized = true;
}

function parseRow(row: Record<string, unknown>): PromptTemplate {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) || undefined,
    category: (row.category as string) || "general",
    content: row.content as string,
    defaultVars: row.default_vars ? JSON.parse(row.default_vars as string) : undefined,
    tags: row.tags ? JSON.parse(row.tags as string) : [],
    suggestedModel: (row.suggested_model as string) || undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function listTemplates(category?: string): PromptTemplate[] {
  ensureSchema();
  const db = getDb();
  const rows = category
    ? db.prepare("SELECT * FROM prompt_templates WHERE category = ? ORDER BY updated_at DESC").all(category) as Record<string, unknown>[]
    : db.prepare("SELECT * FROM prompt_templates ORDER BY updated_at DESC").all() as Record<string, unknown>[];
  return rows.map(parseRow);
}

export function getTemplate(id: string): PromptTemplate | undefined {
  ensureSchema();
  const db = getDb();
  const row = db.prepare("SELECT * FROM prompt_templates WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? parseRow(row) : undefined;
}

export function createTemplate(opts: {
  name: string;
  description?: string;
  category?: string;
  content: string;
  defaultVars?: Record<string, string>;
  tags?: string[];
  suggestedModel?: string;
}): PromptTemplate {
  ensureSchema();
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO prompt_templates (id, name, description, category, content, default_vars, tags, suggested_model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.name,
    opts.description ?? null,
    opts.category ?? "general",
    opts.content,
    opts.defaultVars ? JSON.stringify(opts.defaultVars) : null,
    JSON.stringify(opts.tags ?? []),
    opts.suggestedModel ?? null,
    now,
    now
  );
  return getTemplate(id)!;
}

export function updateTemplate(id: string, updates: Partial<Omit<PromptTemplate, "id" | "createdAt">>): PromptTemplate | undefined {
  ensureSchema();
  const db = getDb();
  const existing = getTemplate(id);
  if (!existing) return undefined;
  const merged: PromptTemplate = {
    ...existing,
    ...updates,
    updatedAt: Date.now(),
  };
  db.prepare(
    `UPDATE prompt_templates SET name = ?, description = ?, category = ?, content = ?, default_vars = ?, tags = ?, suggested_model = ?, updated_at = ? WHERE id = ?`
  ).run(
    merged.name,
    merged.description ?? null,
    merged.category,
    merged.content,
    merged.defaultVars ? JSON.stringify(merged.defaultVars) : null,
    JSON.stringify(merged.tags),
    merged.suggestedModel ?? null,
    merged.updatedAt,
    id
  );
  return getTemplate(id);
}

export function deleteTemplate(id: string): boolean {
  ensureSchema();
  const db = getDb();
  const result = db.prepare("DELETE FROM prompt_templates WHERE id = ?").run(id);
  return (result.changes ?? 0) > 0;
}

/**
 * Render a template by substituting {{variables}} with provided values.
 * Falls back to defaultVars, then leaves the placeholder unchanged.
 */
export function renderTemplate(template: PromptTemplate, vars?: Record<string, string>): string {
  const allVars = { ...template.defaultVars, ...vars };
  return template.content.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    return allVars[name] ?? match;
  });
}

/** Extract all {{variable}} names from a template content string. */
export function extractVariables(content: string): string[] {
  const matches = content.matchAll(/\{\{(\w+)\}\}/g);
  const seen = new Set<string>();
  for (const m of matches) seen.add(m[1]!);
  return [...seen];
}
