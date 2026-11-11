import sqlite3

conn = sqlite3.connect(r'C:\Users\HP\BakuEstate-AI\data\database.sqlite')
c = conn.cursor()
c.execute("UPDATE generated_videos SET status = 'DISPATCHED', telegram_message_id = '2' WHERE video_path LIKE '%6532081%'")
conn.commit()
print("Updated successfully!")
