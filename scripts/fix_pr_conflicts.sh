#!/usr/bin/env bash
set -euo pipefail

# Rebuild current PR branch on top of origin/main and replay local commits.
# Includes auto-resolution for recurring conflicts in app.js/index.html,
# keeping the PR commit version for those files.
#
# Usage:
#   scripts/fix_pr_conflicts.sh [base_branch]
# Example:
#   scripts/fix_pr_conflicts.sh main

BASE_BRANCH="${1:-main}"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
AUTO_FILES=("app.js" "index.html")

if [[ "$CURRENT_BRANCH" == "HEAD" ]]; then
  echo "[ERROR] Detached HEAD. Checkout your PR branch first."
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "[ERROR] Remote 'origin' not configured."
  exit 1
fi

echo "[INFO] Fetching origin/${BASE_BRANCH}..."
git fetch origin "${BASE_BRANCH}"

BASE_REF="origin/${BASE_BRANCH}"
if ! git show-ref --verify --quiet "refs/remotes/${BASE_REF}"; then
  echo "[ERROR] Base ref ${BASE_REF} not found after fetch."
  exit 1
fi

COMMITS=$(git rev-list --reverse "${BASE_REF}..${CURRENT_BRANCH}" || true)
if [[ -z "${COMMITS}" ]]; then
  echo "[INFO] No local commits to replay. Branch is already based on ${BASE_REF}."
  exit 0
fi

TS="$(date +%Y%m%d%H%M%S)"
BACKUP_BRANCH="backup/${CURRENT_BRANCH}-${TS}"

echo "[INFO] Creating backup branch: ${BACKUP_BRANCH}"
git branch "${BACKUP_BRANCH}"

echo "[INFO] Resetting ${CURRENT_BRANCH} to ${BASE_REF}"
git reset --hard "${BASE_REF}"

for c in ${COMMITS}; do
  echo "[INFO] Cherry-picking ${c}"
  if git cherry-pick "${c}"; then
    continue
  fi

  echo "[WARN] Conflict while cherry-picking ${c}. Trying auto-resolve for common files..."

  conflict_files="$(git diff --name-only --diff-filter=U || true)"
  if [[ -z "${conflict_files}" ]]; then
    echo "[ERROR] Cherry-pick failed without tracked conflict files."
    exit 2
  fi

  unresolved_other=false
  for f in ${conflict_files}; do
    is_auto=false
    for af in "${AUTO_FILES[@]}"; do
      if [[ "$f" == "$af" ]]; then
        is_auto=true
        break
      fi
    done

    if $is_auto; then
      echo "[INFO] Auto-resolving ${f} with PR commit version (--theirs)."
      git checkout --theirs -- "$f"
      git add "$f"
    else
      unresolved_other=true
      echo "[WARN] Manual conflict required in: ${f}"
    fi
  done

  if $unresolved_other; then
    echo "[ERROR] Conflicts remain outside auto-resolve scope."
    echo "Resolve files, then run:"
    echo "  git add <files>"
    echo "  git cherry-pick --continue"
    echo "After finishing all commits, push with:"
    echo "  git push --force-with-lease origin ${CURRENT_BRANCH}"
    exit 2
  fi

  git cherry-pick --continue
  echo "[INFO] Auto-resolve applied for commit ${c}."
done

echo "[OK] Branch rebuilt on top of ${BASE_REF}."
echo "[NEXT] Push updated branch:"
echo "  git push --force-with-lease origin ${CURRENT_BRANCH}"
