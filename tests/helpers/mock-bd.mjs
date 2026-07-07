export function makeIssue(id, overrides = {}) {
  return {
    id,
    title: id,
    description: "Implement the scoped work.",
    acceptance_criteria: "Validation evidence is recorded.",
    status: "open",
    issue_type: "task",
    labels: ["ready-for-agent"],
    ...overrides,
  };
}

export function createMockBd(initialIssues = []) {
  const issues = new Map(initialIssues.map((issue) => [issue.id, { ...issue, labels: [...(issue.labels ?? [])] }]));
  const calls = [];
  let createCount = 0;
  function json(value) {
    return { stdout: JSON.stringify(value) };
  }
  async function runBd(args, meta) {
    calls.push({ args, meta });
    const command = args[0];
    if (command === "where") return { stdout: "/tmp/project/.beads\n" };
    if (command === "status") return json({ ready: [...issues.values()].filter((issue) => issue.status === "open").length });
    if (command === "ready") return json([...issues.values()].filter((issue) => issue.status === "open"));
    if (command === "show") {
      const id = args[args.indexOf("--id") + 1];
      return json([issues.get(id)]);
    }
    if (command === "update") {
      const id = args[1];
      const issue = issues.get(id);
      if (args.includes("--claim")) {
        issue.status = "in_progress";
        issue.assignee = "agent@example.com";
      }
      if (args.includes("--status")) issue.status = args[args.indexOf("--status") + 1];
      if (args.includes("--assignee")) {
        const assignee = args[args.indexOf("--assignee") + 1];
        if (assignee) issue.assignee = assignee;
        else delete issue.assignee;
      }
      if (args.includes("--append-notes")) issue.notes = `${issue.notes ?? ""}\n${args[args.indexOf("--append-notes") + 1]}`.trim();
      return { stdout: `updated ${id}\n` };
    }
    if (command === "close") {
      const issue = issues.get(args[1]);
      issue.status = "closed";
      issue.close_reason = args[args.indexOf("--reason") + 1];
      return { stdout: `closed ${issue.id}\n` };
    }
    if (command === "create") {
      createCount += 1;
      const id = `followup-${createCount}`;
      const issue = makeIssue(id, {
        title: args[args.indexOf("--title") + 1],
        description: args[args.indexOf("--description") + 1],
        issue_type: args[args.indexOf("--type") + 1],
        priority: Number(args[args.indexOf("--priority") + 1]),
      });
      issues.set(id, issue);
      return json(issue);
    }
    if (command === "dep" && args[1] === "add") {
      const issue = issues.get(args[2]);
      issue.dependencies = [...(issue.dependencies ?? []), { depends_on_id: args[3], type: args[args.indexOf("--type") + 1] }];
      return { stdout: `dep added ${args[2]} ${args[3]}\n` };
    }
    if (command === "list") {
      // Emulate bd's truncation: default limit 50, `--limit 0` means unlimited.
      const matching = [...issues.values()].filter((issue) => issue.status === "in_progress");
      const limitIdx = args.indexOf("--limit");
      const rawLimit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 50;
      const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
      const limited = limit === 0 ? matching : matching.slice(0, limit);
      return json(limited);
    }
    if (command === "lint" || command === "orphans" || command === "find-duplicates") return json([]);
    if (command === "dep" && args[1] === "cycles") return json([]);
    throw new Error(`Unexpected bd command: ${args.join(" ")}`);
  }
  return { runBd, calls, issues };
}
