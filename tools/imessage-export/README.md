# Messages group-chat exporter (read-only, offline)

Exports **one** iMessage/SMS conversation from the macOS Messages database into:

| File | What it is |
|---|---|
| `messages.csv` | One row per message, oldest first. UTF-8 with BOM so Excel shows emoji and accents correctly. |
| `messages.pdf` | Printable transcript, grouped by day. Every page has a header with participants and date range, plus "Page X of Y". |
| `attachments/` | Copies of the attachments, named `YYYY-MM-DD_HHMMSS_msg<ID>_<n>_<original name>` so they sort by date. |
| `export_log.txt` | Message counts, first and last dates, SHA-256 of the database copy, and every warning. |

Each run writes to a new folder, `exports/export_YYYY-MM-DD_HHMMSS/`.

## What it does to keep your data safe

* **The original database is never opened.** `~/Library/Messages/chat.db`, `chat.db-wal` and `chat.db-shm` are only *byte-copied* into a private temporary folder (permissions 700). SQLite then opens **the copy**, in read-only mode (`mode=ro` and `PRAGMA query_only`).
* The tool prints the SHA-256 of each copied file and the time the copy was made. It compares each copy against its original, and at the end it checks that the originals' size and modification time did not change.
* The temporary copy is deleted when the run finishes. Pass `--keep-copy` if you want to keep it.
* **No network.** The code imports no networking modules: no `socket`, `urllib`, `http` or `requests`. To check this yourself:

  ```bash
  grep -nE "import (socket|urllib|http|requests|ssl)" *.py
  ```

  That command should print nothing. You can also switch off Wi-Fi while running the tool; it works the same.
* Attachments are copied out of `~/Library/Messages/Attachments`. Nothing there is changed.
* The `.gitignore` keeps `config.json`, `exports/` and any `.db` file out of git.

## Requirements

* macOS with Python 3.9 or newer. The command `python3 --version` shows your version. If Python is missing, macOS offers to install the Command Line Tools the first time you run `python3`.
* Python standard library, plus **reportlab**, which is used only to create the PDF:

  ```bash
  python3 -m pip install --user reportlab
  ```

  Without reportlab you still get the CSV, the attachments and the log, with a warning that the PDF was skipped.

## Setup

1. **Grant Full Disk Access** to the app you will run the tool from (Terminal or Cursor):
   **System Settings → Privacy & Security → Full Disk Access →** turn on **Terminal** (or **Cursor**).
   If the app isn't in the list, click **+** and add it (Terminal is in Applications → Utilities). Then **quit the app with Cmd+Q and reopen it**. If you skip this step, the tool stops and prints these same instructions. You can turn the switch off again after exporting.
2. **Quit the Messages app** (Cmd+Q) so the database isn't changing while it is copied. Messages on your iPhone is not affected.
3. Copy `config.example.json` to `config.json` and edit it:

   ```json
   {
     "me_name": "Me",
     "participants": [
       { "name": "Alex",  "handles": ["+1 555 010 1234"] },
       { "name": "Sam",   "handles": ["+1 555 010 9876", "sam@example.com"] }
     ],
     "start_date": null,
     "end_date": null,
     "timezone": null,
     "include_reactions": true
   }
   ```

   * `handles`: every phone number and email address that person messages from. Formatting doesn't matter, and `+1 (555) 010-1234` matches `5550101234`. If you're unsure, list both their phone number and their iCloud email.
   * `start_date` / `end_date`: optional, `"YYYY-MM-DD"`, both inclusive. Use `null` for no limit.
   * `timezone`: `null` uses the Mac's time zone, with daylight saving applied correctly for each date. You can set a fixed zone instead, such as `"America/New_York"`.
   * `include_reactions`: `false` leaves out tapbacks entirely. By default they are kept and labelled.
   * Optional: `"page_size": "A4"`, `"pdf_footer": "..."`, `"output_dir": "..."`, `"pdf_font": "/path/to/font.ttf"`, `"csv_formula_guard": false`.

## Run it

```bash
cd /path/to/imessage-export
python3 export_chat.py
```

