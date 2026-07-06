#!/usr/bin/env node
// roadmap set <invoke> field=value [...] — edit one slice's fields from the shell.
// Values are YAML scalars/flow (deps=[s1,s2], priority='{tier: P1, weight: 60}'),
// field=@path reads the value from a file (multiline prompts/briefs), field=null deletes.
// Same allow-list + pre-write gate as the MCP set_fields tool.

import { readFileSync } from "node:fs";
import YAML from "yaml";
import { parseAssignments } from "./lib/cli-core.mjs";
import { mutateRoadmap } from "./lib/store.mjs";
import { setFields } from "./lib/mcp-core.mjs";

const args = process.argv.slice(2);
const invoke = args.find((a) => !a.includes("=") && !a.startsWith("-"));
const assigns = args.filter((a) => a.includes("="));
if (!invoke || !assigns.length) {
  console.error("usage: roadmap set <invoke> field=value [field2=value2 ...]   (field=@file reads a file; field=null deletes)");
  process.exit(2);
}

try {
  const fields = {};
  for (const a of parseAssignments(assigns)) {
    fields[a.field] = a.fromFile !== undefined ? readFileSync(a.fromFile, "utf8") : YAML.parse(a.raw);
  }
  const r = mutateRoadmap(process.cwd(), (doc) => setFields(doc, { invoke, fields }));
  console.log(`✓ ${invoke}: set ${r.fields.join(", ")}  (re-rendered ${r.rerendered})`);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
