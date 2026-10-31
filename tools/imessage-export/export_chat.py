#!/usr/bin/env python3
"""
export_chat.py - export ONE iMessage/SMS group conversation from the macOS
Messages database to CSV + PDF, read-only and fully offline.

Safety model
  * The original ~/Library/Messages/chat.db (+ -wal, -shm) is never opened by
    SQLite. The three files are byte-copied into a private temporary folder
    and only that copy is opened, with sqlite3 in read-only mode (mode=ro).
  * No network access of any kind: this file imports no networking modules.
    (reportlab, used for the PDF, is only given local file paths.)
  * Attachment files are read (copied) from ~/Library/Messages/Attachments;
    nothing there is changed.

Python 3.9+ standard library, plus reportlab for the PDF.
"""

import argparse
import csv
import datetime as dt
import hashlib
import html
import json
import os
import plistlib
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

TOOL_VERSION = "1.0"
APPLE_EPOCH = 978307200          # 2001-01-01 00:00:00 UTC as a Unix timestamp
NS_THRESHOLD = 100_000_000_000   # Apple dates above this are nanoseconds, below are seconds
OBJ_REPLACEMENT = "￼"       # placeholder char Messages puts where an attachment sits

# SQL: Apple date (s or ns since 2001) -> Unix seconds. Handles both formats per row.
SQL_UNIX_TS = (
    "((CASE WHEN ABS(m.date) > {t} THEN m.date / 1000000000.0 ELSE m.date * 1.0 END) + {e})"
    .format(t=NS_THRESHOLD, e=APPLE_EPOCH)
)

FDA_HELP = """
Cannot read the Messages database: permission denied.

macOS protects ~/Library/Messages. The app you are running this from
(Terminal, iTerm, or Cursor) needs Full Disk Access:

  1. Open System Settings (Apple menu > System Settings).
  2. Click "Privacy & Security" in the sidebar.
  3. Scroll down and click "Full Disk Access".
  4. Turn ON the switch for Terminal (or Cursor / iTerm).
     If it is not listed, click the "+" button, go to Applications
     (Terminal is in Applications > Utilities), select it, click Open.
  5. Enter your password if asked.
  6. QUIT the app completely (Cmd+Q) and open it again, then re-run this tool.

Full Disk Access only lets the app READ the file; this tool never changes it.
You can turn the switch off again after exporting.
"""

REACTION_VERBS = {
    0: "Loved", 1: "Liked", 2: "Disliked", 3: "Laughed at",
    4: "Emphasized", 5: "Questioned", 6: "Reacted {emoji} to", 7: "Put a sticker on",
}


class ExportError(Exception):
    pass


# --------------------------------------------------------------------------- helpers

def sha256_file(path, bufsize=1024 * 1024):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(bufsize), b""):
            h.update(chunk)
    return h.hexdigest()


def apple_to_unix(value):
    """Apple Messages timestamp -> Unix seconds (float), or None if unset."""
    if value is None:
        return None
    try:
        v = int(value)
    except (TypeError, ValueError):
        return None
    if v == 0:
        return None
    return APPLE_EPOCH + (v / 1e9 if abs(v) > NS_THRESHOLD else float(v))


def normalize_handle(h):
    """Phone numbers -> digits only (leading 00 dropped). Emails -> lowercase."""
    h = (h or "").strip()
    if "@" in h:
        return h.lower()
    digits = re.sub(r"\D", "", h)
    if digits.startswith("00"):
        digits = digits[2:]
    return digits


def handles_match(a, b):
    """True if two handles (raw strings) refer to the same address."""
    na, nb = normalize_handle(a), normalize_handle(b)
    if not na or not nb:
        return False
    if "@" in na or "@" in nb:
        return na == nb
    if na == nb:
        return True
    # +1 555... vs 555...: allow a missing country code, but require >= 7 digits overlap
    short, long_ = sorted((na, nb), key=len)
    return len(short) >= 7 and long_.endswith(short)


def decode_attributed_body(blob):
    """
    Extract the plain text from a Messages `attributedBody` blob.

    The blob is an NSArchiver "typedstream" of an NSAttributedString. The text
    is stored right after the NSString class marker as:
        ... "NSString" 0x01 0x94|0x95 0x84 0x01 '+' <length> <utf-8 bytes> ...
    where <length> is one byte (< 0x80), or 0x81 + 2-byte little-endian,
    or 0x82 + 4-byte little-endian.
    Returns None if the blob cannot be decoded.
    """
    if not blob:
        return None
    blob = bytes(blob)
    for marker in (b"NSString", b"NSMutableString"):
        start = blob.find(marker)
        while start != -1:
            p = blob.find(b"\x84\x01+", start, start + len(marker) + 16)
            if p != -1:
                i = p + 3
                if i >= len(blob):
                    break
                lb = blob[i]
                if lb == 0x81:
                    n = int.from_bytes(blob[i + 1:i + 3], "little")
                    i += 3
                elif lb == 0x82:
                    n = int.from_bytes(blob[i + 1:i + 5], "little")
                    i += 5
                elif lb == 0x83:
                    n = int.from_bytes(blob[i + 1:i + 9], "little")
                    i += 9
                else:
                    n = lb
                    i += 1
                raw = blob[i:i + n]
                if len(raw) == n:
                    return raw.decode("utf-8", errors="replace")
            start = blob.find(marker, start + 1)
    return None


def clean_text(t):
    if t is None:
        return ""
    t = t.replace(OBJ_REPLACEMENT, "").replace("\r\n", "\n").replace("\r", "\n")
    return t.strip()


