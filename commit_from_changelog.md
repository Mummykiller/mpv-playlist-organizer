# Committing Changes to CHANGELOG.md

To create a commit message for `CHANGELOG.md`:

1.  **Review Changes:**
    View your staged changes to `CHANGELOG.md`:
    ```sh
    git diff --staged CHANGELOG.md
    ```
    If changes are unstaged, first run `git add CHANGELOG.md`.

2.  **Draft Commit Message:**
    *   **Subject:** Concise, following `docs: Update CHANGELOG for vX.Y.Z` or `docs: Update changelog with recent activity`.
    *   **Body (Optional):** Summarize key updates from the changelog using bullet points.

    **Example:**
    ```
    docs: Update CHANGELOG for v1.2.3

    - feat: Add support for anilist release tracking
    - fix: Correctly handle playlist reordering
    ```

3.  **Commit:**
    Run `git commit` to open an editor, or use `-m` for a quick commit:
    ```sh
    git commit -m "Subject line" -m "Body line 1\n- Body bullet 1\n- Body bullet 2"
    ```