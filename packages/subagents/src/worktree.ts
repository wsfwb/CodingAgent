/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * On completion, if no changes were made, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Branch name created for this worktree (if changes exist). */
  branch: string;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper (e.g. a
   * monorepo package), so the requested scoping survives isolation.
   */
  workPath: string;
}

export type WorktreeCleanupResult =
  | { status: "clean" }
  | { status: "saved"; branch: string }
  | { status: "preservation_failed"; path: string; error: string };

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if the repository cannot host one.
 * Throws when the base working tree has uncommitted changes because a worktree
 * created from HEAD would silently omit them.
 */
export function createWorktree(cwd: string, agentId: string): WorktreeInfo | undefined {
  // Verify we're in a git repo with at least one commit (HEAD must exist)
  let baseSha: string;
  let subdir: string;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "pipe", timeout: 5000 });
    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    // Where cwd sits inside the repo ("" at the root): the agent must work at
    // the same subdirectory inside the copy, or a monorepo-package cwd would
    // silently widen to the whole repo. realpath both sides — git emits
    // resolved paths while cwd may arrive through a symlink (macOS /tmp).
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    subdir = relative(realpathSync(topLevel), realpathSync(cwd));
  } catch {
    return undefined;
  }

  let status: string;
  try {
    status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd,
      stdio: "pipe",
      timeout: 10000,
    }).toString().trim();
  } catch {
    return undefined;
  }
  if (status) {
    throw new Error(
      'Cannot run with isolation: "worktree" because the base repository has uncommitted changes ' +
      "(staged, unstaged, or untracked). Commit or otherwise resolve them before starting an isolated agent.",
    );
  }

  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);

  try {
    // Create detached worktree at HEAD
    execFileSync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
      cwd,
      stdio: "pipe",
      timeout: 30000,
    });
    return { path: worktreePath, branch, baseSha, workPath: subdir ? join(worktreePath, subdir) : worktreePath };
  } catch {
    // If worktree creation fails, return undefined (agent runs in normal cwd)
    return undefined;
  }
}

/**
 * Clean up a worktree after agent completion.
 * - If no changes: remove worktree entirely.
 * - If changes exist: create a branch, commit changes, return branch info.
 */
export function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): WorktreeCleanupResult {
  if (!existsSync(worktree.path)) {
    return {
      status: "preservation_failed",
      path: worktree.path,
      error: "Worktree directory no longer exists; changes could not be verified or preserved.",
    };
  }

  try {
    // Check for uncommitted changes in the worktree
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 10000,
    }).toString().trim();

    if (status) {
      // Changes exist — stage, commit, and create a branch
      execFileSync("git", ["add", "-A"], { cwd: worktree.path, stdio: "pipe", timeout: 10000 });
      // Truncate description for commit message (no shell sanitization needed — execFileSync uses argv)
      const safeDesc = agentDescription.slice(0, 200);
      const commitMsg = `pi-agent: ${safeDesc}`;
      execFileSync("git", ["commit", "--no-verify", "-m", commitMsg], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 10000,
      });
    } else {
      const currentSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      }).toString().trim();

      if (currentSha === worktree.baseSha) {
        // No changes — remove worktree
        removeWorktree(cwd, worktree.path);
        return { status: "clean" };
      }
    }

    // Create a branch pointing to the worktree's HEAD.
    // If the branch already exists, append a suffix to avoid overwriting previous work.
    let branchName = worktree.branch;
    try {
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch {
      // Branch already exists — use a unique suffix
      branchName = `${worktree.branch}-${Date.now()}`;
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      });
    }
    // Update branch name in worktree info for the caller
    worktree.branch = branchName;

    // Remove the worktree (branch persists in main repo)
    removeWorktree(cwd, worktree.path);

    return { status: "saved", branch: worktree.branch };
  } catch (err) {
    return {
      status: "preservation_failed",
      path: worktree.path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Force-remove a worktree.
 */
function removeWorktree(cwd: string, worktreePath: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd,
      stdio: "pipe",
      timeout: 10000,
    });
  } catch {
    // If git worktree remove fails, try pruning
    try {
      execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5000 });
    } catch { /* ignore */ }
  }
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export function pruneWorktrees(cwd: string): void {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5000 });
  } catch { /* ignore */ }
}
