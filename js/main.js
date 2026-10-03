// The page of ドパドパ読書リーダー (SPEC_dopa v3 §6.1, §6.2, §6.9, §6.10; ED V-05, V-06, ST-16,
// ST-17, ST-24 to ST-27, ST-32, ST-36, D-74, D-76, D-97, D-99, D-106). It boots the cockpit, shows
// the book list, opens a book (a bundled one, a kept upload, or a new file) and wires the controls.
import * as books from "./books/index.js";
import { closePdf, renderPdfPage } from "./books/pdfpages.js";
import * as cockpit from "./cockpit/cockpit.js";
import { createAnalyzer } from "./lang/client.js";
import * as reader from "./reader.js";
import * as sing from "./sing/index.js";
import * as sound from "./sound.js";
import * as prefs from "./store/prefs.js";
import * as shelf from "./store/shelf.js";
import { fill, S } from "./strings.js";

const $ = (id) => document.getElementById(id);
let bundled = [], // data/books/index.json
  book = null,
  listOpen = false;

// ---------------------------------------------------------------- boot
async function boot() {
  watchOrientation();
  await cockpit.load();
  cockpit.setCount(prefs.count());
  reader.init({
    analyzer: createAnalyzer(),
    sfx: (role) => sound.play(role),
    onState: ({ playing }) => ($("play").textContent = playing ? S.pause : S.play),
    onNotice: notice,
    onChars: (n) => ($("chars").textContent = fill(S.chars, { n: n.toLocaleString("ja-JP") })),
    onBookEnd: () => showList(),
    renderPdfPage, // a PDF's figure page (§6.7), from the document kept on the book
    onLive: (text) => ($("live").textContent = text),
    onAnnounce: (text) => ($("announce").textContent = text),
  });
  try {
    bundled = await (await fetch("data/books/index.json")).json();
  } catch {
    bundled = [];
  }
  wireControls();
  showTitle();
  if (new URLSearchParams(location.search).has("gallery")) showGallery();
  // the first touch of a visit: phones want the audio made inside a gesture (§6.9)
  addEventListener("pointerdown", unlockAudio, { capture: true });
  addEventListener("keydown", unlockAudio, { capture: true });
}

function unlockAudio() {
  // not while the song is held (⏸, the lever down, a drawer): a tap must not start it (D-143)
  const context = sing.ensureContext();
  if (!sing.condition().held) context.resume().catch(() => {});
  sound.init(prefs.settings().sfx);
}

// ---------------------------------------------------------------- the title screen (V-07)
/** The title screen (ST-40, D-142): the rainbow name and 「同人作品」 above M.E.O.W, and
 * 「SELECT A BOOK」, which opens the book list. */
function showTitle() {
  cockpit.showList(); // the list's scene: black, M.E.O.W, the running Elena, the particles
  cockpit.hideMonitor(); // no panel behind the title
  $("controls").hidden = true;
  $("list").hidden = true;
  $("title").hidden = false;
  const button = $("select-book");
  button.onclick = () => {
    $("title").hidden = true;
    showList();
  };
}

// ---------------------------------------------------------------- the book list (V-06)
async function showList() {
  listOpen = true;
  if (book) reader.hold(true);
  $("controls").hidden = true;
  cockpit.showList();
  const list = $("list");
  $("title").hidden = true;
  list.hidden = false;
  list.replaceChildren();
  const add = (tag, props = {}, parent = list) => parent.appendChild(Object.assign(document.createElement(tag), props));
  const message = add("p", { className: "message", id: "list-message" });

  add("h2", { textContent: S.fromFile });
  const input = add("input", { type: "file", accept: ".txt,.md,.pdf", hidden: true });
  input.onchange = () => input.files[0] && openFile(input.files[0]);
  add("button", { className: "book", textContent: S.chooseFile, onclick: () => input.click() });
  const drop = add("div", { className: "drop", textContent: S.dropHere });
  drop.ondragover = (event) => {
    event.preventDefault();
    drop.classList.add("over");
  };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (event) => {
    event.preventDefault();
    drop.classList.remove("over");
    const file = event.dataTransfer.files[0];
    if (file) openFile(file);
  };

  add("h2", { textContent: S.bundled });
  const ul = add("ul");
  for (const entry of bundled) {
    const li = add("li", {}, ul);
    const button = add("button", { className: "book", onclick: () => openKey(entry.key) }, li);
    button.append(entry.title);
    button.append(Object.assign(document.createElement("span"), { className: "author", textContent: entry.author }));
  }

  // 「続きから」: books read before, the latest first (uploads only while still kept)
  const kept = new Set(await shelf.keys());
  const recent = prefs.recent().filter((place) => (place.key.startsWith("file:") ? kept.has(place.key) : bundled.some((b) => b.key === place.key)));
  if (recent.length) {
    add("h2", { textContent: S.recent });
    const ul = add("ul");
    for (const place of recent) {
      const entry = bundled.find((b) => b.key === place.key),
        title = entry ? entry.title : place.title || place.key;
      const li = add("li", {}, ul);
      add("button", { className: "book", textContent: title, onclick: () => openKey(place.key) }, li);
      add("button", {
        className: "forget",
        textContent: S.forget,
        onclick: async () => {
          prefs.forget(place.key);
          if (place.key.startsWith("file:")) await shelf.remove(place.key);
          showList();
        },
      }, li);
    }
  }

  const credits = add("div", { className: "credits" });
  add("div", { textContent: S.creditVoice }, credits);
  add("div", { textContent: S.creditMusic }, credits);
  add("a", { href: "LICENSES.md", target: "_blank", rel: "noopener", textContent: S.licenses }, add("div", {}, credits));
  list.querySelector("button.book")?.focus();
}

