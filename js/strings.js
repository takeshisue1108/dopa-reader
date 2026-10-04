// The strings that the scripts show to the user (SPEC_dopa v3 §6.10; ED ED-10). `{name}` is
// filled by fill(). The page's own HTML holds its texts by itself, and the parsers have their own
// messages: some of the keys here are read by no script.

export const S = {
  site: "ドパドパBookリーダー",
  selectBook: "SELECT A BOOK",
  doujin: "同人作品",
  recent: "続きから",
  bundled: "収録の本",
  fromFile: "ファイルから",
  chooseFile: "ファイルを選ぶ",
  dropHere: "ここにファイルを置く",
  forget: "一覧から消す",
  loading: "エネルギー充填中 {n}%",
  badFormat: "この形式は読めません（.txt・.md・.pdf）",
  badEncoding: "文字コードを判別できませんでした",
  noText: "読める本文がありませんでした",
  pdfNoText: "この PDF には文字が入っていません",
  songLoading: "エネルギー充填中",
  songFailed: "歌の素材を読み込めませんでした",
  turnPhone: "スマホを横にしてください",
  launch: "M.E.O.W、発進！",
  shout: "{word}ミサイル！",
  clearNumbered: "第{n}章 クリア！",
  clearNamed: "{name} クリア！",
  totals: "文字 {c}・文 {s}・ブロック {p}",
  bookEnd: "読了！",
  figureLine: "本書 {label}（p.{page}）",
  figureLineNoPage: "本書 {label}",
  play: "▶ 再生",
  pause: "⏸ 一時停止",
  contents: "目次",
  blockOf: "ブロック {n}/{total}",
  jumpTo: "ブロックを指定",
  chooseBook: "本をえらぶ",
  settings: "設定",
  speed: "速さ",
  voice: "歌",
  music: "オケ",
  sfx: "効果音",
  fire: "発射",
  gear: "ギア",
  nextBlast: "次の爆発：{tier}",
  creditVoice: "歌声：VOICEVOX:No.7",
  creditMusic: "伴奏：FluidR3_GM（Frank Wen ほか）（CC BY 3.0）",
  licenses: "使用ライブラリと権利表記",
  chars: "{n} 文字",
};

/** A string with its `{name}` places filled. */
export function fill(text, values = {}) {
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    name in values ? String(values[name]) : whole,
  );
}
