/* Reminder texts (Japanese). `kind` comes from claim_notifications(). */
export function reminderMessage(kind, tripName) {
  const n = '「' + tripName + '」';
  if (kind === 'eve') return { title: '明日から ' + n, body: '予算とメンバーを、もう一度確認しておきましょう。' };
  if (kind === 'daily') return { title: '今日の支出を記録しましょう', body: n + ' — 使った分を、忘れないうちに。' };
  if (kind === 'settle') return { title: '精算を済ませましょう', body: n + ' の送金は、お済みですか？' };
  return null;
}
