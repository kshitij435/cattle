import sqlite3

conn = sqlite3.connect('cattle_claims.db')

print("\n=== CASES ===")
cols = [c[0] for c in conn.execute('SELECT * FROM cases').description]
for row in conn.execute('SELECT * FROM cases'):
    print(dict(zip(cols, row)))

print("\n=== CAPTURES ===")
cols = [c[0] for c in conn.execute('SELECT * FROM captures').description]
for row in conn.execute('SELECT * FROM captures'):
    print(dict(zip(cols, row)))

conn.close()
