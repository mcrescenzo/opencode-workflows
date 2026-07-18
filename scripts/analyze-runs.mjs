#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runRoots } from "../workflow-kernel/run-store-status.js";

function parseArgs(argv) {
  const args = { roots: [], format: "markdown", cwd: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") args.roots.push(path.resolve(argv[++i]));
    else if (arg.startsWith("--root=")) args.roots.push(path.resolve(arg.slice("--root=".length)));
    else if (arg === "--cwd") args.cwd = path.resolve(argv[++i]);
    else if (arg.startsWith("--cwd=")) args.cwd = path.resolve(arg.slice("--cwd=".length));
    else if (arg === "--json") args.format = "json";
    else if (arg === "--markdown") args.format = "markdown";
    else if (arg === "--format") {
      // A missing following value (argv[++i] === undefined) or an unknown
      // value must be rejected rather than silently coercing to "markdown".
      const value = argv[++i];
      if (value !== "json" && value !== "markdown") throw new Error("--format requires json or markdown");
      args.format = value;
    }
    else if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      if (value !== "json" && value !== "markdown") throw new Error("--format requires json or markdown");
      args.format = value;
    }
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.roots.length === 0) args.roots = runRoots({ directory: args.cwd, worktree: args.cwd });
  args.roots = [...new Set(args.roots.map((root) => path.resolve(root)))];
  return args;
}

async function readJson(filePath, fallback = null, warnings = []) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") warnings.push(`${filePath}: ${error.message}`);
    return fallback;
  }
}

async function readJsonl(filePath, warnings = []) {
  const records = [];
  let invalidLines = 0;
  try {
    const content = await fs.readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        invalidLines += 1;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") warnings.push(`${filePath}: ${error.message}`);
  }
  return { records, invalidLines };
}

function bucket(map, key) {
  const normalized = key || "unknown";
  if (!map[normalized]) {
    map[normalized] = {
      lanes: 0,
      success: 0,
      failure: 0,
      timeout: 0,
      budgetStopped: 0,
      correctiveAttempts: 0,
      correctiveRetryLanes: 0,
      tokens: { input: 0, output: 0, reasoning: 0 },
      cost: 0,
      queueWait: { count: 0, totalMs: 0, maxMs: 0 },
    };
  }
  return map[normalized];
}

function addTokens(target, tokens = {}) {
  target.input += Number.isFinite(tokens.input) ? tokens.input : 0;
  target.output += Number.isFinite(tokens.output) ? tokens.output : 0;
  target.reasoning += Number.isFinite(tokens.reasoning) ? tokens.reasoning : 0;
}

function addLaneStats(stats, lane) {
  stats.lanes += 1;
  if (lane.outcome === "success") stats.success += 1;
  else if (lane.outcome === "timeout") stats.timeout += 1;
  else if (lane.outcome === "budget_stopped") stats.budgetStopped += 1;
  else if (lane.outcome) stats.failure += 1;
  const correctiveAttempts = Number.isFinite(lane.correctiveAttempts) ? lane.correctiveAttempts : 0;
  stats.correctiveAttempts += correctiveAttempts;
  if (correctiveAttempts > 0) stats.correctiveRetryLanes += 1;
  addTokens(stats.tokens, lane.tokens);
  stats.cost += Number.isFinite(lane.cost) ? lane.cost : 0;
  if (Number.isFinite(lane.queueWaitMs)) {
    stats.queueWait.count += 1;
    stats.queueWait.totalMs += lane.queueWaitMs;
    stats.queueWait.maxMs = Math.max(stats.queueWait.maxMs, lane.queueWaitMs);
  }
}

