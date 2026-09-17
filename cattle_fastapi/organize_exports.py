"""
organize_exports.py -- Manually (re-)organizes ALL cases into
organized_exports/ at once. Useful for:
  - Cases created before auto-organize existed (every NEW upload organizes
    itself automatically now -- see services/organize.py, called from
    api/captures.py's upload endpoint).
  - Force-refreshing everything after a bulk database change.

For everyday use, you don't need to run this at all -- organized_exports/
now stays live and current on its own, updating immediately as each photo
is captured through the app.

Usage:
    python organize_exports.py                    # (re-)organizes EVERY case
    python organize_exports.py case_abc123def456   # just one case
"""
import sys

from services.db import get_conn
from services.organize import organize_case


def main():
    conn = get_conn()
    target_case_id = sys.argv[1] if len(sys.argv) > 1 else None

    if target_case_id:
        result = organize_case(target_case_id, conn)
        print(f"Organized: {result}" if result else f"No case found with id {target_case_id}")
    else:
        cases = conn.execute("SELECT id FROM cases ORDER BY created_at").fetchall()
        if not cases:
            print("No cases found in the database.")
        else:
            for row in cases:
                print(f"Organized: {organize_case(row['id'], conn)}")
            print(f"\nDone -- {len(cases)} case(s) organized into organized_exports/")

    conn.close()


if __name__ == "__main__":
    main()
