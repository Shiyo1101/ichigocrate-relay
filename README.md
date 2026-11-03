# ichigocrate-relay

[ichigocrate](https://github.com/Shiyo1101/ichigocrate) (IchigoJam BASIC の Rust 移植) 同士で通信対戦するための中継サーバー。Cloudflare Workers + [Hono](https://hono.dev/) で動き、部屋のデータは Durable Objects に置く。

ichigocrate 同士は直接つながれない (ルーター越し・ブラウザは接続を受けられない) ので、このサーバーの「受信箱」を介してメッセージをやりとりする。

## API: 部屋ごと・宛先ごとの受信箱

| メソッド | パス               | 動作                                                                              |
| -------- | ------------------ | --------------------------------------------------------------------------------- |
| `POST`   | `/r/<部屋>/<宛先>` | 本文 (1〜2048 バイト) を宛先の受信箱の末尾へ積む。成功は `204`                    |
| `GET`    | `/r/<部屋>/<自分>` | 自分の受信箱から一番古いメッセージを 1 件取り出して返す。空なら `200` で 0 バイト |
| `GET`    | `/`                | 使い方                                                                            |

- 本文は解釈しないバイト列 (IchigoJam の文字コードのまま)。応答は `Content-Type: application/octet-stream`
- 部屋名・受信箱名は英数字と `_` `-` の 1〜32 文字。大文字小文字は区別しない
- 取り出したメッセージは受信箱から消える。そのため「まだ届いていない」は空 (0 バイト) かどうかだけで判断できる

| 状況                                                     | ステータス |
| -------------------------------------------------------- | ---------- |
| 本文が空 / 名前が不正                                    | `400`      |
| 受信箱がいっぱい (32 件)                                 | `409`      |
| 本文が 2048 バイトを超える                               | `413`      |
| 問い合わせが多すぎる (同じ IP・同じ部屋で 1 分に 120 回) | `429`      |

## ichigocrate からの使い方

```basic
10 POST "https://<あなたの Worker>.workers.dev/r/42/B","D3",#1200,0   ' 相手 B へ自分の手を送る
20 NET GET "https://<あなたの Worker>.workers.dev/r/42/A",#1200,2048  ' 自分 A 宛てを取りに行く
30 IF NET()<0 GOTO 30
40 IF NET()=0 WAIT 30:GOTO 20                                          ' まだ届いていない
50 ?STR$(#1200)
```

`GET` / `POST` / `NET GET` / `NET POST` と `NET()` の詳細は ichigocrate の [core/README.md](https://github.com/Shiyo1101/ichigocrate/blob/main/core/README.md) を参照。web 版の ichigocrate から使えるよう、CORS (`X-Ichigocrate` と `Content-Type` ヘッダ) を許可している。

## 制限と注意

- 部屋は、最後にメッセージを積む・取り出すしてから 1 時間で中身ごと消える。読むだけの問い合わせでは何も保存しない
- 取り出した直後に通信が切れると、そのメッセージは失われる (再送の仕組みは無い)
- 認証は無い。部屋名を知っていれば誰でも読み書きできるので、推測されにくい部屋名を使い、個人情報などは送らないこと
- Cloudflare の無料プランには 1 日あたりのリクエスト数・書き込み数の上限がある。毎秒問い合わせる対戦を長時間続けると上限に近づく

## デプロイ

```bash
pnpm install
pnpm exec wrangler login   # Cloudflare アカウントでログイン
pnpm run deploy            # https://ichigocrate-relay.<アカウント>.workers.dev に公開
```

`wrangler.jsonc` の回数制限 (`ratelimits`) の `namespace_id` は Cloudflare アカウント内で一意な整数にする。ほかの Worker と同じ値だと回数を共有する。

## 開発

```bash
pnpm run dev          # http://localhost:8787 で起動
pnpm test             # Workers の実行環境 (workerd) 上でテスト
pnpm run typecheck
pnpm run lint
pnpm run format
pnpm run cf-typegen   # wrangler.jsonc を変えたら型 (worker-configuration.d.ts) を作り直す
```

ichigocrate は内部ネットワーク (localhost を含む) へつながないため、手元の `wrangler dev` には ichigocrate から接続できない。ichigocrate からの動作確認はデプロイしてから行う。
