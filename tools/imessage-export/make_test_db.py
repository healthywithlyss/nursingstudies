#!/usr/bin/env python3
"""
make_test_db.py - build a FAKE Messages database for testing export_chat.py.

Creates  <out>/Messages/chat.db (+ chat.db-wal, chat.db-shm)
         <out>/Messages/Attachments/...   (fake attachment files)
         <out>/config.test.json

Everything is invented: 555-01xx numbers and example.com addresses.
The schema mirrors the real macOS chat.db tables/columns the exporter reads.
The last few messages are left un-checkpointed in the -wal file, exactly as
on a live Mac, to prove the exporter reads the WAL correctly.

Usage:  python3 make_test_db.py [output_folder]     (default: ./test_data)
"""

import datetime as dt
import json
import plistlib
import shutil
import sqlite3
import struct
import sys
import tempfile
import zlib
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/New_York")
APPLE_EPOCH = 978307200

SCHEMA = """
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT,
    service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT, UNIQUE (id, service));
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER,
    state INTEGER, account_id TEXT, properties BLOB, chat_identifier TEXT, service_name TEXT,
    room_name TEXT, account_login TEXT, is_archived INTEGER DEFAULT 0, last_addressed_handle TEXT,
    display_name TEXT, group_id TEXT, is_filtered INTEGER, successful_query INTEGER);
CREATE TABLE chat_handle_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE,
    handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE, UNIQUE(chat_id, handle_id));
CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT,
    replace INTEGER DEFAULT 0, service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT,
    country TEXT, attributedBody BLOB, version INTEGER DEFAULT 0, type INTEGER DEFAULT 0,
    service TEXT, account TEXT, account_guid TEXT, error INTEGER DEFAULT 0, date INTEGER,
    date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0,
    is_finished INTEGER DEFAULT 0, is_emote INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0,
    is_empty INTEGER DEFAULT 0, is_delayed INTEGER DEFAULT 0, is_auto_reply INTEGER DEFAULT 0,
    is_prepared INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0,
    is_sent INTEGER DEFAULT 0, has_dd_results INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
    item_type INTEGER DEFAULT 0, other_handle INTEGER DEFAULT 0, group_title TEXT,
    group_action_type INTEGER DEFAULT 0, associated_message_guid TEXT,
    associated_message_type INTEGER DEFAULT 0, balloon_bundle_id TEXT, payload_data BLOB,
    expressive_send_style_id TEXT, associated_message_range_location INTEGER DEFAULT 0,
    associated_message_range_length INTEGER DEFAULT 0, thread_originator_guid TEXT,
    thread_originator_part TEXT, date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0,
    message_summary_info BLOB, associated_message_emoji TEXT);
CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE,
    message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0,
    PRIMARY KEY (chat_id, message_id));
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
    created_date INTEGER DEFAULT 0, start_date INTEGER DEFAULT 0, filename TEXT, uti TEXT,
    mime_type TEXT, transfer_state INTEGER DEFAULT 0, is_outgoing INTEGER DEFAULT 0, user_info BLOB,
    transfer_name TEXT, total_bytes INTEGER DEFAULT 0);
CREATE TABLE message_attachment_join (message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE,
    attachment_id INTEGER REFERENCES attachment (ROWID) ON DELETE CASCADE, UNIQUE(message_id, attachment_id));
"""


def typedstream_len(n):
    if n < 0x80:
        return bytes([n])
    if n < 0x8000:
        return b"\x81" + n.to_bytes(2, "little")
    return b"\x82" + n.to_bytes(4, "little")


def attributed_body(text):
    """Build an NSAttributedString typedstream blob shaped like the ones Messages writes."""
    t = text.encode("utf-8")
    return (b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00"
            b"\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+"
            + typedstream_len(len(t)) + t
            + b"\x86\x84\x02iI\x01" + typedstream_len(len(text)) + b"\x92\x84\x84\x84\x0cNSDictionary"
            b"\x00\x94\x84\x01i\x01\x92\x84\x96\x96\x1d__kIMMessagePartAttributeName\x86\x92\x84\x84"
            b"\x84\x08NSNumber\x00\x84\x84\x07NSValue\x00\x94\x84\x01*\x84\x99\x99\x00\x86\x86\x86")


def apple_ns(y, mo, d, h, mi, s=0):
    u = dt.datetime(y, mo, d, h, mi, s, tzinfo=TZ).timestamp()
    return int(round((u - APPLE_EPOCH) * 1e9))


def apple_s(y, mo, d, h, mi, s=0):
    """Older macOS stored whole seconds."""
    return int(dt.datetime(y, mo, d, h, mi, s, tzinfo=TZ).timestamp() - APPLE_EPOCH)