def shorten(t, n=60):
    t = " ".join((t or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


def safe_filename(name, maxlen=120):
    name = unicodedata.normalize("NFC", name or "attachment")
    name = re.sub(r'[\x00-\x1f/\\:*?"<>|]', "_", name).strip(" .") or "attachment"
    if len(name) > maxlen:
        stem, ext = os.path.splitext(name)
        name = stem[: maxlen - len(ext)] + ext
    return name


def strip_guid_prefix(g):
    """associated_message_guid looks like 'p:0/GUID' or 'bp:GUID'."""
    if not g:
        return None
    if "/" in g:
        return g.split("/", 1)[1]
    if g.startswith("bp:"):
        return g[3:]
    return g


# --------------------------------------------------------------------------- config

def load_config(path):
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    except FileNotFoundError:
        raise ExportError(
            f"Config file not found: {path}\n"
            "Copy config.example.json to config.json and fill in the two participants."
        )
    except json.JSONDecodeError as e:
        raise ExportError(f"config.json is not valid JSON: {e}")

    parts = cfg.get("participants")
    if not isinstance(parts, list) or not parts:
        raise ExportError('config.json needs a "participants" list (one entry per other person).')
    norm = []
    for i, p in enumerate(parts, 1):
        if isinstance(p, str):
            p = {"handles": [p]}
        handles = p.get("handles") or ([p["handle"]] if p.get("handle") else [])
        if isinstance(handles, str):
            handles = [handles]
        handles = [h for h in handles if str(h).strip()]
        if not handles:
            raise ExportError(f"Participant #{i} in config.json has no phone number / email.")
        norm.append({"name": (p.get("name") or handles[0]).strip(), "handles": handles})
    cfg["participants"] = norm
    cfg.setdefault("me_name", "Me")
    return cfg


def parse_date(s, label):
    if not s:
        return None
    try:
        return dt.date.fromisoformat(str(s))
    except ValueError:
        raise ExportError(f"{label} must be YYYY-MM-DD, got {s!r}")


# --------------------------------------------------------------------------- snapshot

def originals_state(src_dir):
    state = {}
    for name in ("chat.db", "chat.db-wal", "chat.db-shm"):
        p = src_dir / name
        try:
            st = os.stat(p)
            state[name] = (st.st_size, st.st_mtime_ns)
        except FileNotFoundError:
            state[name] = None
    return state


def messages_app_running():
    if sys.platform != "darwin":
        return False
    try:
        r = subprocess.run(["pgrep", "-x", "Messages"], capture_output=True, timeout=5)
        return r.returncode == 0
    except Exception:
        return False


def snapshot_database(src_dir, work_dir, log):
    """Byte-copy chat.db (+wal, +shm) into work_dir. Never opens the originals with SQLite."""
    src_db = src_dir / "chat.db"
    try:
        os.stat(src_db)
        with open(src_db, "rb") as f:
            f.read(16)
    except PermissionError:
        raise ExportError(FDA_HELP)
    except FileNotFoundError:
        try:
            os.listdir(src_dir)
        except PermissionError:
            raise ExportError(FDA_HELP)
        except FileNotFoundError:
            pass
        raise ExportError(f"Messages database not found at {src_db}")

    copied = {}
    made_at = dt.datetime.now().astimezone()
    for name in ("chat.db", "chat.db-wal", "chat.db-shm"):
        s = src_dir / name
        d = work_dir / name
        try:
            shutil.copy2(s, d)   # reads the source, writes only the destination
        except FileNotFoundError:
            continue
        except PermissionError:
            raise ExportError(FDA_HELP)
        copied[name] = d

    hashes = {name: sha256_file(p) for name, p in copied.items()}
    for name in copied:
        src_hash = sha256_file(src_dir / name)
        if src_hash != hashes[name]:
            log.warn(
                f"{name}: the original changed while it was being copied (Messages was "
                "probably writing to it). Quit Messages and re-run for a clean snapshot."
            )
    return copied, hashes, made_at


def open_readonly(db_path):
    uri = Path(db_path).resolve().as_uri() + "?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA query_only = ON")
    return con


# --------------------------------------------------------------------------- logging

class Log:
    def __init__(self):
        self.lines = []
        self.warnings = []

    def info(self, msg=""):
        print(msg)
        self.lines.append(msg)

    def warn(self, msg):
        print("WARNING: " + msg)
        self.warnings.append(msg)


# --------------------------------------------------------------------------- chat discovery

def load_handles(con):
    return {r["ROWID"]: r["id"] for r in con.execute("SELECT ROWID, id FROM handle")}


def chat_summaries(con, chat_ids=None):
    where = ""
    args = []
    if chat_ids is not None:
        where = "WHERE c.ROWID IN (%s)" % ",".join("?" * len(chat_ids))
        args = list(chat_ids)
    rows = con.execute(f"""
        SELECT c.ROWID AS chat_id, c.guid, c.chat_identifier, c.display_name, c.service_name,
               (SELECT COUNT(*) FROM chat_message_join j WHERE j.chat_id = c.ROWID) AS n,
               (SELECT MIN(m.date) FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id
                 WHERE j.chat_id = c.ROWID) AS first_date,
               (SELECT MAX(m.date) FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id
                 WHERE j.chat_id = c.ROWID) AS last_date
        FROM chat c {where}
    """, args).fetchall()
    members = {}
    for r in con.execute("""SELECT chj.chat_id, h.id FROM chat_handle_join chj
                            JOIN handle h ON h.ROWID = chj.handle_id"""):
        members.setdefault(r["chat_id"], []).append(r["id"])
    out = []
    for r in rows:
        d = dict(r)
        d["members"] = sorted(set(members.get(r["chat_id"], [])))
        out.append(d)
    return out


def participant_for_handle(handle, participants):
    for idx, p in enumerate(participants):
        if any(handles_match(handle, h) for h in p["handles"]):
            return idx
    return None


def find_matching_chats(con, participants):
    exact, near = [], []
    for c in chat_summaries(con):
        if not c["members"]:
            continue
        mapped = [participant_for_handle(h, participants) for h in c["members"]]
        covered = {m for m in mapped if m is not None}
        if None not in mapped and covered == set(range(len(participants))):
            exact.append(c)
        elif covered:
            near.append(c)
    exact.sort(key=lambda c: -c["n"])
    near.sort(key=lambda c: -c["n"])
    return exact, near


def fmt_apple_date(v, tz):
    u = apple_to_unix(v)
    if u is None:
        return "?"
    return dt.datetime.fromtimestamp(u, dt.timezone.utc).astimezone(tz).strftime("%Y-%m-%d")


def describe_chat(c, tz):
    name = f' "{c["display_name"]}"' if c.get("display_name") else ""
    return (f'chat_id={c["chat_id"]}  {c["service_name"] or "?"}{name}  '
            f'{c["n"]:,} messages  {fmt_apple_date(c["first_date"], tz)} -> '
            f'{fmt_apple_date(c["last_date"], tz)}\n        members: {", ".join(c["members"])}')


def choose_chats(exact, near, tz):
    if not exact:
        msg = ["No chat has exactly the participants listed in config.json."]
        if near:
            msg.append("Chats that include at least one of them (check for a missing phone/email):")
            for c in near[:15]:
                msg.append("  " + describe_chat(c, tz))
            msg.append("Add the missing handle to config.json, or pass --chat-id N to pick one directly.")
        raise ExportError("\n".join(msg))
    if len(exact) == 1:
        return [exact[0]["chat_id"]]

    print("\nSeveral chats match these participants (iCloud and SMS/iMessage can split one")
    print("conversation into more than one chat):\n")
    for i, c in enumerate(exact, 1):
        print(f"  [{i}] " + describe_chat(c, tz))
    print("  [A] All of the above, merged into one export\n")
    if not sys.stdin.isatty():
        raise ExportError("Several chats match. Re-run with --chat-id N (repeatable) to choose.")
    while True:
        ans = input(f"Choose 1-{len(exact)} or A: ").strip().lower()
        if ans == "a":
            return [c["chat_id"] for c in exact]
        if ans.isdigit() and 1 <= int(ans) <= len(exact):
            return [exact[int(ans) - 1]["chat_id"]]
        print("Please type a number from the list, or A.")


# --------------------------------------------------------------------------- extraction

def message_columns(con):
    return {r["name"] for r in con.execute("PRAGMA table_info(message)")}


def date_filter(start_unix, end_unix):
    clauses, args = [], []
    if start_unix is not None:
        clauses.append(f"{SQL_UNIX_TS} >= ?")
        args.append(start_unix)
    if end_unix is not None:
        clauses.append(f"{SQL_UNIX_TS} < ?")
        args.append(end_unix)
    return ("AND " + " AND ".join(clauses)) if clauses else "", args


def direct_sql_counts(con, chat_ids, start_unix, end_unix):
    ph = ",".join("?" * len(chat_ids))
    df, dargs = date_filter(start_unix, end_unix)
    total = con.execute(
        f"""SELECT COUNT(DISTINCT cmj.message_id) FROM chat_message_join cmj
            JOIN message m ON m.ROWID = cmj.message_id
            WHERE cmj.chat_id IN ({ph}) {df}""", list(chat_ids) + dargs).fetchone()[0]
    reactions = con.execute(
        f"""SELECT COUNT(DISTINCT cmj.message_id) FROM chat_message_join cmj
            JOIN message m ON m.ROWID = cmj.message_id
            WHERE cmj.chat_id IN ({ph}) AND COALESCE(m.associated_message_type, 0) != 0 {df}""",
        list(chat_ids) + dargs).fetchone()[0]
    return total, reactions


def fetch_messages(con, chat_ids, start_unix, end_unix):
    cols = message_columns(con)
    optional = ["date_edited", "date_retracted", "message_summary_info", "thread_originator_guid",
                "associated_message_emoji", "balloon_bundle_id", "item_type", "group_title",
                "group_action_type", "other_handle", "service", "associated_message_type",
                "associated_message_guid", "attributedBody", "cache_has_attachments"]
    sel = ", ".join(f"m.{c}" if c in cols else f"NULL AS {c}" for c in optional)
    ph = ",".join("?" * len(chat_ids))
    df, dargs = date_filter(start_unix, end_unix)
    sql = f"""
        SELECT m.ROWID AS rowid, m.guid, m.text, m.handle_id, m.date, m.is_from_me,
               {SQL_UNIX_TS} AS unix_ts, {sel}
        FROM message m
        WHERE m.ROWID IN (SELECT cmj.message_id FROM chat_message_join cmj WHERE cmj.chat_id IN ({ph}))
              {df}
        ORDER BY unix_ts, m.ROWID
    """
    return con.execute(sql, list(chat_ids) + dargs).fetchall()


def fetch_attachments(con, chat_ids):
    ph = ",".join("?" * len(chat_ids))
    rows = con.execute(f"""
        SELECT maj.message_id, a.ROWID AS att_id, a.filename, a.transfer_name, a.mime_type, a.total_bytes
        FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id
        WHERE maj.message_id IN (SELECT message_id FROM chat_message_join WHERE chat_id IN ({ph}))
        ORDER BY maj.message_id, a.ROWID
    """, list(chat_ids)).fetchall()
    out = {}
    for r in rows:
        out.setdefault(r["message_id"], []).append(dict(r))
    return out


def edit_history(summary_blob):
    """
    Best effort: message_summary_info is a binary plist. Key "ec" holds earlier
    versions of edited message parts (each an attributedBody blob under "t");
    key "rp" lists parts that were unsent ("retracted").
    Returns (earlier_versions: list[str], has_retracted_parts: bool).
    """
    if not summary_blob:
        return [], False
    try:
        info = plistlib.loads(bytes(summary_blob))
    except Exception:
        return [], False
    if not isinstance(info, dict):
        return [], False
    versions = []
    ec = info.get("ec")
    if isinstance(ec, dict):
        for _part, edits in sorted(ec.items(), key=lambda kv: str(kv[0])):
            if isinstance(edits, list):
                for e in edits:
                    if isinstance(e, dict) and isinstance(e.get("t"), (bytes, bytearray)):
                        t = decode_attributed_body(e["t"])
                        if t is not None:
                            versions.append(clean_text(t))
    rp = info.get("rp")
    return versions, bool(rp)


def describe_group_event(r, actor, handle_names):
    it = r["item_type"] or 0
    ga = r["group_action_type"] or 0
    other = handle_names(r["other_handle"]) if r["other_handle"] else "someone"
    if it == 1:
        return f"{actor} {'removed' if ga == 1 else 'added'} {other} " \
               f"{'from' if ga == 1 else 'to'} the conversation"
    if it == 2:
        return f"{actor} named the conversation “{r['group_title'] or ''}”"
    if it == 3:
        return {0: f"{actor} left the conversation",
                1: f"{actor} changed the group photo",
                2: f"{actor} removed the group photo"}.get(ga, f"{actor} changed the group")
    return f"[system event, item_type {it}]"


# --------------------------------------------------------------------------- main export

def build_rows(con, chat_ids, cfg, tz, start_unix, end_unix, out_dir, log, copy_attachments=True):
    participants = cfg["participants"]
    me = cfg["me_name"]
    include_reactions = cfg.get("include_reactions", True)
    handles = load_handles(con)

    unknown_handles = set()

    def name_for_handle_id(hid):
        h = handles.get(hid)
        if h is None:
            return "Unknown sender"
        idx = participant_for_handle(h, participants)
        if idx is None:
            unknown_handles.add(h)
            return h
        return participants[idx]["name"]

    raw = fetch_messages(con, chat_ids, start_unix, end_unix)
    atts = fetch_attachments(con, chat_ids)

    by_guid = {}
    for r in raw:
        t = clean_text(r["text"]) or clean_text(decode_attributed_body(r["attributedBody"]))
        by_guid[r["guid"]] = (r["rowid"], t, bool(atts.get(r["rowid"])))

    att_dir = out_dir / "attachments"
    rows = []
    stats = {"attributed_body": 0, "reactions": 0, "attachments_ok": 0, "attachments_missing": 0,
             "edited": 0, "unsent": 0, "system": 0, "decode_failed": [], "blank": []}

    for r in raw:
        ts = r["unix_ts"]
        local = dt.datetime.fromtimestamp(ts, dt.timezone.utc).astimezone(tz)
        utc = dt.datetime.fromtimestamp(ts, dt.timezone.utc)
        from_me = bool(r["is_from_me"])
        sender = me if from_me else name_for_handle_id(r["handle_id"])

        text = clean_text(r["text"])
        if not text and r["attributedBody"]:
            decoded = decode_attributed_body(r["attributedBody"])
            if decoded is None:
                stats["decode_failed"].append(r["rowid"])
            else:
                text = clean_text(decoded)
                if text:
                    stats["attributed_body"] += 1

        amt = r["associated_message_type"] or 0
        mtype = "message"
        reaction_to = ""
        if amt:
            target = by_guid.get(strip_guid_prefix(r["associated_message_guid"]))
            if target:
                tid, ttext, thas_att = target
                what = f"“{shorten(ttext)}”" if ttext else ("an attachment" if thas_att else "a message")
                reaction_to = f"#{tid} {what}"
            else:
                what = "a message"
                reaction_to = f"(message not in export) {r['associated_message_guid'] or ''}".strip()
            if 2000 <= amt <= 2007:
                mtype = "reaction"
                verb = REACTION_VERBS[amt - 2000].format(emoji=r["associated_message_emoji"] or "an emoji")
                text = f"{verb} {what}"
            elif 3000 <= amt <= 3007:
                mtype = "reaction removed"
                verb = REACTION_VERBS[amt - 3000].format(emoji=r["associated_message_emoji"] or "an emoji")
                text = f"Removed reaction ({verb.replace(' to', '').replace(' on', '')}) from {what}"
            else:
                mtype = "reaction/other"
                text = text or f"[associated message type {amt}] {what}"
            stats["reactions"] += 1
            if not include_reactions:
                continue
        elif (r["item_type"] or 0) != 0:
            mtype = "group event"
            text = describe_group_event(r, sender, lambda hid: name_for_handle_id(hid))
            stats["system"] += 1

        # attachments
        att_names = []
        for i, a in enumerate(atts.get(r["rowid"], []), 1):
            orig = a["transfer_name"] or (os.path.basename(a["filename"]) if a["filename"] else f"attachment_{a['att_id']}")
            new_name = f"{local:%Y-%m-%d_%H%M%S}_msg{r['rowid']}_{i}_{safe_filename(orig)}"
            src = Path(os.path.expanduser(a["filename"])) if a["filename"] else None
            if src is not None and src.is_file():
                if copy_attachments:
                    att_dir.mkdir(exist_ok=True)
                    try:
                        shutil.copy2(src, att_dir / new_name)
                        att_names.append(new_name)
                        stats["attachments_ok"] += 1
                    except PermissionError:
                        att_names.append(f"{orig} [not copied: permission denied]")
                        stats["attachments_missing"] += 1
                        log.warn(f"msg #{r['rowid']}: permission denied reading attachment {src}")
                else:
                    att_names.append(orig)
            else:
                att_names.append(f"{orig} [file not on this Mac]")
                stats["attachments_missing"] += 1
                log.warn(f"msg #{r['rowid']} ({local:%Y-%m-%d}): attachment '{orig}' is not "
                         "on this Mac (not downloaded from iCloud, or deleted).")

        if not text and not att_names and r["balloon_bundle_id"]:
            text = f"[iMessage app content: {r['balloon_bundle_id'].split(':')[-1]}]"

        # edited / unsent
        earlier, retracted = edit_history(r["message_summary_info"])
        edited = bool(r["date_edited"]) and bool(apple_to_unix(r["date_edited"]))
        unsent = bool(apple_to_unix(r["date_retracted"])) or retracted
        if edited and not text and not att_names:
            unsent = True
        if unsent:
            stats["unsent"] += 1
            if not text:
                text = "[message unsent]"
        if edited and not unsent:
            stats["edited"] += 1
        if earlier and earlier[-1] == text:
            earlier = earlier[:-1]

        if not text and not att_names:
            stats["blank"].append(r["rowid"])

        reply_to = ""
        if r["thread_originator_guid"]:
            t = by_guid.get(r["thread_originator_guid"])
            reply_to = f"#{t[0]} “{shorten(t[1], 40)}”" if t else r["thread_originator_guid"]

        rows.append({
            "date": local.strftime("%Y-%m-%d"),
            "time": local.strftime("%H:%M:%S"),
            "sender": sender,
            "direction": "sent" if from_me else "received",
            "text": text,
            "attachments": att_names,
            "message_id": r["rowid"],
            "type": mtype,
            "reaction_to": reaction_to,
            "reply_to": reply_to,
            "edited": "yes" if (edited and not unsent) else "",
            "earlier_versions": earlier,
            "unsent": "yes" if unsent else "",
            "service": r["service"] or "",
            "utc": utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "_local": local,
        })

    for h in sorted(unknown_handles):
        log.warn(f"Sender {h} is not in config.json (a former member, or a second number/email "
                 "for someone). Shown by raw address; add it to config.json to get a name.")
    if stats["decode_failed"]:
        log.warn(f"Could not decode attributedBody for message IDs: "
                 f"{', '.join(map(str, stats['decode_failed'][:50]))}")
    if stats["blank"]:
        log.warn(f"Messages with no text and no attachment (exported as empty rows): "
                 f"{', '.join(map(str, stats['blank'][:50]))}")
    return rows, raw, stats


CSV_HEADER = ["date", "time (local)", "sender", "direction", "message text", "attachment file name(s)",
              "message ID", "message type", "reaction / reacted to", "reply to", "edited",
              "earlier versions (edited)", "unsent", "service", "timestamp (UTC)"]


def csv_guard(v, enabled):
    """Stop Excel from treating text like '=...' or '-ok' as a formula."""
    if enabled and v and v[0] in "=+-@\t\r":
        return "'" + v
    return v


def write_csv(rows, path, guard=True):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(CSV_HEADER)
        for r in rows:
            w.writerow([
                r["date"], r["time"], csv_guard(r["sender"], guard), r["direction"],
                csv_guard(r["text"], guard), "; ".join(r["attachments"]), r["message_id"], r["type"],
                csv_guard(r["reaction_to"], guard), csv_guard(r["reply_to"], guard), r["edited"],
                csv_guard(" | ".join(r["earlier_versions"]), guard), r["unsent"], r["service"], r["utc"],
            ])


# --------------------------------------------------------------------------- PDF

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",   # macOS 10.15+
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Apple Symbols.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",        # Linux (used for testing)
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
]