* The tool finds the chat whose members are **exactly** the people in `config.json`. The same group often exists as more than one chat, for example an iMessage version and an SMS version, or a duplicate created by iCloud. When that happens, the tool lists every match with its message count and date span and asks you to choose one, or **A** to merge them all.
* If nothing matches, it lists the chats that contain *some* of your participants. That usually means a phone number or email is missing from `config.json`.

Useful options:

```bash
python3 export_chat.py --list-chats
```

Lists every group chat with its members and message count.

```bash
python3 export_chat.py --chat-id 12
```

Skips matching and exports chat 12. Repeat `--chat-id` to merge several chats.

```bash
python3 export_chat.py --start 2022-01-01 --end 2022-12-31
```

Exports a date range. These options override the dates in `config.json`.

```bash
python3 export_chat.py --no-attachments
```

Exports the CSV and PDF only, without copying attachments.

The exit code is 0 on success, 1 on error, and 2 if the count check failed. Even when the count check fails, the files are still written so you can investigate.

## Try it on fake data first

```bash
./run_test.sh
```

This script builds a fake database in `test_data/` with invented people (555-01xx numbers and example.com emails) and exports it. The fake data deliberately includes:
messages stored in the old seconds date format and the new nanoseconds format, text stored only in `attributedBody`, an attachment-only message, an attachment that is missing from the Mac, a heart reaction, an emoji tapback, a reaction that was added and then removed, an edited message with its earlier version, an unsent message, a threaded reply, group events, emoji plus Japanese, Greek and Russian text, a sender who isn't listed in the config, a second matching chat (SMS), and messages that exist only in the `-wal` file.

## How to check the results

1. **Count check.** At the end, the tool prints the number of messages it exported next to a direct `SELECT COUNT(*)` on that chat. It prints `COUNT CHECK: OK` when they match.
2. **Spot-check against your phone.** Choose 3–4 dates spread across the years, open those days in Messages, and compare them with the PDF and the CSV. The `message ID` column (shown in the PDF as `#123`) identifies each row exactly.
3. **Read `export_log.txt`.** It lists every warning: attachments that aren't on the Mac, senders that aren't in your config, and messages whose text could not be decoded.
4. **Search** by opening `messages.csv` in Excel or Numbers and using Find or a filter.
5. **Integrity.** The log records the SHA-256 of the database copy and of `messages.csv` and `messages.pdf`. To confirm later that the files haven't changed:

   ```bash
   shasum -a 256 messages.csv messages.pdf
   ```

## Columns in messages.csv

`date`, `time (local)`, `sender`, `direction` (sent/received), `message text`, `attachment file name(s)`, `message ID`, then `message type` (message / reaction / reaction removed / group event), `reaction / reacted to` (the ID and an excerpt of the message that was reacted to), `reply to`, `edited`, `earlier versions (edited)`, `unsent`, `service` (iMessage/SMS) and `timestamp (UTC)`.

## Things to know

* **Attachments in iCloud.** With "Messages in iCloud" turned on, older photos and files may not be stored on the Mac. Those rows show `name [file not on this Mac]` and are listed in the log. To download them first, open the conversation in Messages and scroll back through it, or open Messages → Settings → iMessage and wait for syncing to finish.
* **Emoji in the PDF.** PDF fonts can't draw Apple's colour emoji, so an emoji the font lacks is written as a placeholder such as `[emoji: face with tears of joy]`, and flags as `[flag: JP]`. **The CSV always keeps the real characters.** The PDF uses Arial Unicode (included with macOS), which covers most languages. Right-to-left scripts such as Arabic and Hebrew may print with the letters in the wrong order in the PDF, so use the CSV for those.
* **Excel formulas.** A message that starts with `=`, `+`, `-` or `@` gets a leading `'` in the CSV. Without it, Excel treats the message as a formula and shows an error or runs it. The PDF shows the text unchanged. To turn this off, set `"csv_formula_guard": false`.
* **Edited and unsent messages** are flagged when the database records them (macOS 13 and later). Earlier versions of an edited message are recovered when they are stored in `message_summary_info`. This is best effort, because Apple doesn't document the format.
* **Former members.** People who left the group are shown by their phone number or email. Add them to `config.json` if you want a name. Because they are no longer members, they don't affect how the chat is matched.
* Only the conversation you choose is exported. Other chats in the database are never written anywhere.
