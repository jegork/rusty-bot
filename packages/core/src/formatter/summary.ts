import type {
  ReviewResult,
  Severity,
  Finding,
  Observation,
  DroppedFinding,
  TriageStats,
  OpenGrepStats,
  TicketComplianceStatus,
  TicketResolutionStatus,
} from "../types.js";

const SEVERITY_ORDER: Severity[] = ["critical", "warning", "suggestion"];

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "CRITICAL",
  warning: "WARNING",
  suggestion: "SUGGESTION",
};

const RECOMMENDATION_TEXT: Record<ReviewResult["recommendation"], string> = {
  looks_good: "Looks good!",
  address_before_merge: "Address before merge",
  critical_issues: "Critical issues found",
};

const TICKET_COMPLIANCE_LABEL: Record<TicketComplianceStatus, string> = {
  addressed: "Addressed",
  partially_addressed: "Partially addressed",
  not_addressed: "Not addressed",
  unclear: "Unclear",
};

function sanitizeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, "<br/>");
}

function buildIssueTable(items: (Finding | Observation)[]): string {
  const rows = items.map((item) => `| \`${item.file}\` | ${item.line} | ${item.message} |`);
  return ["| File | Line | Issue |", "|------|------|-------|", ...rows].join("\n");
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    critical: 0,
    warning: 0,
    suggestion: 0,
  };
  for (const f of findings) {
    counts[f.severity]++;
  }
  return counts;
}

function buildTriageSection(stats: TriageStats): string {
  const lines: string[] = [];
  lines.push("<details>");
  lines.push("<summary>Triage Summary</summary>");
  lines.push("");
  lines.push("| Classification | Files |");
  lines.push("|----------------|-------|");
  lines.push(`| Skipped | ${stats.filesSkipped} |`);
  lines.push(`| Skimmed | ${stats.filesSkimmed} |`);
  lines.push(`| Deep Reviewed | ${stats.filesDeepReviewed} |`);
  lines.push("");
  lines.push(`Triage model: \`${stats.triageModelUsed}\` · ${stats.triageTokenCount} tokens`);
  lines.push("");
  lines.push("</details>");
  lines.push("");
  return lines.join("\n");
}

