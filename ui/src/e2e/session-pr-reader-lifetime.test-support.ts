export type SyntheticRepository = {
  repo: string;
  branch: string;
  headSha: string;
  number: number;
  additions: number;
  checkName?: string;
};

export function pullRequest(repository: SyntheticRepository) {
  return {
    number: repository.number,
    title: `Review ${repository.repo}`,
    html_url: `https://github.com/synthetic/${repository.repo}/pull/${repository.number}`,
    state: "open",
    draft: false,
    merged_at: null,
    head: { ref: repository.branch, sha: repository.headSha },
    base: { ref: "main", repo: { name: repository.repo, owner: { login: "synthetic" } } },
    additions: repository.additions,
    deletions: 1,
    changed_files: 1,
  };
}

export function syntheticChecksResponse(repository: SyntheticRepository, url: URL) {
  if (url.pathname.endsWith("/check-runs")) {
    return {
      total_count: 1,
      check_runs: [
        {
          id: repository.number,
          name: repository.checkName ?? `${repository.repo} check`,
          head_sha: repository.headSha,
          status: "completed",
          conclusion: "success",
          app: { slug: "github-actions" },
          check_suite: { id: repository.number },
        },
      ],
    };
  }
  if (url.pathname.endsWith("/actions/runs")) {
    return {
      total_count: 1,
      workflow_runs: [
        {
          id: repository.number,
          check_suite_id: repository.number,
          head_sha: repository.headSha,
          run_attempt: 1,
        },
      ],
    };
  }
  if (url.pathname.endsWith(`/actions/runs/${repository.number}/jobs`)) {
    if (url.searchParams.get("filter") !== "all") {
      throw new Error("Checks lookup did not request all job attempts");
    }
    return {
      total_count: 1,
      jobs: [
        {
          id: repository.number + 1000,
          run_id: repository.number,
          run_attempt: 1,
          head_sha: repository.headSha,
          check_run_url: `https://api.github.com/repos/synthetic/${repository.repo}/check-runs/${repository.number}`,
          status: "completed",
          conclusion: "success",
          steps: [],
        },
      ],
    };
  }
  throw new Error(`Unexpected synthetic GitHub request: ${url.pathname}`);
}
