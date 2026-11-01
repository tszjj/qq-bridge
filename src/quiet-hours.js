// 群组静默时段（quiet hours）
//
// 用途：在指定的「星期 + 本地时间窗」内，桥接不处理某些群的消息
//      （消息直接丢弃，不建立/推进 DSH 会话，也不触发主动冒泡）。
//
// config.json 示例：
//   "quietHours": [
//     { "groupId": 111111, "weekdays": [1,2,3,4,5], "start": "09:00", "end": "15:00", "label": "工作日上午" }
//   ]
//
// 规则说明：
//   • groupId  必填，纯数字群号（字符串/数字都接受）。
//   • weekdays 可选，ISO 星期：1=周一 … 7=周日；缺省为周一至周五。
//   • start/end 必填，"HH:MM"（24 小时制，按本机时区）；
//     start < end 为当天窗口；start > end 表示跨零点（如 "23:00" → "07:00"）；
//     start == end 视为无效规则（不会被启用）。
//   • label 可选，仅用于日志/展示。
//
// 本模块不依赖桥接内部状态，可单独用 node 做单元测试。

const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];

/** "HH:MM" → 当日分钟数；非法返回 null。 */
export function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** JS Date → ISO 星期（1=周一 … 7=周日）。 */
export function isoWeekday(date = new Date()) {
  const day = date.getDay(); // 0=周日 … 6=周六
  return day === 0 ? 7 : day;
}

/**
 * 规范化单条规则；无效返回 null。
 * @returns {{groupId:string, weekdays:number[], startMin:number, endMin:number, startText:string, endText:string, label:string}|null}
 */
export function normalizeQuietRule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const groupId = String(raw.groupId ?? raw.id ?? '').trim();
  if (!/^\d+$/.test(groupId) || groupId === '0') return null;

  const startMin = parseClock(raw.start);
  const endMin = parseClock(raw.end);
  if (startMin === null || endMin === null || startMin === endMin) return null;

  let weekdays = Array.isArray(raw.weekdays)
    ? raw.weekdays.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
    : DEFAULT_WEEKDAYS.slice();
  if (!weekdays.length) weekdays = DEFAULT_WEEKDAYS.slice();

  return {
    groupId,
    weekdays: [...new Set(weekdays)].sort((a, b) => a - b),
    startMin,
    endMin,
    startText: String(raw.start).trim(),
    endText: String(raw.end).trim(),
    label: String(raw.label ?? '').trim()
  };
}

/** 规范化整个 quietHours 数组；无法识别的条目忽略。 */
export function normalizeQuietHours(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeQuietRule).filter(Boolean);
}

/** 某条已规范化的规则在给定时刻是否生效。 */
export function isQuietAt(rule, date = new Date()) {
  if (!rule || typeof rule.startMin !== 'number' || typeof rule.endMin !== 'number') return false;
  if (!Array.isArray(rule.weekdays) || !rule.weekdays.includes(isoWeekday(date))) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (rule.startMin < rule.endMin) return minutes >= rule.startMin && minutes < rule.endMin;
  // 跨零点：例如 23:00 → 07:00
  return minutes >= rule.startMin || minutes < rule.endMin;
}

/**
 * 在规则列表里找出此刻命中该群号的规则；没有则返回 null。
 * 传进来的规则可以是原始 JSON（会自动规范化）。
 */
export function isGroupQuietNow(rules, groupId, date = new Date()) {
  const id = String(groupId ?? '');
  if (!id || !Array.isArray(rules)) return null;
  for (const raw of rules) {
    const rule = raw && typeof raw.startMin === 'number' ? raw : normalizeQuietRule(raw);
    if (!rule || rule.groupId !== id) continue;
    if (isQuietAt(rule, date)) return rule;
  }
  return null;
}
