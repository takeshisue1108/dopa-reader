// The page of ドパドパBookリーダー (SPEC_dopa v3 §6.1, §6.2, §6.9, §6.10; ED V-05, V-06, ST-16,
// ST-17, ST-24 to ST-27, ST-32, ST-36, D-74, D-76, D-97, D-99, D-106). It boots the cockpit, shows
// the book list, opens a book (a bundled one, a kept upload, or a new file) and wires the controls.
import * as books from "./books/index.js";
import { closePdf, renderPdfPage } from "./books/pdfpages.js";
import * as cockpit from "./cockpit/cockpit.js";
import { createAnalyzer } from "./lang/client.js";
import * as loading from "./loading.js";
import * as reader from "./reader.js";
import * as sing from "./sing/index.js";
import * as sound from "./sound.js";
import * as prefs from "./store/prefs.js";
import * as shelf from "./store/shelf.js";
import { fill, S } from "./strings.js";

const $ = (id) => document.getElementById(id);

let bundled = []; // data/books/index.json
let book = null;
let listOpen = false;

// ---------------------------------------------------------------- boot
/** Boot the page: load the cockpit, give the reader its callbacks, load the list of the bundled
 * books, wire the controls and show the title. */
async function boot() {
  watchOrientation();

  // the bar of the loading words (D-163): the scripts run, and the cockpit's files are counted
  loading.count("page", 0, 1);
  const stopBar = loading.watch(() => {
    const percentNow = loading.pagePercent(false);
    pageBar(percentNow);
  });
  const percentAtStart = loading.pagePercent(false);
  pageBar(percentAtStart);

  await cockpit.load();
  stopBar();

  const explosionCount = prefs.count();
  cockpit.setCount(explosionCount);

  const analyzer = createAnalyzer();
  reader.init({
    analyzer,
    sfx: (role) => sound.play(role),
    onState: ({ playing }) => {
      const label = playing ? S.pause : S.play;
      $("play").textContent = label;
    },
    onNotice: notice,
    onChars: (n) => {
      const grouped = n.toLocaleString("ja-JP");
      $("chars").textContent = fill(S.chars, { n: grouped });
    },
    onBookEnd: () => showList(),
    renderPdfPage, // a PDF's figure page (§6.7), from the document kept on the book
    onLive: (text) => {
      $("live").textContent = text;
    },
    onAnnounce: (text) => {
      $("announce").textContent = text;
    },
  });

  try {
    const response = await fetch("data/books/index.json");
    bundled = await response.json();
  } catch {
    bundled = [];
  }
  const percentAtEnd = loading.pagePercent(true);
  pageBar(percentAtEnd);

  wireControls();
  showTitle();

  // The loading words (D-154) go when the title's scene has been drawn under them: taken away at
  // once, they showed for a frame what the canvases still held, the cockpit with Elena from
  // behind (D-164).
  await cockpit.afterNextDraw();
  $("loading")?.remove();

  const query = new URLSearchParams(location.search);
  if (query.has("gallery")) {
    showGallery();
  }

  // at every touch and key: phones want the audio made, and woken, inside a gesture (§6.9)
  addEventListener("pointerdown", unlockAudio, { capture: true });
  addEventListener("keydown", unlockAudio, { capture: true });
}

/** Fill the bar of the loading words to `percent` (0 to 100); nothing once they are gone. */
function pageBar(percent) {
  const bar = $("loading-bar");
  if (!bar) {
    return;
  }

  $("loading-fill").style.width = `${percent}%`;

  const wholePercent = Math.round(percent);
  bar.setAttribute("aria-valuenow", String(wholePercent));
}

/** At every touch and key: make the song's AudioContext and let it run, and make the effects'
 * context and load the effects. Both must happen inside a gesture on a phone. */
function unlockAudio() {
  const context = sing.ensureContext();

  // not while the song is held (⏸, the lever down, a drawer): a tap must not start it (D-143)
  const song = sing.condition();
  if (!song.held) {
    const resuming = context.resume();
    resuming.catch(() => {});
  }

  const saved = prefs.settings();
  sound.init(saved.sfx);
}

// ---------------------------------------------------------------- the title screen (V-07)
/** The title screen (ST-40, D-142): the rainbow name and 「同人作品」 above M.E.O.W, and
 * 「SELECT A BOOK」, which opens the book list. */