function buildOpenGrepStatsSection(stats: OpenGrepStats): string {
  const lines: string[] = [];
  if (stats.error) {
    lines.push(`> **OpenGrep pre-scan:** ⚠️ ${stats.error}`);
  } else if (!stats.available) {
    lines.push(
      "> **OpenGrep:** not available (install `opengrep` for deterministic SAST pre-scan)",
    );
  } else if (stats.findingCount === 0) {
    lines.push("> **OpenGrep pre-scan:** clean — no findings");
  } else {
    lines.push(`> **OpenGrep pre-scan:** ${stats.findingCount} finding(s) fed to LLM for triage`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildDroppedFindingsSection(dropped: DroppedFinding[], passes: number): string {
  const lines: string[] = [];
  lines.push("<details>");
  lines.push(
    `<summary>Filtered findings (${dropped.length} dropped by consensus, voted below threshold)</summary>`,
  );
  lines.push("");
  lines.push("| File | Line | Severity | Message | Votes |");
  lines.push("|------|------|----------|---------|-------|");
  for (const f of dropped) {
    lines.push(
      `| \`${f.file}\` | ${f.line} | ${f.severity} | ${sanitizeTableCell(f.message)} | ${f.voteCount}/${passes} |`,
    );
  }
  lines.push("");
  lines.push("</details>");
  lines.push("");
  return lines.join("\n");
}

function buildElevatedConcernsSection(
  dropped: DroppedFinding[],
  passes: number,
  threshold: number,
): string {
  const lines: string[] = [];
  lines.push(`## Elevated Concerns (${dropped.length})`);
  lines.push("");
  lines.push(
    `> No finding reached the consensus threshold of ${threshold}/${passes} passes, but each pass raised a concern. ` +
      `The overall recommendation was elevated because multiple passes agreed something needs attention, ` +
      `even though they did not agree on what. Review these manually — they may be real issues, noise, ` +
      `or different angles on the same underlying problem.`,
  );
  lines.push("");
  lines.push("| File | Line | Severity | Message | Votes |");
  lines.push("|------|------|----------|---------|-------|");
  for (const f of dropped) {
    lines.push(
      `| \`${f.file}\` | ${f.line} | ${f.severity} | ${sanitizeTableCell(f.message)} | ${f.voteCount}/${passes} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildTicketFetchMessage(status: TicketResolutionStatus): string {
  if (status.totalRefsFound === 0) {
    return "No linked ticket references detected.";
  }

  const cappedSuffix =
    status.refsSkippedByLimit > 0
      ? ` (found ${status.totalRefsFound}, reviewed first ${status.refsConsidered})`
      : "";

  const detailParts: string[] = [];
  if (status.consideredMissingProvider > 0) {
    detailParts.push(`${status.consideredMissingProvider} skipped due to missing provider`);
  }
  if (status.consideredFetchFailed > 0) {
    detailParts.push(`${status.consideredFetchFailed} failed to fetch`);
  }

  if (status.fetched > 0) {
    const detailSuffix = detailParts.length > 0 ? ` ${detailParts.join(", ")}.` : "";
    return `Fetched ${status.fetched} of ${status.refsConsidered} linked ticket(s)${cappedSuffix}.${detailSuffix}`;
  }

  if (status.consideredMissingProvider > 0 && status.consideredFetchFailed === 0) {
    return `Found ${status.refsConsidered} linked ticket reference(s)${cappedSuffix}, but no matching ticket provider was configured.`;
  }

  if (status.consideredFetchFailed > 0 && status.consideredMissingProvider === 0) {
    return `Found ${status.refsConsidered} linked ticket reference(s)${cappedSuffix}, but ${status.consideredFetchFailed} fetch${status.consideredFetchFailed === 1 ? " failed" : "es failed"}.`;
  }

  return `Found ${status.refsConsidered} linked ticket reference(s)${cappedSuffix}, but could not fetch ticket details. ${detailParts.join(", ")}.`;
}

export function formatSummaryComment(
  review: ReviewResult,
  options?: { ticketResolution?: TicketResolutionStatus },
): string {
  const counts = countBySeverity(review.findings);
  const totalIssues = review.findings.length;

  const droppedCount = review.droppedFindings?.length ?? 0;
  const isElevatedWithoutSurvivors =
    review.consensusMetadata?.recommendationElevated === true &&
    totalIssues === 0 &&
    droppedCount > 0;

  const lines: string[] = [];

  lines.push("# Code Review Summary");
  lines.push("");
  lines.push("---");
  lines.push("");
  const statusSuffix = isElevatedWithoutSurvivors
    ? ` — ${droppedCount} elevated concern${droppedCount === 1 ? "" : "s"} below`
    : "";
  lines.push(
    `**Status:** ${totalIssues} Issues Found${statusSuffix} | **Recommendation:** ${RECOMMENDATION_TEXT[review.recommendation]}`,
  );
  lines.push("");

  if (review.triageStats) {
    lines.push(buildTriageSection(review.triageStats));
  }

  if (review.openGrepStats) {
    lines.push(buildOpenGrepStatsSection(review.openGrepStats));
  }

  if (isElevatedWithoutSurvivors && review.droppedFindings && review.consensusMetadata) {
    lines.push(
      buildElevatedConcernsSection(
        review.droppedFindings,
        review.consensusMetadata.passes,
        review.consensusMetadata.threshold,
      ),
    );
  }

  lines.push("## Overview");
  lines.push("");
  lines.push("| Severity | Count |");
  lines.push("|----------|-------|");
  for (const sev of SEVERITY_ORDER) {
    lines.push(`| ${SEVERITY_LABEL[sev]} | ${counts[sev]} |`);
  }
  lines.push("");

  const severitiesWithFindings = SEVERITY_ORDER.filter((sev) => counts[sev] > 0);

  lines.push("<details>");
  lines.push("<summary>Issue Details (click to expand)</summary>");
  lines.push("");

  if (severitiesWithFindings.length === 0) {
    lines.push("No issues found.");
    lines.push("");
  } else {
    for (const sev of severitiesWithFindings) {
      const items = review.findings.filter((f) => f.severity === sev);
      lines.push(SEVERITY_LABEL[sev]);
      lines.push("");
      lines.push(buildIssueTable(items));
      lines.push("");
    }
  }

  lines.push("</details>");
  lines.push("");

  if (
    !isElevatedWithoutSurvivors &&
    review.droppedFindings &&
    review.droppedFindings.length > 0 &&
    review.consensusMetadata
  ) {
    lines.push(
      buildDroppedFindingsSection(review.droppedFindings, review.consensusMetadata.passes),
    );
  }

  if (options?.ticketResolution && options.ticketResolution.totalRefsFound > 0) {
    lines.push("## Ticket Fetch");
    lines.push("");
    lines.push(buildTicketFetchMessage(options.ticketResolution));
    lines.push("");
  }

  if (review.observations.length > 0) {
    lines.push("<details>");
    lines.push("<summary>Other Observations (not in diff)</summary>");
    lines.push("");
    lines.push("Issues found in unchanged code that cannot receive inline comments:");
    lines.push("");
    lines.push(buildIssueTable(review.observations));
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  if (review.ticketCompliance.length > 0) {
    lines.push("<details>");
    lines.push(
      `<summary>Ticket Compliance (${review.ticketCompliance.length} requirements)</summary>`,
    );
    lines.push("");
    lines.push("| Ticket | Requirement | Status | Evidence |");
    lines.push("|--------|-------------|--------|----------|");
    for (const item of review.ticketCompliance) {
      lines.push(
        `| ${sanitizeTableCell(item.ticketId ?? "—")} | ${sanitizeTableCell(item.requirement)} | ${TICKET_COMPLIANCE_LABEL[item.status]} | ${sanitizeTableCell(item.evidence ?? "—")} |`,
      );
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  if (review.missingTests.length > 0) {
    lines.push("<details>");
    lines.push(
      `<summary>Missing Tests (${review.missingTests.length} suggested test cases)</summary>`,
    );
    lines.push("");
    lines.push("| File | Suggested Test Case |");
    lines.push("|------|---------------------|");
    for (const item of review.missingTests) {
      lines.push(`| \`${item.file}\` | ${sanitizeTableCell(item.description)} |`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  const fileIssueCounts = new Map<string, number>();
  for (const file of review.filesReviewed) {
    fileIssueCounts.set(file, 0);
  }
  for (const f of review.findings) {
    fileIssueCounts.set(f.file, (fileIssueCounts.get(f.file) ?? 0) + 1);
  }

  lines.push("<details>");
  lines.push(`<summary>Files Reviewed (${review.filesReviewed.length} files)</summary>`);
  lines.push("");
  for (const file of review.filesReviewed) {
    const count = fileIssueCounts.get(file) ?? 0;
    lines.push(`- \`${file}\` - ${count} issues`);
  }
  lines.push("");
  lines.push("</details>");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(review.summary);
  lines.push("");
  lines.push("---");
  lines.push("");
  // prefer successfulPassModels (only models whose pass actually returned a
  // result) so failed passes aren't credited. fall back to passModels for
  // historical metadata that pre-dates the field, then to review.modelUsed.
  const successfulModels = review.consensusMetadata?.successfulPassModels;
  const configuredModels = review.consensusMetadata?.passModels;
  const reviewerSource =
    successfulModels && successfulModels.length > 0 ? successfulModels : (configuredModels ?? []);
  const reviewerLabel =
    reviewerSource.length > 0 ? Array.from(new Set(reviewerSource)).join(", ") : review.modelUsed;
  const parts = [`Reviewed by ${reviewerLabel} · ${review.tokenCount} tokens (review)`];
  if (review.judgeStatus === "failed") {
    parts.push("judge pass failed — findings unfiltered");
  } else {
    if (review.judgeTokenCount !== undefined) {
      parts.push(`${review.judgeTokenCount} tokens (judge)`);
    }
    if (review.filteredCount !== undefined) {
      parts.push(`${review.filteredCount} low-confidence findings filtered`);
    }
  }
  if (review.consensusMetadata) {
    const cm = review.consensusMetadata;
    parts.push(
      cm.failedPasses > 0
        ? `consensus ${cm.passes} passes (${cm.failedPasses} failed)`
        : `consensus ${cm.passes} passes`,
    );
    parts.push(`${Math.round(cm.agreementRate * 100)}% agreement`);
    if (cm.recommendationElevated) {
      parts.push("recommendation elevated from pass votes");
    }
    if (cm.degraded) {
      parts.push("degraded — judge filtering only");
    }
  }
  if (review.openGrepStats?.available && review.openGrepStats.findingCount > 0) {
    parts.push(`opengrep: ${review.openGrepStats.findingCount} pre-scan findings`);
  }
  lines.push(parts.join(" · "));
  lines.push("");

  return lines.join("\n");
}
