# Google Antigravity

LearnHarness uses Google's official Antigravity CLI (`agy`) over Agent Client Protocol (ACP). Model menus and usage label its billing **Antigravity (subscription)**; LearnHarness shows no dollar estimate. Requests use your Antigravity plan's model access and limits.

## Set up

1. Open **Settings → Providers → External CLI** and enable **Antigravity**.
2. Select **Install**. LearnHarness downloads about 220 MB from Google, verifies the release's SHA-512 checksum, and installs the executable in its data directory.
3. Select **Sign in** and complete Google sign-in in the system browser. If the browser does not open, use **Open sign-in link ↗** when it appears. Complete sign-in in a browser on the computer running LearnHarness so Google can reach the CLI's local callback.
4. Wait for your plan tier and model count to appear, then choose an Antigravity model. Use **Refresh models** if your plan or model access changes.

Select **Update** when a newer version is available. **Remove downloaded runtime** removes the installation while keeping your profile and catalog. Wait for active Antigravity requests to finish if the current runtime is in use.

## What goes through the CLI

The CLI receives the LearnHarness system prompt, the conversation context needed for the request, and images when included. Tool calls and results pass through a local bridge for LearnHarness tools. Google processes the resulting model requests. LearnHarness stores the model list and reported context window for reuse and records the plan tier and time of sign-in locally. The CLI owns Google credentials and authentication.

LearnHarness starts the CLI in an empty temporary workspace, supplies a private profile to isolate CLI configuration, advertises no client file or terminal access, appends a preamble telling the model that only LearnHarness tools work, and denies every ACP permission request except approved LearnHarness tool calls. Built-in tools cannot be switched off over ACP, so with agy 1.5.12:

- Commands and file writes (inside or outside the workspace) ask permission and are denied.
- File reads inside the empty workspace run without asking; reads outside it ask and are denied.
- **Web search (`search_web`) runs without asking.** Queries go to Google like the model request itself.
- Subagent and scheduling tools can start, but their file and command work goes through the same denied permissions, and they stop when LearnHarness ends the CLI process.

These are application-level controls. The CLI still runs with the server user's OS permissions and has no OS sandbox. LearnHarness tools continue to use their own permissions and file-access settings.

## Questions, reuse, and usage

The persisted LearnHarness transcript is authoritative. A tool call holds the CLI session open until LearnHarness returns the result, so an answered question continues the same Antigravity session. agy abandons a held tool call after about 3 minutes (not configurable over ACP in agy 1.5.12); LearnHarness then ends that session, and the answer starts a fresh session that replays the conversation as labelled text (like [Claude Code](claude-code.md)). Held sessions also end after 10 minutes idle or on a server restart.

Each model's context window comes from agy (for example 131,072 tokens for GPT-OSS 120B and about 1M for Gemini and Claude). Context usage is agy's per-call report; output tokens are the whole prompt's. Cache-read counts are not shown.

On macOS, Antigravity stores Google sign-in in a Keychain item shared by agy installations for the same OS user. To sign out, use `agy` itself. Disabling Antigravity in LearnHarness or removing its managed runtime leaves that login intact.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Installation fails | Confirm the computer can reach Google's update server and Google Cloud Storage. macOS and Linux require the system `tar` executable. Retry if checksum verification failed. |
| Sign-in times out | Open the fallback link on the computer running LearnHarness and complete the Google flow before retrying. |
| Model is missing | Confirm the intended plan tier is shown, then select **Refresh models**. |
| A request fails after sign-in | Check authentication, model access, and quota in your Antigravity account. |
| Removal reports the runtime is in use | Let active Antigravity requests finish, then retry. |

Verify AI claims independently—they may be inaccurate, incomplete, misleading, or outdated.