def tiny_png(path, rgb=(200, 60, 60)):
    w = h = 16
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(t, data):
        c = t + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "test_data").resolve()
    msg_dir = out / "Messages"
    if msg_dir.exists():
        shutil.rmtree(msg_dir)
    msg_dir.mkdir(parents=True)
    att_root = msg_dir / "Attachments"

    build = Path(tempfile.mkdtemp())
    db = build / "chat.db"
    con = sqlite3.connect(db)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA wal_autocheckpoint=0")
    con.executescript(SCHEMA)

    # ---- handles (fake people)
    H = {}
    for hid, service in [("+15550101234", "iMessage"),        # Alex Rivera
                         ("sam.chen@example.com", "iMessage"),  # Sam Chen (email)
                         ("+15550109876", "SMS"),               # Sam Chen (phone)
                         ("+15550101234", "SMS"),               # Alex again on SMS
                         ("+15550105555", "iMessage"),          # Jordan (former member, not in config)
                         ("+15550107777", "iMessage")]:         # Pat (unrelated)
        cur = con.execute("INSERT INTO handle (id, service, country) VALUES (?,?, 'us')", (hid, service))
        H[(hid, service)] = cur.lastrowid
    alex, sam = H[("+15550101234", "iMessage")], H[("sam.chen@example.com", "iMessage")]
    sam_sms, alex_sms = H[("+15550109876", "SMS")], H[("+15550101234", "SMS")]
    jordan, pat = H[("+15550105555", "iMessage")], H[("+15550107777", "iMessage")]

    def chat(guid, ident, service, members, name=None):
        cid = con.execute("INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) "
                          "VALUES (?,?,?,?,?)", (guid, 43 if len(members) > 1 else 45, ident, service, name)
                          ).lastrowid
        for m in members:
            con.execute("INSERT INTO chat_handle_join VALUES (?,?)", (cid, m))
        return cid

    main_chat = chat("iMessage;+;chat111111", "chat111111", "iMessage", [alex, sam], "Book club")
    sms_chat = chat("SMS;+;chat222222", "chat222222", "SMS", [alex_sms, sam_sms])
    one_to_one = chat("iMessage;-;+15550101234", "+15550101234", "iMessage", [alex])
    other_grp = chat("iMessage;+;chat333333", "chat333333", "iMessage", [alex, sam, pat])

    n = {"i": 0}

    def msg(chat_id, date, frm, text=None, ab=None, from_me=False, service="iMessage", **kw):
        n["i"] += 1
        guid = kw.pop("guid", f"FAKE-GUID-{n['i']:04d}")
        cols = dict(guid=guid, text=text, attributedBody=ab, handle_id=0 if from_me else frm,
                    date=date, is_from_me=1 if from_me else 0, service=service, **kw)
        cur = con.execute(f"INSERT INTO message ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                          list(cols.values()))
        con.execute("INSERT INTO chat_message_join VALUES (?,?,?)", (chat_id, cur.lastrowid, date))
        return cur.lastrowid, guid

    def attach(mid, rel, name, mime, create=True):
        path = att_root / rel
        if create:
            tiny_png(path)
        aid = con.execute("INSERT INTO attachment (guid, filename, mime_type, transfer_name, total_bytes) "
                          "VALUES (?,?,?,?,?)", (f"ATT-{mid}-{name}", str(path), mime, name,
                                                 path.stat().st_size if create else 0)).lastrowid
        con.execute("INSERT INTO message_attachment_join VALUES (?,?)", (mid, aid))
        con.execute("UPDATE message SET cache_has_attachments=1 WHERE ROWID=?", (mid,))

    C = main_chat
    # 2015: old macOS, dates in SECONDS
    msg(C, apple_s(2015, 3, 2, 18, 5), alex, "Welcome to the book club chat!")
    msg(C, apple_s(2015, 3, 2, 18, 7), None, "Thanks Alex. First pick: Middlemarch?", from_me=True)
    msg(C, apple_s(2015, 3, 2, 19, 30), jordan, "Count me in for the first meeting")
    # group event: Jordan leaves (item_type 3, action 0)
    msg(C, apple_s(2016, 1, 10, 9, 0), jordan, None, item_type=3, group_action_type=0)
    # 2019 onwards: nanoseconds
    msg(C, apple_ns(2019, 7, 4, 12, 0), sam, None, item_type=2, group_title="Book club")
    m_q, g_q = msg(C, apple_ns(2023, 11, 5, 10, 15), sam, "Are we still on for Friday? 📚")
    # attributedBody only (text column NULL) - what newer macOS does
    msg(C, apple_ns(2023, 11, 5, 10, 17), alex, None,
        ab=attributed_body("Yes! I'll bring snacks 🍪 — and the café recommended by María"))
    # reaction (Loved) to Sam's question
    msg(C, apple_ns(2023, 11, 5, 10, 18), None, "Loved “Are we still on for Friday? 📚”", from_me=True,
        associated_message_guid=f"p:0/{g_q}", associated_message_type=2000)
    # attachment-only message (text is just the U+FFFC placeholder)
    m_img, g_img = msg(C, apple_ns(2023, 11, 10, 20, 41), alex, "￼")
    attach(m_img, "ab/01/ATT-0001/IMG_4012.png", "IMG_4012.png", "image/png")
    # emoji tapback on the picture (macOS 15 style, type 2006 with emoji)
    msg(C, apple_ns(2023, 11, 10, 20, 45), sam, None, associated_message_guid=f"p:0/{g_img}",
        associated_message_type=2006, associated_message_emoji="😍")
    # liked then removed
    msg(C, apple_ns(2023, 11, 10, 20, 46), None, None, from_me=True,
        associated_message_guid=f"p:0/{g_img}", associated_message_type=2001)
    msg(C, apple_ns(2023, 11, 10, 20, 47), None, None, from_me=True,
        associated_message_guid=f"p:0/{g_img}", associated_message_type=3001)
    # non-English + multiline, via attributedBody, long enough (>127 bytes) for 2-byte length
    msg(C, apple_ns(2024, 2, 14, 8, 3), sam, None, ab=attributed_body(
        "Notes from my trip:\n• 東京の本屋はすごかった\n• Ελληνικά βιβλία στην Αθήνα\n"
        "• Привет из Москвы\n• Ça coûte 12 € — très cher! 😂🇯🇵👍🏽"))
    # text + attachment that is NOT on this Mac (iCloud-only)
    m_pdf, _ = msg(C, apple_ns(2024, 2, 14, 8, 10), None, "Here's the reading list ￼", from_me=True)
    attach(m_pdf, "cd/02/ATT-0002/reading_list.pdf", "reading list.pdf", "application/pdf", create=False)
    # edited message (macOS 13+): current text + earlier version in message_summary_info
    summary = plistlib.dumps({"ec": {"0": [
        {"t": attributed_body("See you at 6"), "d": 729000000.0},
        {"t": attributed_body("See you at 7 instead"), "d": 729000060.0}]}, "otr": {}},
        fmt=plistlib.FMT_BINARY)
    msg(C, apple_ns(2024, 3, 1, 17, 0), alex, None, ab=attributed_body("See you at 7 instead"),
        date_edited=apple_ns(2024, 3, 1, 17, 1), message_summary_info=summary)
    # unsent message
    msg(C, apple_ns(2024, 3, 1, 17, 5), None, None, from_me=True,
        date_edited=apple_ns(2024, 3, 1, 17, 6), message_summary_info=plistlib.dumps(
            {"rp": [0], "otr": {}}, fmt=plistlib.FMT_BINARY))
    # reply in a thread + text that Excel would read as a formula
    msg(C, apple_ns(2024, 3, 2, 9, 0), sam, "=SUM(our snack budget) is too low 😅",
        thread_originator_guid=g_q)
    msg(C, apple_ns(2024, 3, 2, 9, 1), alex, "-ok fine, I'll pay")
    con.commit()

    # Other chats (must NOT end up in the export)
    msg(sms_chat, apple_ns(2018, 5, 1, 9, 0), sam_sms, "SMS-era group text (separate chat row)",
        service="SMS")
    msg(sms_chat, apple_ns(2018, 5, 1, 9, 2), None, "Got it", from_me=True, service="SMS")
    msg(one_to_one, apple_ns(2024, 1, 1, 0, 1), alex, "Happy new year (private 1:1 chat)")
    msg(other_grp, apple_ns(2024, 1, 2, 10, 0), pat, "Different group with Pat")
    con.commit()
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    # These last messages stay ONLY in the -wal file (like a live Mac).
    msg(C, apple_ns(2026, 10, 30, 21, 15), None, "Last message, still only in the WAL file 🎉",
        from_me=True)
    msg(C, apple_ns(2026, 10, 30, 21, 16), sam, None, ab=attributed_body("Night all 🌙"))
    con.commit()

    # copy db + wal + shm while the connection is still open (WAL not yet merged)
    for name in ("chat.db", "chat.db-wal", "chat.db-shm"):
        shutil.copy2(build / name, msg_dir / name)
    con.close()
    shutil.rmtree(build)

    config = {
        "me_name": "Me",
        "participants": [
            {"name": "Alex Rivera", "handles": ["+1 (555) 010-1234"]},
            {"name": "Sam Chen", "handles": ["sam.chen@example.com", "555-010-9876"]},
        ],
        "start_date": None,
        "end_date": None,
        "timezone": "America/New_York",
        "include_reactions": True,
        "messages_dir": str(msg_dir),
    }
    (out / "config.test.json").write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Fake database written to {msg_dir}")
    print(f"Test config written to   {out / 'config.test.json'}")


if __name__ == "__main__":
    main()