function listMessage(text) {
  const line = $("list-message");
  if (!line) return;
  line.textContent = text || "";
  if (text) setTimeout(() => line.textContent === text && (line.textContent = ""), 6000); // ST-27
}

/** Open a bundled book or a kept upload by its key. */
async function openKey(key) {
  if (key.startsWith("file:")) {
    const record = await shelf.get(key);
    if (!record) return listMessage(S.noText);
    return openBytes(record.name, new Uint8Array(record.bytes), key);
  }
  const entry = bundled.find((b) => b.key === key);
  if (!entry) return;
  listMessage(fill(S.loading, { n: 0 }));
  try {
    const bytes = new Uint8Array(await (await fetch(entry.path)).arrayBuffer());
    const folder = entry.path.replace(/[^/]+$/, "");
    listMessage(fill(S.loading, { n: 60 }));
    const opened = await books.parseFile({ name: "text.txt", bytes, key, imageBase: folder });
    start(opened);
  } catch (error) {
    listMessage(error.message || S.noText);
  }
}

/** A new file from 「ファイルを選ぶ」 or the drop place: read, keep, open (ST-26). */
async function openFile(file) {
  listMessage(fill(S.loading, { n: 0 }));
  const bytes = new Uint8Array(await file.arrayBuffer());
  listMessage(fill(S.loading, { n: 40 }));
  const key = await shelf.keyOf(bytes);
  await openBytes(file.name, bytes, key, true);
}

async function openBytes(name, bytes, key, keep = false) {
  try {
    const opened = await books.parseFile({ name, bytes, key });
    if (keep) await shelf.keep(key, { name, type: "", bytes });
    start(opened);
  } catch (error) {
    if (error.code === "pdf") listMessage(S.badFormat); // a PDF that pdf.js cannot open
    else listMessage(error.message || S.noText);
  }
}

/** The boarding (ST-25), then the reading (§6.2). */
async function start(opened) {
  listMessage("");
  if (book && book !== opened) closePdf(book); // the PDF document of the book left behind
  book = opened;
  prefs.setPosition(book.key, { title: book.title });
  $("list").hidden = true;
  listOpen = false;
  await cockpit.board();
  $("controls").hidden = false;
  cockpit.wake();
  updateJumpLabel();
  reader.open(book);
}

// ---------------------------------------------------------------- the controls
function wireControls() {
  $("play").onclick = () => (reader.isPlaying() ? reader.pause() : reader.play());
  $("fire").addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    if (reader.isPlaying()) cockpit.lightMissile();
    reader.press(event);
  });
  $("fire").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      reader.press(event);
    }
  });
  // the bomb's picture (D-144): the explosion and the stop, and the lever goes down with it
  $("bomb").addEventListener("click", (event) => {
    event.stopPropagation();
    reader.pressBomb();
  });
  $("bomb").addEventListener("pointerdown", (event) => event.stopPropagation());
  // the gear lever (D-126, D-145): each tap moves it; down sets the explosion off, up goes on
  $("gear").addEventListener("click", (event) => {
    event.stopPropagation();
    reader.toggleLever();
  });
  $("gear").addEventListener("pointerdown", (event) => event.stopPropagation());
  $("open-list").onclick = () => showList();
  $("open-contents").onclick = () => openDrawer("contents");
  $("open-jump").onclick = () => openDrawer("jump");
  $("open-settings").onclick = () => openDrawer("settings");
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.querySelector(".close").onclick = () => dialog.close();
    dialog.addEventListener("close", () => reader.hold(false));
  }
  $("jump-go").onclick = () => {
    const page = Number($("jump-page").value),
      number = Number($("jump-number").value);
    let target = number - 1;
    if (page && book.format === "pdf") target = Math.max(0, book.blocks.findIndex((b) => b.page >= page));
    $("jump").close();
    if (target >= 0) reader.jump(target);
  };
  addEventListener("keydown", (event) => {
    if (event.key === "Escape" && listOpen && book) {
      $("list").hidden = true;
      listOpen = false;
      $("controls").hidden = false;
      reader.hold(false);
    }
  });
  for (const kind of ["mousemove", "pointerdown", "keydown"]) addEventListener(kind, () => !listOpen && cockpit.wake());

  const s = prefs.settings();
  $("set-speed").value = s.speed;
  $("set-voice").value = s.voice;
  $("set-music").value = s.music;
  $("set-sfx").value = s.sfx;
  $("set-speed").oninput = (e) => {
    prefs.setSetting("speed", Number(e.target.value));
    sing.setSpeed(Number(e.target.value));
  };
  $("set-voice").oninput = (e) => {
    prefs.setSetting("voice", Number(e.target.value));
    sing.setVoice(Number(e.target.value));
  };
  $("set-music").oninput = (e) => {
    prefs.setSetting("music", Number(e.target.value));
    sing.setMusic(Number(e.target.value));
  };
  $("set-sfx").oninput = (e) => {
    prefs.setSetting("sfx", Number(e.target.value));
    sound.setLevel(Number(e.target.value));
  };
  document.querySelector("#settings .credits").textContent = `${S.creditVoice}　${S.creditMusic}`;
}

