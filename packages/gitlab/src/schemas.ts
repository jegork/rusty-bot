import { z } from "zod";

export const GitLabUserSchema = z.object({
  id: z.number().optional(),
  username: z.string().optional(),
  name: z.string().optional(),
});

export const GitLabDiffRefsSchema = z.object({
  base_sha: z.string().nullable().optional(),
  start_sha: z.string().nullable().optional(),
  head_sha: z.string().nullable().optional(),
});

export const GitLabMergeRequestSchema = z.object({
  iid: z.number(),
  id: z.number().optional(),
  project_id: z.number().optional(),
  title: z.string(),
  description: z.string().nullable().optional(),
  state: z.string().optional(),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  source_branch: z.string(),
  target_branch: z.string(),
  sha: z.string().nullable().optional(),
  web_url: z.string().optional(),
  author: GitLabUserSchema.nullable().optional(),
  diff_refs: GitLabDiffRefsSchema.nullable().optional(),
});

export const GitLabDiffEntrySchema = z.object({
  old_path: z.string(),
  new_path: z.string(),
  a_mode: z.string().nullable().optional(),
  b_mode: z.string().nullable().optional(),
  new_file: z.boolean().optional(),
  renamed_file: z.boolean().optional(),
  deleted_file: z.boolean().optional(),
  generated_file: z.boolean().optional(),
  collapsed: z.boolean().optional(),
  too_large: z.boolean().optional(),
  diff: z.string(),
});

/** Response shape for GET /merge_requests/:iid/diffs — flat paginated array. */
export const GitLabMergeRequestDiffsSchema = z.array(GitLabDiffEntrySchema);

/** Response shape for GET /repository/compare — diffs are nested under .diffs */
export const GitLabRepositoryCompareSchema = z.object({
  diffs: z.array(GitLabDiffEntrySchema).optional(),
});

export const GitLabNoteSchema = z.object({
  id: z.number(),
  body: z.string().nullable().optional(),
  system: z.boolean().optional(),
  author: GitLabUserSchema.nullable().optional(),
});

export const GitLabNotesSchema = z.array(GitLabNoteSchema);

export const GitLabDiscussionSchema = z.object({
  id: z.string(),
  individual_note: z.boolean().optional(),
  notes: z.array(GitLabNoteSchema),
});

export const GitLabDiscussionsSchema = z.array(GitLabDiscussionSchema);

export const GitLabIssueRefSchema = z.object({
  iid: z.number(),
  project_id: z.number().optional(),
  references: z
    .object({
      full: z.string().optional(),
    })
    .optional(),
});

export const GitLabClosesIssuesSchema = z.array(GitLabIssueRefSchema);

export const GitLabSearchResultSchema = z.array(
  z.object({
    path: z.string().optional(),
    filename: z.string().optional(),
    startline: z.number().optional(),
    data: z.string().optional(),
  }),
);

export const GitLabTreeSchema = z.array(
  z.object({
    name: z.string(),
    type: z.string(),
  }),
);
