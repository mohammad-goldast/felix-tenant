/**
 * Value formatting + safety helpers shared by every panel renderer.
 *
 * Two jobs live here that repeatedly broke in per-artifact dashboards:
 *  1. BigInt handling — DuckDB/Arrow return INT64 as BigInt; JSON/`toLocaleString`
 *     choke on it. `toNumber` normalises once, centrally.
 *  2. XSS — all data flows through `esc` before touching innerHTML.
 */
import type { ValueFormat } from "./spec";
/** Escape a string for safe insertion into innerHTML. */
export declare function esc(value: unknown): string;
/** Coerce Arrow/DuckDB scalar (incl. BigInt) to a JS number, or null. */
export declare function toNumber(value: unknown): number | null;
/** Format a single value according to a declarative `ValueFormat`. */
export declare function formatValue(value: unknown, fmt?: ValueFormat): string;
/** Human-readable byte size for the size-gate messaging. */
export declare function formatBytes(bytes: number): string;