def write_pdf(rows, path, title_lines, header_left, header_right, cfg, log):
    try:
        from reportlab.lib import colors
        from reportlab.lib.enums import TA_CENTER
        from reportlab.lib.pagesizes import A4, letter
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib.units import inch
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.pdfgen import canvas as rl_canvas
        from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer
        from reportlab.lib.fonts import addMapping
    except ImportError:
        log.warn("reportlab is not installed, so messages.pdf was NOT created. "
                 "Install it with:  python3 -m pip install --user reportlab")
        return False

    # Primary font + fallbacks: each character is drawn with the first font that has it.
    fonts = []  # list of (reportlab font name, covered code points)
    candidates = ([cfg["pdf_font"]] if cfg.get("pdf_font") else []) + FONT_CANDIDATES
    seen = set()
    for fp in candidates:
        if not fp or fp in seen or not os.path.isfile(fp):
            continue
        seen.add(fp)
        name = f"ExportFont{len(fonts)}"
        try:
            f = TTFont(name, fp)
            pdfmetrics.registerFont(f)
            for b in (0, 1):
                for i in (0, 1):
                    addMapping(name, b, i, name)
            fonts.append((name, set(f.face.charToGlyph.keys())))
            log.info(f"PDF font{' (fallback)' if len(fonts) > 1 else ''}: {fp}")
        except Exception as e:  # pragma: no cover
            log.warn(f"Could not load font {fp}: {e}")
    if not fonts:
        fonts = [("Helvetica", set(range(32, 127)) | set(range(160, 256)))]
        log.warn("No Unicode font found; non-Latin characters in the PDF are written as [names].")
    font_name, covered = fonts[0]

    substituted = {"n": 0}
    SKIP = {0x200D, 0xFE0E, 0xFE0F}  # zero-width joiner, variation selectors

    def placeholder(ch):
        substituted["n"] += 1
        cp = ord(ch)
        nm = unicodedata.name(ch, f"U+{cp:04X}").lower()
        return f"[emoji: {nm}]" if unicodedata.category(ch) == "So" else f"[{nm}]"

    def runs(s):
        """Split text into (font_index, text) runs; undrawable chars become [placeholders]."""
        out = []
        chars = list(s or "")
        i = 0
        while i < len(chars):
            ch = chars[i]
            cp = ord(ch)
            if cp in SKIP or 0x1F3FB <= cp <= 0x1F3FF:      # skin-tone modifiers
                i += 1
                continue
            if (0x1F1E6 <= cp <= 0x1F1FF and i + 1 < len(chars)
                    and 0x1F1E6 <= ord(chars[i + 1]) <= 0x1F1FF):   # flag = two regional letters
                code = chr(cp - 0x1F1E6 + 65) + chr(ord(chars[i + 1]) - 0x1F1E6 + 65)
                substituted["n"] += 1
                piece, idx = f"[flag: {code}]", 0
                i += 2
            else:
                idx = next((k for k, (_n, cov) in enumerate(fonts) if cp in cov or ch in "\n\t"), None)
                piece = ch if idx is not None else placeholder(ch)
                idx = idx or 0
                i += 1
            if out and out[-1][0] == idx:
                out[-1][1] += piece
            else:
                out.append([idx, piece])
        return out

    def pdf_text(s):  # plain text for canvas strings (header/footer): primary font only
        return "".join(t if k == 0 else "".join(c if ord(c) in covered else placeholder(c) for c in t)
                       for k, t in runs(s))

    def para(s):
        parts = []
        for k, t in runs(s):
            esc = html.escape(t, quote=False).replace("\n", "<br/>")
            parts.append(esc if k == 0 else f'<font name="{fonts[k][0]}">{esc}</font>')
        return "".join(parts)

    base = ParagraphStyle("base", fontName=font_name, fontSize=9.5, leading=12.5)
    styles = {
        "title": ParagraphStyle("title", parent=base, fontSize=15, leading=19, spaceAfter=6),
        "meta": ParagraphStyle("meta", parent=base, fontSize=9, leading=12, textColor=colors.HexColor("#333333")),
        "day": ParagraphStyle("day", parent=base, fontSize=11, leading=14, spaceBefore=10, spaceAfter=4,
                              textColor=colors.black, borderPadding=(2, 0, 2, 0),
                              backColor=colors.HexColor("#EEEEEE"), keepWithNext=1),
        "msg": ParagraphStyle("msg", parent=base, leftIndent=46, firstLineIndent=-46, spaceAfter=3),
        "react": ParagraphStyle("react", parent=base, fontSize=8.5, leading=11, leftIndent=46,
                                firstLineIndent=-46, spaceAfter=2, textColor=colors.HexColor("#666666")),
        "event": ParagraphStyle("event", parent=base, fontSize=8.5, leading=11, alignment=TA_CENTER,
                                spaceAfter=3, textColor=colors.HexColor("#666666")),
    }
    palette = ["#1F4E79", "#7B2C83", "#2E6B30", "#8A4B08", "#6B6B00"]
    sender_colors = {}

    def color_for(name):
        if name not in sender_colors:
            sender_colors[name] = palette[len(sender_colors) % len(palette)]
        return sender_colors[name]

    color_for(cfg["me_name"])
    for p in cfg["participants"]:
        color_for(p["name"])

    story = [Paragraph(para(title_lines[0]), styles["title"])]
    for line in title_lines[1:]:
        story.append(Paragraph(para(line), styles["meta"]))
    story.append(Spacer(1, 8))

    current_day = None
    for r in rows:
        day = r["_local"].date()
        if day != current_day:
            current_day = day
            story.append(Paragraph(f"{day:%A}, {day:%B} {day.day}, {day.year}", styles["day"]))
        t = r["time"][:5]
        if r["type"] == "group event":
            story.append(Paragraph(f"{t} — {para(r['text'])}", styles["event"]))
            continue
        flags = []
        if r["edited"]:
            flags.append("edited")
        if r["unsent"]:
            flags.append("unsent")
        flag_txt = f' <font color="#B00000">({", ".join(flags)})</font>' if flags else ""
        who = f'<font color="{color_for(r["sender"])}">{para(r["sender"])}</font>'
        if r["type"].startswith("reaction"):
            story.append(Paragraph(f"{t}&nbsp;&nbsp;&nbsp;<i>{who} {para(r['text'])}</i>"
                                   f'<font size="7"> [#{r["message_id"]}]</font>', styles["react"]))
            continue
        body = para(r["text"])
        extra = []
        if r["reply_to"]:
            extra.append(f'<font color="#666666">(reply to {para(r["reply_to"])})</font>')
        for a in r["attachments"]:
            extra.append(f'<font color="#555555">[Attachment: {para(a)}]</font>')
        for e in r["earlier_versions"]:
            extra.append(f'<font color="#777777">Earlier version: {para(e)}</font>')
        text = body + ("<br/>" if body and extra else "") + "<br/>".join(extra)
        story.append(Paragraph(
            f'<font color="#555555">{t}</font>&nbsp;&nbsp;&nbsp;<b>{who}</b>: {text}{flag_txt}'
            f'<font size="7" color="#999999"> #{r["message_id"]}</font>', styles["msg"]))

    pagesize = A4 if str(cfg.get("page_size", "letter")).lower() == "a4" else letter
    hl, hr = pdf_text(header_left), pdf_text(header_right)
    footer_note = pdf_text(cfg.get("pdf_footer", "CONFIDENTIAL"))

    class NumberedCanvas(rl_canvas.Canvas):
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            self._pages = []

        def showPage(self):
            self._pages.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._pages)
            for state in self._pages:
                self.__dict__.update(state)
                self._decorate(total)
                super().showPage()
            super().save()

        def _decorate(self, total):
            w, h = pagesize
            self.saveState()
            self.setFont(font_name, 8.5)
            self.setFillColor(colors.HexColor("#222222"))
            self.drawString(0.7 * inch, h - 0.5 * inch, hl[:110])
            self.drawRightString(w - 0.7 * inch, h - 0.5 * inch, hr)
            self.setStrokeColor(colors.HexColor("#999999"))
            self.setLineWidth(0.5)
            self.line(0.7 * inch, h - 0.56 * inch, w - 0.7 * inch, h - 0.56 * inch)
            self.line(0.7 * inch, 0.55 * inch, w - 0.7 * inch, 0.55 * inch)
            self.setFont(font_name, 8)
            self.drawString(0.7 * inch, 0.4 * inch, footer_note)
            self.drawRightString(w - 0.7 * inch, 0.4 * inch, f"Page {self._pageNumber} of {total}")
            self.restoreState()

    doc = SimpleDocTemplate(str(path), pagesize=pagesize, leftMargin=0.7 * inch, rightMargin=0.7 * inch,
                            topMargin=0.8 * inch, bottomMargin=0.75 * inch,
                            title="Messages export", author="", subject="", creator="export_chat.py")
    doc.build(story, canvasmaker=NumberedCanvas)
    if substituted["n"]:
        log.info(f"PDF: {substituted['n']} character(s) the PDF font cannot draw (mostly emoji) were "
                 "written as placeholders such as [emoji: face with tears of joy]. The CSV keeps the real characters.")
    return True


