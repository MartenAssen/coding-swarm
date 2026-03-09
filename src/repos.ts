/**
 * Multi-repo support. Parses GITHUB_REPOS env var into a map of label → repo config.
 * Format: "label1:owner/repo1,label2:owner/repo2"
 * Falls back to GITHUB_REPO + REPO_DIR for single-repo deployments.
 */

export interface RepoConfig {
  label: string;
  repo: string;      // "owner/repo"
  repoDir: string;   // "/data/repos/<label>"
}

const REPOS_BASE_DIR = "/data/repos";

function parseRepoMap(): Map<string, RepoConfig> {
  const raw = process.env.GITHUB_REPOS;
  if (!raw) return new Map();

  const map = new Map<string, RepoConfig>();
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      console.warn(`[repos] Skipping invalid GITHUB_REPOS entry (no colon): "${trimmed}"`);
      continue;
    }
    const label = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const repo = trimmed.slice(colonIdx + 1).trim();
    if (!label || !repo) {
      console.warn(`[repos] Skipping invalid GITHUB_REPOS entry: "${trimmed}"`);
      continue;
    }
    map.set(label, { label, repo, repoDir: `${REPOS_BASE_DIR}/${label}` });
  }
  return map;
}

const repoMap = parseRepoMap();

/**
 * Get all configured repos (for startup cloning).
 * Falls back to single GITHUB_REPO if GITHUB_REPOS is not set.
 */
export function getAllRepos(): RepoConfig[] {
  if (repoMap.size > 0) return [...repoMap.values()];

  // Legacy single-repo fallback
  const repo = process.env.GITHUB_REPO;
  if (!repo) return [];
  return [{ label: "_default", repo, repoDir: process.env.REPO_DIR || "/data/repo" }];
}

/**
 * Match an issue's labels against the repo map.
 * Returns the first matching repo config, or null if no match.
 */
export function getRepoForIssue(labels: string[]): RepoConfig | null {
  if (repoMap.size === 0) {
    // Legacy mode: return single repo if set
    const repo = process.env.GITHUB_REPO;
    if (!repo) return null;
    return { label: "_default", repo, repoDir: process.env.REPO_DIR || "/data/repo" };
  }

  for (const lbl of labels) {
    const config = repoMap.get(lbl.toLowerCase());
    if (config) return config;
  }
  return null;
}

/**
 * Get the list of known repo labels (for PM to list in comments).
 */
export function getRepoLabels(): string[] {
  return [...repoMap.keys()];
}
