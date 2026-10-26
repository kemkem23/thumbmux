/**
 * Copy for the existing compose failure bar.
 *
 * The phrase is short Thai. The parenthetical is the reason code the receipt
 * already carried (`network`, `http_502`, `in_doubt`, a server code, …).
 * Anything that is not a code is not echoed — a receipt must not become a
 * second place the typed text can show up.
 */

const KNOWN: Readonly<Record<string, string>> = {
  network: 'เน็ตขาด',
  unexpected_response: 'คำตอบไม่ใช่ใบรับ',
  in_doubt: 'เซิร์ฟเวอร์ไม่แน่ใจ',
  lifecycle_mismatch: 'รอบเซสชันไม่ตรง',
  transport_unavailable: 'ส่งเข้าจอไม่ได้',
  ledger_unavailable: 'บันทึกการส่งใช้ไม่ได้',
  id_conflict: 'รหัสส่งซ้ำ',
  text_empty: 'ข้อความว่าง',
  text_too_large: 'ข้อความยาวเกิน',
  text_bare_cr: 'มีอักขระ CR',
  text_control_char: 'มีอักขระควบคุม',
  text_invalid: 'ข้อความใช้ไม่ได้',
  submission_required: 'ไม่มีใบส่ง',
  submission_invalid: 'ใบส่งใช้ไม่ได้',
  keys_with_submission: 'ส่งสองแบบพร้อมกัน',
  id_invalid: 'รหัสส่งใช้ไม่ได้',
  instance_id_invalid: 'รหัสรอบใช้ไม่ได้',
  agent_invalid: 'ชนิดเอเจนต์ใช้ไม่ได้',
  'storage-paused': 'ที่เก็บข้อมูลพักอยู่',
  unauthorized: 'ไม่ได้รับอนุญาต',
  quiescing: 'เซิร์ฟเวอร์กำลังปิดรับ',
  cutover_locked: 'จอถูกล็อกชั่วคราว',
  keys_required: 'เซิร์ฟเวอร์ไม่รับใบส่ง',
};

const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Thai phrase plus the reason code, for one receipt.reason. */
export function submissionFailureNotice(reason: string): string {
  const code = reason.trim();
  const http = /^http_(\d{3})$/.exec(code);
  if (http) return `เซิร์ฟเวอร์ตอบ ${http[1]} (${code})`;
  const phrase = KNOWN[code];
  if (phrase) return `${phrase} (${code})`;
  if (CODE.test(code)) return `ส่งไม่สำเร็จ (${code})`;
  return 'ส่งไม่สำเร็จ (unknown)';
}

export function noticeAfterSubmit(
  receipt: { status?: 'sent' | 'rejected' | 'uncertain'; reason?: string } | null | undefined,
  fallbackUncertain: string,
): string | null {
  if (receipt?.status === 'sent') return null;
  const reason = typeof receipt?.reason === 'string' ? receipt.reason.trim() : '';
  if (reason) return submissionFailureNotice(reason);
  if (receipt?.status === 'rejected') return null;
  return fallbackUncertain;
}
