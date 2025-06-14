/**
 * Shared CLI utilities and types
 */

import { red, green, yellow, blue } from "https://deno.land/std@0.224.0/fmt/colors.ts";

// Helper functions
export function success(message: string): void {
  console.log(green(`✅ ${message}`));
}

export function error(message: string): void {
  console.error(red(`❌ ${message}`));
}

export function warning(message: string): void {
  console.warn(yellow(`⚠️  ${message}`));
}

export function info(message: string): void {
  console.log(blue(`ℹ️  ${message}`));
}

// Type definitions
export interface CommandContext {
  args: string[];
  flags: Record<string, unknown>;
  config?: Record<string, unknown> | undefined;
}

export interface Command {
  name: string;
  description: string;
  aliases?: string[];
  subcommands?: Command[];
  action?: (ctx: CommandContext) => Promise<void> | void;
  options?: Option[];
}

export interface Option {
  name: string;
  short?: string;
  description: string;
  type?: "string" | "boolean" | "number";
  default?: unknown;
  required?: boolean;
}