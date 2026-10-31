#!/bin/sh
# Build the FAKE test database and export it. Touches nothing in ~/Library/Messages.
set -e
cd "$(dirname "$0")"
python3 make_test_db.py test_data
python3 export_chat.py --config test_data/config.test.json --output-dir test_data/exports --chat-id 1
