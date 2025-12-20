import requests
import sys
import argparse
import re
from datetime import datetime

def extract_repo_and_pr(pr_url):
    """Extract owner, repo, and pull number from a GitHub PR URL."""
    match = re.match(r"https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)", pr_url)
    if not match:
        raise ValueError("Invalid GitHub PR URL")
    owner, repo, pull_number = match.groups()
    return owner, repo, pull_number

def fetch_last_n_issue_comments(pr_url, user="qodo-code-review[bot]", n=2, token=None):
    """
    Fetch the last n general issue/PR comments (conversation comments) made by a specific user on a PR.
    
    Many AI review bots like Qodo post their full feedback as a regular comment in the conversation timeline,
    rather than as a formal 'review' or inline comments.
    """
    owner, repo, pull_number = extract_repo_and_pr(pr_url)
    
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    
    url = f"https://api.github.com/repos/{owner}/{repo}/issues/{pull_number}/comments"
    
    params = {
        "sort": "created",
        "direction": "desc",
        "per_page": 100
    }
    
    response = requests.get(url, headers=headers, params=params)
    response.raise_for_status()
    comments = response.json()
    
    user_comments = [c for c in comments if c["user"]["login"] == user]
    
    # Sort by created_at descending (API already does desc, but ensure)
    user_comments_sorted = sorted(user_comments, key=lambda c: datetime.fromisoformat(c["created_at"].rstrip('Z')), reverse=True)
    
    last_n = user_comments_sorted[:n]
    
    if not last_n:
        print(f"No general comments found from user '{user}'.")
        print("\nPossible reasons:")
        print(" - The bot uses a different username (try checking the PR page for the exact login, e.g., with [bot] suffix).")
        print(" - The feedback is posted as a review (not a comment).")
        print(" - No feedback from the bot on this PR.")
        return
    
    print(f"Last {len(last_n)} general comment(s) by '{user}':\n")
    for i, comment in enumerate(last_n, 1):
        print(f"{i}. Posted at: {comment['created_at']}")
        print(f"   Body:\n{comment['body']}")
        print(f"   URL: {comment['html_url']}\n")

def main():
    parser = argparse.ArgumentParser(description="Fetch the last n general comments by a specific user on a GitHub PR (conversation timeline).")
    parser.add_argument("pr_link", help="GitHub Pull Request URL")
    parser.add_argument("--user", default="qodo-code-review[bot]", help="GitHub username to filter comments (default: qodo-code-review; try adding [bot] if needed)")
    parser.add_argument("--n", type=int, default=2, help="Number of last comments to fetch (default: 2)")
    parser.add_argument("--token", help="GitHub Personal Access Token (optional, for private repos or higher rate limits)")
    
    args = parser.parse_args()
    
    try:
        fetch_last_n_issue_comments(args.pr_link, args.user, args.n, args.token)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
