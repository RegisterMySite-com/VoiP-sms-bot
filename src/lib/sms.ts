/** Twilio single-segment SMS limit is 1600 characters. Keep replies short. */
export const SMS_HARD_LIMIT = 1600;
export const SMS_PREFERRED_LIMIT = 320;

export function clampSms(text: string, limit = SMS_PREFERRED_LIMIT): string {
  const cleaned = text.replace(/\s+\n/g, "\n").trim();
  if (cleaned.length <= limit) return cleaned;
  const slice = cleaned.slice(0, limit - 1);
  const lastBreak = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(". "), slice.lastIndexOf(" "));
  const cut = lastBreak > limit * 0.5 ? slice.slice(0, lastBreak + 1) : slice;
  return `${cut.trimEnd()}…`;
}

export function splitSms(text: string, limit = SMS_HARD_LIMIT): string[] {
  const cleaned = text.trim();
  if (!cleaned) return [];
  if (cleaned.length <= limit) return [cleaned];
  const parts: string[] = [];
  let remaining = cleaned;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      parts.push(remaining);
      break;
    }
    const slice = remaining.slice(0, limit);
    const lastBreak = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(". "), slice.lastIndexOf(" "));
    const take = lastBreak > limit * 0.6 ? lastBreak + 1 : limit;
    parts.push(remaining.slice(0, take).trim());
    remaining = remaining.slice(take).trim();
  }
  return parts.slice(0, 3);
}

export function preview(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
