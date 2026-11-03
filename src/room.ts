import { DurableObject } from "cloudflare:workers";

import { MAX_QUEUED_MESSAGES, ROOM_TTL_MS } from "./limits";

type CountRow = { n: number };
type TableRow = { name: string };
type MessageRow = { id: number; body: ArrayBuffer };

/**
 * 1 つの部屋。部屋の中に受信箱 (宛先ごとのメッセージの列) を持つ。
 *
 * 部屋ごとに 1 つの実体で動くため、書き込んだ内容はすぐ相手から読める。
 * 最後にメッセージを積む・取り出すしてから {@link ROOM_TTL_MS} 経つと中身を消す。
 * 表は最初に積むときに作るので、読むだけの問い合わせでは何も保存されない。
 *
 * Durable Object はクラスとして定義する必要がある (Cloudflare の API の仕様)。
 */
export class Room extends DurableObject<Env> {
  /** 受信箱 `box` の末尾へ積む。受信箱がいっぱいなら積まずに false。 */
  async push(box: string, body: ArrayBuffer): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, box TEXT NOT NULL, body BLOB NOT NULL)",
    );
    const { n } = sql.exec<CountRow>("SELECT COUNT(*) AS n FROM messages WHERE box = ?", box).one();
    if (n >= MAX_QUEUED_MESSAGES) {
      return false;
    }
    sql.exec("INSERT INTO messages (box, body) VALUES (?, ?)", box, body);
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    return true;
  }

  /** 受信箱 `box` の先頭を取り出す。空なら null。 */
  async pop(box: string): Promise<ArrayBuffer | null> {
    const sql = this.ctx.storage.sql;
    // まだ一度も積まれていない (または期限で消えた) 部屋
    const tables = sql
      .exec<TableRow>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
      .toArray();
    if (tables.length === 0) {
      return null;
    }
    const [row] = sql
      .exec<MessageRow>("SELECT id, body FROM messages WHERE box = ? ORDER BY id LIMIT 1", box)
      .toArray();
    // 空の問い合わせ (ポーリング) では期限を延ばさない (書き込みが増えるため)
    if (row === undefined) {
      return null;
    }
    sql.exec("DELETE FROM messages WHERE id = ?", row.id);
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    return row.body;
  }

  /** 期限が来たら部屋の中身をすべて消す。 */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
