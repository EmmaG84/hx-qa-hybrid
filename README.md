# HX CEX Quality Audit

The existing GitHub Pages application uses Anthropic for optional AI scoring and Google Sheets for reviewer corrections. Codex can maintain this code without changing the scoring provider.

## Privacy review

`privacy.js` runs in the browser before scoring. It detects email addresses, common UK and international telephone formats, UK postcodes, numbered street addresses, labelled postal addresses, and names in headers, greetings, signatures and common labelled fields. Repeated detected names use placeholders. Supplier names, destinations and complaint evidence are retained where possible.

Detection is heuristic and can miss or over-remove details. Reviewers must read the entire editable preview. They can remove extra identifiers locally and must confirm their review before scoring. The request uses the reviewed text, including manual edits. The preview treats email content as text, not HTML. No original thread or removed-identifier list is stored in the recovery queue.

## Confirmed correction logging

`override-log.js` keeps outstanding correction metadata on the current device until Google confirms a matching Event ID exists in the shared log. A completed network request alone is never shown as saved. Failed or unconfirmed entries stay visible with retry and CSV download actions, including after a reload. Successful confirmations remove their local recovery records. If browser storage fails, a warning asks the reviewer to download the outstanding corrections before leaving.

The receiver in `apps-script/Code.gs` preserves the existing first eight log columns. Columns I to K hold Event ID, Audit ID and server recording time. A lock and Event ID check prevent retry duplicates. The read-only status endpoint returns only a status and unpredictable Event ID, never a row or personal information. It supports a tightly validated callback to obtain a receipt across origins. Existing open browser tabs using the earlier payload still work during rollout.

New scorecards clear the previous AI baseline. Only changes from the last reported value are logged, including a return to the AI suggestion. Each row is an edit event, rather than a final completed scorecard. Compare the latest event per audit and criterion when analysing final reviewer decisions. Corrections inform human review of the rubric; they do not automatically retrain the AI.

## Maintaining the logger

The private spreadsheet ID belongs in the Apps Script project's **Project settings > Script properties**, under `LOG_SPREADSHEET_ID`. Do not put it in this repository. Set that property before updating the existing bound Apps Script project's `Code.gs` using the tracked receiver. Save it, then use **Deploy > Manage deployments > Edit > New version** to update the existing deployment. Preserve its existing execution identity, URL and access permissions. Deploy the receiver before publishing frontend changes. If the endpoint changes intentionally, update `SHEET_URL` in `index.html`.

Keep the Google Sheet private. The existing receiver accepts writes through its web app; this update does not introduce authenticated reviewer identities or migrate it to a private application backend. The shared, centrally held API key and team sign-in are separate migration work. Never commit an API key or add one to frontend source. The current app still uses the reviewer's browser-session Anthropic key.

## Verification

Run `node --test tests/*.test.cjs` using Node.js 20 or newer. Tests use fictional threads and mocked network/storage/Sheets services, including offline recovery, missing receipts, retry deduplication and safe rendering. No API key or paid model request is required.