function openDrawer(id) {
  if (!book) return;
  reader.hold(true); // the song stops while a drawer is open (V-05)
  if (id === "contents") {
    const list = $("contents-list");
    list.replaceChildren();
    book.chapters.forEach((chapter) => {
      const li = document.createElement("li");
      li.append(Object.assign(document.createElement("button"), { textContent: chapter.title || book.title, onclick: () => ($("contents").close(), reader.jump(chapter.firstBlock)) }));
      list.append(li);
    });
    $("end-notes").textContent = (book.endNotes || []).join("\n"); // D-78
  }
  if (id === "jump") {
    $("jump-total").textContent = book.blocks.length;
    $("jump-number").max = book.blocks.length;
    $("jump-number").value = reader.debug().at.block + 1;
    $("jump-page-row").hidden = book.format !== "pdf";
  }
  $(id).showModal();
}

function updateJumpLabel() {
  const refresh = () => {
    if (book) $("open-jump").textContent = fill(S.blockOf, { n: reader.debug().at.block + 1, total: book.blocks.length });
  };
  refresh();
  setInterval(refresh, 1000);
}

let noticeTimer = null;
/** A notice in the corner (エネルギー充填中, 歌の素材を…); `null` with `which` clears that one. */
function notice(text, which) {
  const line = $("notice");
  if (text === null) {
    if (line.textContent === which) line.textContent = "";
    return;
  }
  line.textContent = text;
  clearTimeout(noticeTimer);
  if (text !== S.songLoading) noticeTimer = setTimeout(() => (line.textContent = ""), 6000);
}

/** A phone held upright stops everything and asks to be turned (ST-36, D-99, SD-W14). */
function watchOrientation() {
  const upright = matchMedia("(orientation: portrait) and (pointer: coarse)");
  const check = () => {
    $("turn").hidden = !upright.matches;
    if (upright.matches && book && reader.isPlaying()) reader.pause();
  };
  upright.addEventListener("change", check);
  check();
}

/** The gallery (?gallery=1; SPEC_dopa v3 §9.3, Q-21): the synthesized sounds, the five explosion
 * tiers, the bomb's steps and a spinning enemy, for the owner to judge. Not a part of reading. */
function showGallery() {
  const panel = Object.assign(document.createElement("div"), { id: "gallery" });
  panel.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:60;background:#0b1a16;border:2px solid #3fe0a0;padding:8px;max-width:420px;font-size:14px;display:flex;flex-wrap:wrap;gap:4px";
  const add = (text, fn) => panel.append(Object.assign(document.createElement("button"), { textContent: text, onclick: () => (unlockAudio(), fn()) }));
  for (const role of ["launch", "hit", "miss", "siren", "sting", "boom_s", "boom_m", "boom_l", "boom_xl", "boom_max", "fanfare", "tally", "levelup", "boss_hit", "boss_fall", "lever"]) add(`音 ${role}`, () => sound.play(role));
  ["小", "中", "大", "特大", "最大"].forEach((name, k) => add(`爆発 ${name}`, () => {
    $("list").hidden = true;
    cockpit.gallery.blast(1 + 2 * k);
  }));
  [0, 1, 3, 5, 7, 9].forEach((lv) => add(`爆弾 Lv${lv}`, () => cockpit.gallery.count([0, 1, 5, 8, 13, 21, 33, 53, 84, 135][lv])));
  add("一覧を隠す", () => ($("list").hidden = !$("list").hidden));
  document.body.append(panel);
}

// for checks
globalThis.ddr = { reader: () => reader.debug(), cockpit: () => cockpit.debug(), sing: () => sing.condition() };

boot();