function showTitle() {
  // the list's scene: black, M.E.O.W, the running Elena, the particles
  cockpit.showList();
  // no panel behind the title
  cockpit.hideMonitor();

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
/** Show the book list over the main monitor: a file to choose or to drop, the bundled books, the
 * books read before (「続きから」) and the credits. The reading is held while it is open. */
async function showList() {
  listOpen = true;
  if (book) {
    reader.hold(true);
  }
  $("controls").hidden = true;
  cockpit.showList();

  const list = $("list");
  $("title").hidden = true;
  list.hidden = false;
  list.replaceChildren();

  const add = (tag, props = {}, parent = list) => {
    const element = document.createElement(tag);
    Object.assign(element, props);
    return parent.appendChild(element);
  };

  add("div", {
    className: "message",
    id: "list-message",
  });

  add("h2", { textContent: S.fromFile });

  const input = add("input", {
    type: "file",
    accept: ".txt,.md,.pdf",
    hidden: true,
  });
  input.onchange = () => {
    const chosen = input.files[0];
    if (chosen) {
      openFile(chosen);
    }
  };

  add("button", {
    className: "book",
    textContent: S.chooseFile,
    onclick: () => input.click(),
  });

  const drop = add("div", {
    className: "drop",
    textContent: S.dropHere,
  });
  drop.ondragover = (event) => {
    event.preventDefault();
    drop.classList.add("over");
  };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (event) => {
    event.preventDefault();
    drop.classList.remove("over");

    const file = event.dataTransfer.files[0];
    if (file) {
      openFile(file);
    }
  };

  add("h2", { textContent: S.bundled });
  const group = add("ul");
  for (const entry of bundled) {
    const row = add("li", {}, group);

    const button = add(
      "button",
      {
        className: "book",
        onclick: () => openKey(entry.key),
      },
      row,
    );
    button.append(entry.title);

    const author = document.createElement("span");
    Object.assign(author, {
      className: "author",
      textContent: entry.author,
    });
    button.append(author);
  }

  // 「続きから」: books read before, the latest first (uploads only while still kept)
  const keptKeys = await shelf.keys();
  const kept = new Set(keptKeys);

  const recent = [];
  for (const place of prefs.recent()) {
    let canOpen;
    if (place.key.startsWith("file:")) {
      canOpen = kept.has(place.key);
    } else {
      canOpen = bundled.some((known) => known.key === place.key);
    }

    if (canOpen) {
      recent.push(place);
    }
  }

  if (recent.length) {
    add("h2", { textContent: S.recent });
    const group = add("ul");

    for (const place of recent) {
      const entry = bundled.find((known) => known.key === place.key);

      let title;
      if (entry) {
        title = entry.title;
      } else {
        title = place.title || place.key;
      }

      const row = add("li", {}, group);
      add(
        "button",
        {
          className: "book",
          textContent: title,
          onclick: () => openKey(place.key),
        },
        row,
      );
      add(
        "button",
        {
          className: "forget",
          textContent: S.forget,
          onclick: async () => {
            prefs.forget(place.key);
            if (place.key.startsWith("file:")) {
              await shelf.remove(place.key);
            }
            showList();
          },
        },
        row,
      );
    }
  }

  const credits = add("div", { className: "credits" });
  add("div", { textContent: S.creditVoice }, credits);
  add("div", { textContent: S.creditEnglishVoice }, credits);
  add("div", { textContent: S.creditMusic }, credits);

  const licensesLine = add("div", {}, credits);
  add(
    "a",
    {
      href: "LICENSES.md",
      target: "_blank",
      rel: "noopener",
      textContent: S.licenses,
    },
    licensesLine,
  );

  const firstBook = list.querySelector("button.book");
  firstBook?.focus();
}

/** Close the list without choosing a book (Esc, while a book is being read): the cockpit comes
 * back as it was, and the reading goes on if it was going (D-147). The four things that
 * showList() did for the book being read are undone here: the list, the floating controls, the
 * cockpit's scene, the hold. */
function closeList() {
  $("list").hidden = true;
  listOpen = false;
  $("controls").hidden = false;
  cockpit.hideList();
  reader.hold(false);
}

/** A line of text at the top of the list (why a file cannot be read). It goes away after 6 s
 * (ST-27). */
function listMessage(text) {
  const line = $("list-message");
  if (!line) {
    return;
  }

  line.textContent = text || "";

  if (text) {
    setTimeout(() => {
      // a newer message, or the charging display, stays
      if (line.textContent === text) {
        line.textContent = "";
      }
    }, 6000);
  }
}

/** The charging display at the top of the list while a file is opened (ST-26): `percent` is the
 * stage reached (0 at the start, then a fixed number for each stage), not a measure. */
function listCharge(percent) {
  const line = $("list-message");
  if (!line) {
    return;
  }

  if (!line.querySelector(".charge")) {
    const emptyCharge = document.createElement("div");
    Object.assign(emptyCharge, { className: "charge" });
    line.replaceChildren(emptyCharge);
  }

  const place = line.querySelector(".charge");
  setCharge(place, percent);
}

// ---------------------------------------------------------------- the charging display
/** Write the charging display into `place` (ED D-153, A-41; SPEC §6.2a): 「エネルギー充填中 {n}%」
 * and, under it, the bar filled to {n}%. The words for a screen reader are written when the
 * display is made, not at every change; the bar tells its own value. */
function setCharge(place, percent) {
  if (!place.querySelector(".bar")) {
    const make = (tag, className) => {
      const element = document.createElement(tag);
      return Object.assign(element, { className });
    };

    const words = make("p", "words");
    const spoken = make("span", "hidden-text");
    const bar = make("div", "bar");

    words.setAttribute("aria-hidden", "true");

    spoken.setAttribute("role", "status");
    spoken.textContent = S.songLoading;

    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", S.songLoading);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    const barFill = make("div", "fill");
    bar.append(barFill);

    place.replaceChildren(words, spoken, bar);
  }

  const wordsShown = place.querySelector(".words");
  wordsShown.textContent = fill(S.loading, { n: percent });

  const barShown = place.querySelector(".bar");
  barShown.setAttribute("aria-valuenow", String(percent));

  const fillShown = place.querySelector(".fill");
  fillShown.style.width = `${percent}%`;
}

let stopCharging = null; // stops the watch on the files, while the charging display is up
/** The charging display in the middle of the glass, while a sentence waits for the song's files,
 * the dictionary or its voice (ST-43). {n} is measured (chargePercent in loading.js). When the
 * song's own files are still coming, they fill the first 70 of the bar and the voice sheets of the
 * sentence that waits fill the rest; when only the voice is waited for, it fills the whole bar.
 * The voice counts from the moment its sheets are asked for during this wait: until then the
 * "voice" group still holds the finished count of the sentence before, which would show a full
 * bar that then falls. (The song's own part can still fall once: when the instruments' index
 * arrives, it says how many sheets are to come.) */
function showCharge() {
  if (stopCharging) {
    return;
  }

  const place = $("charge");
  const songWaited = loading.songPending();
  let voiceAsked = false;

  const update = () => {
    if (!voiceAsked) {
      const waiting = loading.pending();
      voiceAsked = waiting.includes("voice");
    }

    const percent = loading.chargePercent(songWaited, voiceAsked);
    const wholePercent = Math.floor(percent);
    setCharge(place, wholePercent);
  };

  update();
  place.hidden = false;
  stopCharging = loading.watch(update);
}
function hideCharge() {
  if (!stopCharging) {
    return;
  }

  stopCharging();
  stopCharging = null;

  $("charge").hidden = true;
  $("charge").replaceChildren(); // made anew, and said anew, the next time
}

// ---------------------------------------------------------------- opening a book
/** Open a bundled book or a kept upload by its key. */
async function openKey(key) {
  if (key.startsWith("file:")) {
    const record = await shelf.get(key);
    if (!record) {
      return listMessage(S.noText);
    }

    const keptBytes = new Uint8Array(record.bytes);
    return openBytes(record.name, keptBytes, key);
  }

  const entry = bundled.find((known) => known.key === key);
  if (!entry) {
    return;
  }

  listCharge(0);
  try {
    const response = await fetch(entry.path);
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const folder = entry.path.replace(/[^/]+$/, "");
    listCharge(60);

    const opened = await books.parseFile({
      name: "text.txt",
      bytes,
      key,
      imageBase: folder,
    });
    start(opened);
  } catch (error) {
    const reason = error.message || S.noText;
    listMessage(reason);
  }
}

/** A new file from 「ファイルを選ぶ」 or the drop place: read, keep, open (ST-26). */
async function openFile(file) {
  listCharge(0);
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  listCharge(40);

  const key = await shelf.keyOf(bytes);
  await openBytes(file.name, bytes, key, true);
}

/** Read a file's bytes as a book and start reading it; with `keep`, the file is first kept in
 * the browser, to be offered again. A file that cannot be read gives its reason on the list. */
async function openBytes(name, bytes, key, keep = false) {
  try {
    const opened = await books.parseFile({
      name,
      bytes,
      key,
    });

    if (keep) {
      await shelf.keep(key, {
        name,
        type: "",
        bytes,
      });
    }

    start(opened);
  } catch (error) {
    if (error.code === "pdf") {
      // a PDF that pdf.js cannot open
      listMessage(S.badFormat);
    } else {
      const reason = error.message || S.noText;
      listMessage(reason);
    }
  }
}

/** The boarding (ST-25), then the reading (§6.2). */
async function start(opened) {
  listMessage("");

  // the PDF document of the book left behind
  if (book && book !== opened) {
    closePdf(book);
  }
  book = opened;
  prefs.setPosition(book.key, { title: book.title });

  $("list").hidden = true;
  listOpen = false;
  await cockpit.board();

  $("controls").hidden = false;
  cockpit.wake();
  startJumpLabelTimer();
  reader.open(book);
}

// ---------------------------------------------------------------- the controls
/** Wire the buttons, the drawers and the four settings (once, at boot). */
function wireControls() {
  $("play").onclick = () => {
    if (reader.isPlaying()) {
      return reader.pause();
    }
    return reader.play();
  };

  $("fire").addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    if (reader.isPlaying()) {
      cockpit.lightMissile();
    }
    reader.press(event);
  });
  $("fire").addEventListener("keydown", (event) => {
    const pressed = event.key === "Enter" || event.key === " ";
    if (pressed) {
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

  // the play icon above the lever (D-152): what 「▶ 再生」 does to a stopped reader
  $("go").addEventListener("click", (event) => {
    event.stopPropagation();
    reader.pressGo();
  });
  $("go").addEventListener("pointerdown", (event) => event.stopPropagation());

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
    const closeButton = dialog.querySelector(".close");
    closeButton.onclick = () => dialog.close();
    dialog.addEventListener("close", () => reader.hold(false));
  }

  $("jump-go").onclick = () => {
    const page = Number($("jump-page").value);
    const number = Number($("jump-number").value);

    // the block of that number; for a PDF with a page given, the first block on that page or
    // after it, and the book's first block when there is none
    let blockIndex = number - 1;
    if (page && book.format === "pdf") {
      const firstFromPage = book.blocks.findIndex((block) => block.page >= page);
      blockIndex = Math.max(0, firstFromPage);
    }

    $("jump").close();
    if (blockIndex >= 0) {
      reader.jump(blockIndex);
    }
  };

  addEventListener("keydown", (event) => {
    if (event.key === "Escape" && listOpen && book) {
      closeList();
    }
  });
  for (const kind of ["mousemove", "pointerdown", "keydown"]) {
    addEventListener(kind, () => {
      if (!listOpen) {
        cockpit.wake();
      }
    });
  }

  const saved = prefs.settings();
  $("set-speed").value = saved.speed;
  $("set-voice").value = saved.voice;
  $("set-music").value = saved.music;
  $("set-sfx").value = saved.sfx;

  $("set-speed").oninput = (event) => {
    const speed = Number(event.target.value);
    prefs.setSetting("speed", speed);
    sing.setSpeed(speed);
  };
  $("set-voice").oninput = (event) => {
    const voice = Number(event.target.value);
    prefs.setSetting("voice", voice);
    sing.setVoice(voice);
  };
  $("set-music").oninput = (event) => {
    const music = Number(event.target.value);
    prefs.setSetting("music", music);
    sing.setMusic(music);
  };
  $("set-sfx").oninput = (event) => {
    const sfx = Number(event.target.value);
    prefs.setSetting("sfx", sfx);
    sound.setLevel(sfx);
  };

  // 「歌のモード」 (ED D-157, A-43): the choice holds from the next sentence that starts
  for (const choice of document.querySelectorAll('input[name="set-melody"]')) {
    choice.checked = choice.value === saved.melody;
    choice.onchange = () => {
      prefs.setSetting("melody", choice.value);
      sing.setMelody(choice.value);
    };
  }

  const credits = document.querySelector("#settings .credits");
  credits.textContent = `${S.creditVoice}　${S.creditEnglishVoice}　${S.creditMusic}`;
}

/** Open a drawer ("contents", "jump" or "settings"), filled for the book being read. The reading
 * is held until it closes. */
function openDrawer(id) {
  if (!book) {
    return;
  }
  reader.hold(true); // the song stops while a drawer is open (V-05)

  if (id === "contents") {
    const list = $("contents-list");
    list.replaceChildren();

    book.chapters.forEach((chapter) => {
      const row = document.createElement("li");

      const button = document.createElement("button");
      Object.assign(button, {
        textContent: chapter.title || book.title,
        onclick: () => {
          $("contents").close();
          return reader.jump(chapter.firstBlock);
        },
      });
      row.append(button);

      list.append(row);
    });

    // D-78
    const endNotes = book.endNotes || [];
    $("end-notes").textContent = endNotes.join("\n");
  }

  if (id === "jump") {
    $("jump-total").textContent = book.blocks.length;
    $("jump-number").max = book.blocks.length;

    const reading = reader.debug();
    $("jump-number").value = reading.at.block + 1;

    $("jump-page-row").hidden = book.format !== "pdf";
  }

  $(id).showModal();
}

/** The button 「ブロック n/total」 shows the block being read; it is written anew every second,
 * by a timer that each call of this starts. */
function startJumpLabelTimer() {
  const refresh = () => {
    if (book) {
      const reading = reader.debug();
      const label = fill(S.blockOf, {
        n: reading.at.block + 1,
        total: book.blocks.length,
      });
      $("open-jump").textContent = label;
    }
  };

  refresh();
  setInterval(refresh, 1000);
}

let noticeTimer = null;
/** A notice at the lower edge (歌の素材を…), which goes away after 6 s; `null` with `which`
 * clears that one. The charging words are not written there: they bring the charging display up,
 * and `null` with them takes it away. */
function notice(text, which) {
  // the charging words have a display of their own (D-153)
  if (text === S.songLoading) {
    return showCharge();
  }
  if (text === null && which === S.songLoading) {
    return hideCharge();
  }

  const line = $("notice");
  if (text === null) {
    if (line.textContent === which) {
      line.textContent = "";
    }
    return;
  }

  line.textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    line.textContent = "";
  }, 6000);
}

