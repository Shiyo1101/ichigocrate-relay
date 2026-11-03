/** 1 件のメッセージの上限 (バイト)。ichigocrate の POST の本文・応答の上限 (2KB) と同じ。 */
export const MAX_MESSAGE_BYTES = 2048;

/** 1 つの受信箱に積める件数。超えたら 409 を返す。 */
export const MAX_QUEUED_MESSAGES = 32;

/** 部屋を最後のメッセージから何ミリ秒で消すか (1 時間)。 */
export const ROOM_TTL_MS = 60 * 60 * 1000;

/** 部屋名・受信箱名に使える文字。大文字小文字は区別しない (大文字にそろえる)。 */
export const NAME_PATTERN = /^[0-9A-Za-z_-]{1,32}$/;