# --------------------------------------------------------------------------- CLI

def resolve_tz(cfg):
    name = cfg.get("timezone")
    if name:
        if ZoneInfo is None:
            raise ExportError("The 'timezone' setting needs Python 3.9+.")
        try:
            return ZoneInfo(name)
        except Exception:
            raise ExportError(f"Unknown timezone in config.json: {name!r} (example: America/New_York)")
    return None  # None = the Mac's own time zone, with correct DST for each date


def local_midnight_unix(d, tz):
    if d is None:
        return None
    if tz is not None:
        return dt.datetime(d.year, d.month, d.day, tzinfo=tz).timestamp()
    return dt.datetime(d.year, d.month, d.day).timestamp()  # naive = system local time


def list_chats(con, cfg, tz):
    print("All chats with more than one other member (group chats):\n")
    for c in sorted(chat_summaries(con), key=lambda c: -c["n"]):
        if len(c["members"]) >= 2:
            print("  " + describe_chat(c, tz))


def main(argv=None):
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description="Export one Messages group chat to CSV + PDF (read-only, offline).")
    ap.add_argument("--config", default=str(here / "config.json"), help="path to config.json")
    ap.add_argument("--messages-dir", help="folder containing chat.db (default ~/Library/Messages)")
    ap.add_argument("--chat-id", type=int, action="append", help="use this chat ROWID (repeatable); skips matching")
    ap.add_argument("--start", help="first date to include, YYYY-MM-DD (overrides config)")
    ap.add_argument("--end", help="last date to include, YYYY-MM-DD, inclusive (overrides config)")
    ap.add_argument("--output-dir", help="where to create the dated export folder (default ./exports)")
    ap.add_argument("--list-chats", action="store_true", help="list group chats and exit")
    ap.add_argument("--no-attachments", action="store_true", help="do not copy attachment files")
    ap.add_argument("--keep-copy", action="store_true", help="keep the temporary database copy (path is printed)")
    args = ap.parse_args(argv)

    log = Log()
    work_dir = None
    try:
        cfg = load_config(args.config)
        tz = resolve_tz(cfg)
        start = parse_date(args.start or cfg.get("start_date"), "start date")
        end = parse_date(args.end or cfg.get("end_date"), "end date")
        if start and end and end < start:
            raise ExportError("End date is before start date.")
        start_unix = local_midnight_unix(start, tz)
        end_unix = local_midnight_unix(end + dt.timedelta(days=1), tz) if end else None

        src_dir = Path(os.path.expanduser(args.messages_dir or cfg.get("messages_dir") or "~/Library/Messages"))

        log.info(f"export_chat.py v{TOOL_VERSION} - read-only, offline")
        log.info(f"Run started: {dt.datetime.now().astimezone():%Y-%m-%d %H:%M:%S %Z}")
        log.info(f"Source folder: {src_dir}")
        if messages_app_running():
            log.warn("The Messages app is open. For a clean snapshot, quit Messages (Cmd+Q) before running.")

        before = originals_state(src_dir) if os.access(src_dir, os.R_OK) else {}
        work_dir = Path(tempfile.mkdtemp(prefix="imessage_export_"))
        os.chmod(work_dir, 0o700)
        copied, hashes, made_at = snapshot_database(src_dir, work_dir, log)

        log.info("")
        log.info(f"Database copied to temporary folder: {work_dir}")
        log.info(f"Copy made: {made_at:%Y-%m-%d %H:%M:%S %Z}")
        for name in ("chat.db", "chat.db-wal", "chat.db-shm"):
            if name in hashes:
                log.info(f"  SHA-256 {name:<12} {hashes[name]}")
            else:
                log.info(f"  {name:<20} (not present)")

        con = open_readonly(copied["chat.db"])
        qc = con.execute("PRAGMA quick_check").fetchone()[0]
        if qc != "ok":
            log.warn(f"SQLite integrity check on the copy reported: {qc}")

        if args.list_chats:
            list_chats(con, cfg, tz)
            return 0

        if args.chat_id:
            chat_ids = args.chat_id
            found = {c["chat_id"] for c in chat_summaries(con, chat_ids)}
            missing = [c for c in chat_ids if c not in found]
            if missing:
                raise ExportError(f"No chat with chat_id {missing}. Use --list-chats to see them.")
        else:
            exact, near = find_matching_chats(con, cfg["participants"])
            chat_ids = choose_chats(exact, near, tz)
        chats = chat_summaries(con, chat_ids)
        log.info("")
        log.info("Exporting chat(s):")
        for c in chats:
            log.info("  " + describe_chat(c, tz))

        stamp = dt.datetime.now().strftime("%Y-%m-%d_%H%M%S")
        out_root = Path(args.output_dir or cfg.get("output_dir") or (Path.cwd() / "exports")).expanduser()
        out_dir = out_root / f"export_{stamp}"
        out_dir.mkdir(parents=True, exist_ok=False)
        os.chmod(out_dir, 0o700)

        rows, raw, stats = build_rows(con, chat_ids, cfg, tz, start_unix, end_unix, out_dir, log,
                                      copy_attachments=not args.no_attachments)
        sql_total, sql_reactions = direct_sql_counts(con, chat_ids, start_unix, end_unix)
        con.close()

        include_reactions = cfg.get("include_reactions", True)
        expected = sql_total if include_reactions else sql_total - sql_reactions

        names = [cfg["me_name"]] + [p["name"] for p in cfg["participants"]]
        if rows:
            first, last = rows[0]["_local"], rows[-1]["_local"]
            range_txt = f"{first:%Y-%m-%d} to {last:%Y-%m-%d}"
        else:
            first = last = None
            range_txt = "no messages"
        requested = ""
        if start or end:
            requested = f" (filter: {start or 'beginning'} to {end or 'latest'})"

        csv_path = out_dir / "messages.csv"
        write_csv(rows, csv_path, guard=cfg.get("csv_formula_guard", True))

        pdf_path = out_dir / "messages.pdf"
        who = ", ".join(f'{p["name"]} ({", ".join(p["handles"])})' for p in cfg["participants"])
        title_lines = [
            "Group conversation: " + ", ".join(names),
            f"Participants: {cfg['me_name']} (device owner), {who}",
            f"Messages: {len(rows):,}   Date range: {range_txt}{requested}",
            "Times shown in: " + (getattr(tz, "key", None) or "this Mac's local time zone"),
            f"Exported {dt.datetime.now().astimezone():%Y-%m-%d %H:%M %Z} from a read-only copy of chat.db "
            f"(SHA-256 {hashes['chat.db'][:16]}…, full hash in export_log.txt)",
        ]
        pdf_ok = write_pdf(rows, pdf_path, title_lines, ", ".join(names), range_txt, cfg, log)

        # re-verify the copy was not altered by reading it
        if sha256_file(copied["chat.db"]) != hashes["chat.db"]:
            log.warn("The temporary copy of chat.db changed while being read (unexpected).")
        after = originals_state(src_dir) if before else {}

        log.info("")
        log.info("=" * 70)
        log.info("RESULT")
        log.info(f"  Messages exported (CSV rows):     {len(rows):,}")
        log.info(f"  Direct SQL count for the chat:    {sql_total:,}"
                 f"  (of which reactions/tapbacks: {sql_reactions:,})")
        if not include_reactions:
            log.info(f"  Expected after excluding reactions: {expected:,}")
        if len(rows) == expected:
            log.info("  COUNT CHECK: OK - exported count matches the database.")
        else:
            log.warn(f"COUNT CHECK FAILED: exported {len(rows)} but expected {expected}.")
        log.info(f"  First message: {first:%Y-%m-%d %H:%M:%S %Z}" if first else "  First message: -")
        log.info(f"  Last message:  {last:%Y-%m-%d %H:%M:%S %Z}" if last else "  Last message:  -")
        log.info(f"  Text recovered from attributedBody: {stats['attributed_body']:,}")
        log.info(f"  Reactions/tapbacks:  {stats['reactions']:,}"
                 f"{'' if include_reactions else ' (excluded by config)'}")
        log.info(f"  Group events:        {stats['system']:,}")
        log.info(f"  Edited messages:     {stats['edited']:,}")
        log.info(f"  Unsent messages:     {stats['unsent']:,}")
        log.info(f"  Attachments copied:  {stats['attachments_ok']:,}   missing: {stats['attachments_missing']:,}")
        if before and after and before != after:
            log.info("  Note: the original chat.db files changed during the run. That is the Messages")
            log.info("  app syncing, not this tool (the originals were only byte-copied, never opened).")
        elif before:
            log.info("  Original chat.db / -wal / -shm: size and modification time unchanged.")
        log.info("")
        log.info(f"Output folder: {out_dir}")
        log.info(f"  messages.csv  SHA-256 {sha256_file(csv_path)}")
        if pdf_ok:
            log.info(f"  messages.pdf  SHA-256 {sha256_file(pdf_path)}")
        log.info("")
        if log.warnings:
            log.info(f"Warnings ({len(log.warnings)}):")
            for w in log.warnings:
                log.info("  - " + w)
        else:
            log.info("Warnings: none")

        with open(out_dir / "export_log.txt", "w", encoding="utf-8") as f:
            f.write("\n".join(log.lines) + "\n")
        print(f"\nDone. Open the folder:  open \"{out_dir}\"")
        return 0 if len(rows) == expected else 2

    except ExportError as e:
        print("\nERROR: " + str(e).strip(), file=sys.stderr)
        return 1
    except PermissionError as e:
        print(FDA_HELP + f"\n(details: {e})", file=sys.stderr)
        return 1
    except sqlite3.DatabaseError as e:
        print(f"\nERROR reading the database copy: {e}", file=sys.stderr)
        return 1
    finally:
        if work_dir and work_dir.exists():
            if args.keep_copy:
                print(f"Database copy kept at: {work_dir}  (delete it when finished)")
            else:
                shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