/** A phone held upright stops everything and asks to be turned (ST-36, D-99, SD-W14). */
function watchOrientation() {
  const upright = matchMedia("(orientation: portrait) and (pointer: coarse)");

  const check = () => {
    $("turn").hidden = !upright.matches;

    if (upright.matches && book && reader.isPlaying()) {
      reader.pause();
    }
  };

  upright.addEventListener("change", check);
  check();
}

/** The gallery (?gallery=1; SPEC_dopa v3 §9.3, Q-21): buttons for the sound effects, the five
 * explosion tiers and the bomb at six of its levels, and one that hides or shows the list, for
 * the owner to judge. Not a part of reading. */
function showGallery() {
  const panel = document.createElement("div");
  Object.assign(panel, { id: "gallery" });
  panel.style.cssText =
    "position:fixed;right:8px;bottom:8px;z-index:60;background:#0b1a16;border:2px solid #3fe0a0;padding:8px;max-width:420px;font-size:14px;display:flex;flex-wrap:wrap;gap:4px";

  const addButton = (text, action) => {
    const button = document.createElement("button");
    Object.assign(button, {
      textContent: text,
      onclick: () => {
        unlockAudio();
        return action();
      },
    });
    panel.append(button);
  };

  for (const role of [
    "launch",
    "hit",
    "miss",
    "siren",
    "sting",
    "boom_s",
    "boom_m",
    "boom_l",
    "boom_xl",
    "boom_max",
    "fanfare",
    "tally",
    "levelup",
    "boss_hit",
    "boss_fall",
    "lever",
  ]) {
    addButton(`音 ${role}`, () => sound.play(role));
  }

  ["小", "中", "大", "特大", "最大"].forEach((name, index) => {
    addButton(`爆発 ${name}`, () => {
      $("list").hidden = true;

      const levelOfTier = 1 + 2 * index;
      cockpit.gallery.blast(levelOfTier);
    });
  });

  [0, 1, 3, 5, 7, 9].forEach((level) => {
    // the counts are the first count of each level, 0 to 9 (levelStart in levels.js)
    addButton(`爆弾 Lv${level}`, () => {
      const firstCounts = [0, 1, 5, 8, 13, 21, 33, 53, 84, 135];
      return cockpit.gallery.count(firstCounts[level]);
    });
  });

  addButton("一覧を隠す", () => {
    const hidden = !$("list").hidden;
    $("list").hidden = hidden;
    return hidden;
  });

  document.body.append(panel);
}

// for checks
globalThis.ddr = {
  reader: () => reader.debug(),
  cockpit: () => cockpit.debug(),
  sing: () => sing.condition(),
};

boot();