async function readLaneFiles(runDir, state, warnings) {
  const lanes = [];
  const seen = new Set();
  try {
    const lanesDir = path.join(runDir, "lanes");
    const dirents = await fs.readdir(lanesDir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith(".json")) continue;
      if (dirent.name.endsWith(".request.json") || dirent.name.endsWith(".result.json")) continue;
      const lane = await readJson(path.join(lanesDir, dirent.name), null, warnings);
      if (lane?.callId) {
        lanes.push(lane);
        seen.add(lane.callId);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") warnings.push(`${runDir}/lanes: ${error.message}`);
  }
  for (const lane of Array.isArray(state?.laneRecords) ? state.laneRecords : []) {
    if (lane?.callId && !seen.has(lane.callId)) lanes.push(lane);
  }
  return lanes;
}

async function analyzeRun(runDir) {
  const warnings = [];
  const state = await readJson(path.join(runDir, "state.json"), {}, warnings);
  const journal = await readJsonl(path.join(runDir, "journal.jsonl"), warnings);
  const events = await readJsonl(path.join(runDir, "events.jsonl"), warnings);
  const lanes = await readLaneFiles(runDir, state, warnings);
  return {
    id: state?.id ?? path.basename(runDir),
    dir: runDir,
    status: state?.status ?? "unknown",
    workflow: state?.meta?.name ?? "unknown",
    model: state?.defaultChildModel ?? "unknown",
    lanes,
    journal: journal.records,
    events: events.records,
    invalidJsonlLines: journal.invalidLines + events.invalidLines,
    warnings,
  };
}

async function listRunDirs(root) {
  try {
    const dirents = await fs.readdir(root, { withFileTypes: true });
    return dirents.filter((dirent) => dirent.isDirectory() || dirent.isSymbolicLink()).map((dirent) => path.join(root, dirent.name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function summarizeQueueWait(stats) {
  if (!stats.queueWait.count) return { count: 0, avgMs: null, maxMs: null };
  return {
    count: stats.queueWait.count,
    avgMs: Math.round(stats.queueWait.totalMs / stats.queueWait.count),
    maxMs: stats.queueWait.maxMs,
  };
}

async function analyzeRuns({ roots }) {
  const result = {
    generatedAt: new Date().toISOString(),
    roots,
    runsScanned: 0,
    warnings: [],
    invalidJsonlLines: 0,
    byRole: {},
    byModel: {},
    byWorkflow: {},
    cacheEvents: {},
  };
  for (const root of roots) {
    for (const runDir of await listRunDirs(root)) {
      const run = await analyzeRun(runDir);
      result.runsScanned += 1;
      result.invalidJsonlLines += run.invalidJsonlLines;
      result.warnings.push(...run.warnings);
      const workflowStats = bucket(result.byWorkflow, run.workflow);
      for (const lane of run.lanes) {
        addLaneStats(bucket(result.byRole, lane.role), lane);
        addLaneStats(bucket(result.byModel, lane.model ?? run.model), lane);
        addLaneStats(workflowStats, lane);
      }
      for (const event of run.events) {
        if (typeof event?.type === "string" && event.type.startsWith("cache.")) {
          result.cacheEvents[event.type] = (result.cacheEvents[event.type] ?? 0) + 1;
        }
      }
    }
  }
  for (const group of [result.byRole, result.byModel, result.byWorkflow]) {
    for (const stats of Object.values(group)) {
      stats.queueWait = summarizeQueueWait(stats);
    }
  }
  return result;
}

function markdownTable(title, rows) {
  const lines = [`### ${title}`, "", "| Key | Lanes | Success | Failure | Timeout | Corrective attempts | Queue avg/max | Cost |", "| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |"];
  for (const [key, stats] of Object.entries(rows).sort((a, b) => b[1].lanes - a[1].lanes || a[0].localeCompare(b[0]))) {
    const queue = stats.queueWait.count ? `${stats.queueWait.avgMs}/${stats.queueWait.maxMs} ms` : "-";
    lines.push(`| ${key} | ${stats.lanes} | ${stats.success} | ${stats.failure} | ${stats.timeout} | ${stats.correctiveAttempts} | ${queue} | ${stats.cost.toFixed(4)} |`);
  }
  if (Object.keys(rows).length === 0) lines.push("| none | 0 | 0 | 0 | 0 | 0 | - | 0.0000 |");
  return lines.join("\n");
}

function renderMarkdown(result) {
  const lines = [
    "# Workflow Run Analytics",
    "",
    `Generated: ${result.generatedAt}`,
    `Roots: ${result.roots.join(", ") || "none"}`,
    `Runs scanned: ${result.runsScanned}`,
    `Invalid JSONL lines skipped: ${result.invalidJsonlLines}`,
    "",
    "## Cache Events",
    "",
    Object.keys(result.cacheEvents).length
      ? Object.entries(result.cacheEvents).sort().map(([type, count]) => `- ${type}: ${count}`).join("\n")
      : "- none",
    "",
    markdownTable("By Workflow", result.byWorkflow),
    "",
    markdownTable("By Role", result.byRole),
    "",
    markdownTable("By Model", result.byModel),
  ];
  if (result.warnings.length > 0) {
    lines.push("", "## Warnings", "", ...result.warnings.slice(0, 50).map((warning) => `- ${warning}`));
    if (result.warnings.length > 50) lines.push(`- ... ${result.warnings.length - 50} more`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    return [
      "Usage: node scripts/analyze-runs.mjs [--root DIR ...] [--format markdown|json]",
      "",
      "Read-only analyzer for .opencode/workflows/runs directories.",
    ].join("\n");
  }
  const result = await analyzeRuns(args);
  return args.format === "json" ? `${JSON.stringify(result, null, 2)}\n` : renderMarkdown(result);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().then((output) => process.stdout.write(output)).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export { analyzeRuns, main, parseArgs, renderMarkdown };
